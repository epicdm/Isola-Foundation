/**
 * Request handling for the Chatwoot compatibility surface.
 *
 * Kept in its own module, with its own authentication, deliberately: the
 * operation surface REFUSES a caller-supplied `access_token`, and this surface
 * must ACCEPT one on two exact routes. Those two rules cannot live in one code
 * path without the refusal becoming conditional, which is how a bounded
 * exception turns into a general one.
 *
 * Nothing here reads or logs a query string beyond the named keys it is
 * contracted to read.
 */

import {
  matchRoute,
  presentedAuth,
  rewritePaging,
  upstreamQueryFor,
  ADAPTER_ROUTES,
  type AdapterRoute,
} from './chatwoot-adapter.js';
import { authenticate, tenantOwnsAsset, withTenantCredential, type Workload } from './credentials.js';
import { callGraphAdapter, describeAdapterTarget } from './graph.js';
import { issue, consume, type ContinuationClaims } from './continuation.js';
import { emit, newCorrelationId, type AuditEvent, type AuditOutcome } from './audit.js';

export const ADAPTER_PREFIX = '/compat/graph';

/** Public base the rewritten paging URL must point at, as Chatwoot will see it. */
function publicBase(): string {
  return (process.env.META_GATEWAY_ADAPTER_PUBLIC_BASE ?? 'http://meta-egress-gateway:3000').replace(/\/+$/, '');
}

function killSwitchEngaged(): boolean {
  return String(process.env.META_GATEWAY_DISABLED ?? '').toLowerCase() === 'true';
}

const windows = new Map<string, { start: number; count: number }>();
function rateLimited(tenantId: string, route: AdapterRoute, now: number): boolean {
  const key = `${tenantId}:${route.id}`;
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > route.rateLimitPerMinute;
}
export function __resetAdapterRateLimits(): void {
  windows.clear();
}

export interface AdapterRequest {
  readonly method: string;
  /** Path INCLUDING the adapter prefix. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | null;
  readonly body: unknown;
}
export interface AdapterResponse {
  readonly status: number;
  readonly body: unknown;
}

interface Ctx {
  correlationId: string;
  startedAt: number;
  workload: Workload | null;
  route: AdapterRoute | null;
  assetId: string | null;
  target: string | null;
}

function finish(ctx: Ctx, outcome: AuditOutcome, status: number, body: unknown, extra?: { upstream?: number; failure?: string }): AdapterResponse {
  const event: AuditEvent = {
    event: 'meta.gateway',
    ts: new Date().toISOString(),
    correlation_id: ctx.correlationId,
    workload_id: ctx.workload?.workload_id ?? null,
    tenant_id: ctx.workload?.tenant_id ?? null,
    operation_id: ctx.route?.id ?? null,
    operation_class: ctx.route ? (ctx.route.isMutation ? 'chatwoot_mutation' : 'chatwoot_read') : null,
    asset_kind: ctx.route?.assetKind ?? null,
    asset_id: ctx.assetId,
    // Path only. The query carries the workload token on two routes and must
    // never reach a log line.
    target: ctx.target,
    method: ctx.route?.method ?? null,
    outcome,
    upstream_status: extra?.upstream ?? null,
    failure: extra?.failure ?? null,
    duration_ms: Date.now() - ctx.startedAt,
    approval_id: null,
  };
  emit(event);
  return { status, body };
}

export async function handleAdapter(req: AdapterRequest): Promise<AdapterResponse> {
  const ctx: Ctx = {
    correlationId: newCorrelationId(),
    startedAt: Date.now(),
    workload: null,
    route: null,
    assetId: null,
    target: null,
  };

  const tail = req.path.slice(ADAPTER_PREFIX.length);

  /**
   * The continuation endpoint.
   *
   * It carries NO version and NO asset in the URL — the signed token holds both.
   * That makes "a cursor cannot be moved to another WABA or operation"
   * structural rather than merely checked: there is nothing in the URL to
   * change. It also satisfies the requirement that no Meta URL, version or
   * credential survives into the pagination object.
   */
  let route: AdapterRoute;
  let assetId: string;
  let continuationClaims: ContinuationClaims | null = null;

  if (tail === '/continue' || tail === '/continue/') {
    if (req.method.toUpperCase() !== 'GET') {
      return finish(ctx, 'denied_unknown_operation', 404, { error: { message: 'Unsupported request' } });
    }
    const raw = req.query.getAll('continuation');
    if (raw.length !== 1 || req.authorization) {
      return finish(ctx, 'denied_auth', 401, { error: { message: 'Unauthenticated' } });
    }
    const c = consume(raw[0]!, Date.now());
    if (!c.ok) {
      return finish(ctx, 'denied_auth', 401, { error: { message: 'Unauthenticated' } }, { failure: c.failure });
    }
    const resolved = ADAPTER_ROUTES.find((r) => r.id === c.claims.op);
    if (!resolved) {
      return finish(ctx, 'denied_unknown_operation', 404, { error: { message: 'Unsupported request' } });
    }
    continuationClaims = c.claims;
    route = resolved;
    assetId = c.claims.a;
    ctx.route = route;
    ctx.assetId = assetId;
    ctx.workload = { workload_id: c.claims.w, tenant_id: c.claims.t, roles: [] };
  } else {
    const matched = matchRoute(req.method, tail);
    if (!matched) {
      return finish(ctx, 'denied_unknown_operation', 404, { error: { message: 'Unsupported request' } });
    }
    route = matched.route;
    assetId = matched.assetId;
    ctx.route = route;
    ctx.assetId = assetId;
  }

  if (killSwitchEngaged()) {
    return finish(ctx, 'denied_kill_switch', 503, { error: { message: 'Meta egress is administratively disabled' } });
  }

  // Query keys are an allowlist. An unexpected key means this is not a request
  // the contract describes, and guessing which part to honour is how a bounded
  // adapter becomes a proxy.
  for (const key of req.query.keys()) {
    if (!route.allowedQuery.includes(key)) {
      return finish(ctx, 'denied_schema', 400, { error: { message: `Unsupported parameter: ${key}` } });
    }
  }

  // ---- authentication ----------------------------------------------------
  let workload: Workload | null = ctx.workload;

  if (!continuationClaims) {
    const presentation = presentedAuth({
      authorization: req.authorization,
      queryAccessToken: req.query.getAll('access_token').length > 1 ? req.query.getAll('access_token') : req.query.get('access_token'),
      // A continuation is only ever valid on /continue. Presenting one on a
      // normal route is a refusal, not a fallback.
      queryContinuation: req.query.getAll('continuation').length > 0 ? req.query.getAll('continuation') : null,
    });

    if (presentation.kind === 'none' || presentation.kind === 'conflict' || presentation.kind === 'continuation') {
      return finish(ctx, 'denied_auth', 401, { error: { message: 'Unauthenticated' } });
    }
    if (presentation.kind === 'query' && !route.auth.includes('query')) {
      return finish(ctx, 'denied_auth', 401, { error: { message: 'Unauthenticated' } });
    }
    if (presentation.kind === 'header' && !route.auth.includes('header')) {
      return finish(ctx, 'denied_auth', 401, { error: { message: 'Unauthenticated' } });
    }

    workload = authenticate(presentation.token);
    if (!workload) return finish(ctx, 'denied_auth', 401, { error: { message: 'Unauthenticated' } });
    ctx.workload = workload;
  }
  if (!workload) return finish(ctx, 'denied_auth', 401, { error: { message: 'Unauthenticated' } });

  // ---- enablement --------------------------------------------------------
  if (!route.enabled) {
    return finish(ctx, 'denied_approval', 403, {
      error: { message: 'This operation is implemented but not enabled for production use' },
    });
  }

  // ---- tenant + asset scope ---------------------------------------------
  if (route.assetKind === 'waba' || route.assetKind === 'phone_number') {
    if (!tenantOwnsAsset(workload.tenant_id, route.assetKind, assetId)) {
      return finish(ctx, 'denied_scope', 403, { error: { message: 'Unauthorized' } });
    }
  } else {
    // Media ownership cannot be proven before the fetch; the route is disabled
    // above, and this is the belt to that brace.
    return finish(ctx, 'denied_scope', 403, { error: { message: 'Unauthorized' } });
  }

  if (rateLimited(workload.tenant_id, route, Date.now())) {
    return finish(ctx, 'denied_rate', 429, { error: { message: 'Rate limit exceeded' } });
  }

  // ---- server-constructed upstream request ------------------------------
  const path = '/' + route.shape.replace('{asset}', assetId);
  ctx.target = describeAdapterTarget(path);
  const query = upstreamQueryFor(route, req.query, continuationClaims?.c ?? null);

  let outcome;
  try {
    outcome = await withTenantCredential(workload.tenant_id, (token) =>
      callGraphAdapter({
        method: route.method,
        path,
        query,
        token,
        timeoutMs: 15_000,
        maxResponseBytes: 1024 * 1024,
      }),
    );
  } catch {
    return finish(ctx, 'denied_no_credential', 503, { error: { message: 'No credential provisioned' } });
  }

  if (!outcome.ok) {
    // Chatwoot reads `error.message` and the HTTP status to decide whether a
    // configuration is valid and what to log. Both are preserved, because
    // replacing them here would silently break validate_provider_config? and
    // the template sync warning path.
    const upstreamBody =
      outcome.body && typeof outcome.body === 'object'
        ? outcome.body
        : { error: { message: `Upstream request failed (${outcome.failure ?? 'unknown'})` } };
    return finish(ctx, 'upstream_failed', outcome.status || 502, upstreamBody, {
      upstream: outcome.status,
      failure: outcome.failure,
    });
  }

  // ---- pagination rewrite ------------------------------------------------
  // Nothing from Meta's URL survives: no host, no version, no cursor in the
  // clear, no credential. The follow-up address carries only a signed token.
  const rewritten = rewritePaging(outcome.body, (metaCursor) =>
    `${publicBase()}${ADAPTER_PREFIX}/continue?continuation=${encodeURIComponent(
      issue({ w: workload.workload_id, t: workload.tenant_id, op: route.id, a: assetId, c: metaCursor }, Date.now()),
    )}`,
  );

  return finish(ctx, 'ok', 200, rewritten, { upstream: outcome.status });
}
