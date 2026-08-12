/**
 * Request handling.
 *
 * The whole caller-facing surface is:
 *
 *   GET  /healthz                      — liveness, unauthenticated, no secrets
 *   GET  /v1/operations                — the allowlist, for discovery
 *   POST /v1/operations/{operation_id} — perform one allowlisted operation
 *
 * There is no route that accepts a URL, a path, a header set, a query string or
 * a token. That absence is the design.
 */

import { findOperation, operationIds, type Operation } from './operations.js';
import { validateInput, buildPath, project } from './policy.js';
import { authenticate, authenticateSigned, tenantOwnsAsset, withTenantCredential, custodySummary, type Workload } from './credentials.js';
import type { SigningHeaders } from './signing.js';
import { callGraph, describeTarget, graphVersion } from './graph.js';
import { emit, newCorrelationId, type AuditEvent, type AuditOutcome } from './audit.js';

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
  /** Exact bytes received, for the signature digest. */
  readonly rawBody: string;
  readonly signing: SigningHeaders;
  /** Only read by the operator inspection surface. */
  readonly inspectPhoneId?: string;
}
export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Emergency shutdown, in-process. The service-level control is scaling to zero. */
function killSwitchEngaged(): boolean {
  return String(process.env.META_GATEWAY_DISABLED ?? '').toLowerCase() === 'true';
}

// ---- rate limiting: fixed window per tenant+operation --------------------
const windows = new Map<string, { start: number; count: number }>();

function rateLimited(tenantId: string, op: Operation, now: number): boolean {
  const key = `${tenantId}:${op.id}`;
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > op.rateLimitPerMinute;
}

export function __resetRateLimits(): void {
  windows.clear();
}

interface Ctx {
  correlationId: string;
  startedAt: number;
  workload: Workload | null;
  op: Operation | null;
  assetKind: string | null;
  assetId: string | null;
  target: string | null;
}

function finish(ctx: Ctx, outcome: AuditOutcome, status: number, body: unknown, extra?: { upstream?: number; failure?: string }): HttpResponse {
  const event: AuditEvent = {
    event: 'meta.gateway',
    ts: new Date().toISOString(),
    correlation_id: ctx.correlationId,
    workload_id: ctx.workload?.workload_id ?? null,
    tenant_id: ctx.workload?.tenant_id ?? null,
    operation_id: ctx.op?.id ?? null,
    operation_class: ctx.op?.class ?? null,
    asset_kind: ctx.assetKind,
    asset_id: ctx.assetId,
    target: ctx.target,
    method: ctx.op?.method ?? null,
    outcome,
    upstream_status: extra?.upstream ?? null,
    failure: extra?.failure ?? null,
    duration_ms: Date.now() - ctx.startedAt,
    approval_id: null,
  };
  emit(event);
  return { status, body: { ...(body as object), correlation_id: ctx.correlationId } };
}

export async function handle(req: HttpRequest): Promise<HttpResponse> {
  const ctx: Ctx = {
    correlationId: newCorrelationId(),
    startedAt: Date.now(),
    workload: null,
    op: null,
    assetKind: null,
    assetId: null,
    target: null,
  };

  if (req.method === 'GET' && req.path === '/healthz') {
    const c = custodySummary();
    return {
      status: 200,
      body: {
        status: killSwitchEngaged() ? 'disabled' : 'ok',
        graph_version: graphVersion(),
        operations: operationIds().length,
        // Counts and a timestamp. No identities, no values.
        credentials_loaded: c.tenants > 0,
      },
    };
  }

  if (req.method === 'GET' && req.path === '/v1/operations') {
    return { status: 200, body: { operations: operationIds() } };
  }

  /**
   * OPERATOR INSPECTION SURFACE — read-only, bearer-authenticated.
   *
   * A third, deliberately small surface. It exists because neither of the other
   * two could serve an operator verifying a cutover:
   *
   *   - the operation API requires an HMAC signature, and the signing key lives
   *     only inside the Swarm secret, so there is no practical operator path;
   *   - the Chatwoot adapter implements only the Graph shapes Chatwoot emits,
   *     and adding a non-Chatwoot shape there would muddy that contract.
   *
   * Bearer alone is proportionate here and nowhere else: this surface is
   * internal-only (the service publishes no port), every route on it is a
   * metadata READ, and it can express no mutation. It reuses the same tenant and
   * asset scope check, the same server-constructed request, the same projection
   * and the same audit record as everything else.
   *
   * Its purpose is capturing and verifying phone-level webhook ownership before
   * and after a coordinated cutover — the evidence that proves exactly one
   * processor owns an inbound event.
   */
  if (req.method === 'GET' && req.path === '/v1/inspect/phone-webhook-config') {
    const op = findOperation('wa.phone.webhook_config.read');
    if (!op) return { status: 500, body: { error: 'inspection operation is not registered' } };
    ctx.op = op;

    const bearer = req.authorization?.startsWith('Bearer ') ? req.authorization.slice(7).trim() : null;
    const workload = authenticate(bearer);
    if (!workload) return finish(ctx, 'denied_auth', 401, { error: 'unauthenticated' });
    ctx.workload = workload;

    if (killSwitchEngaged()) {
      return finish(ctx, 'denied_kill_switch', 503, { error: 'Meta egress is administratively disabled' });
    }

    const phoneId = typeof req.inspectPhoneId === 'string' ? req.inspectPhoneId : '';
    const validated = validateInput(op, { phone_number_id: phoneId });
    if (!validated.ok) return finish(ctx, 'denied_schema', 400, { error: validated.reason });

    ctx.assetKind = 'phone_number';
    ctx.assetId = phoneId;
    if (!tenantOwnsAsset(workload.tenant_id, 'phone_number', phoneId)) {
      return finish(ctx, 'denied_scope', 403, { error: 'asset is not in scope for this tenant' });
    }
    if (rateLimited(workload.tenant_id, op, Date.now())) {
      return finish(ctx, 'denied_rate', 429, { error: 'rate limit exceeded for this operation' });
    }

    const built = buildPath(op, validated.value);
    if (!built.ok) return finish(ctx, 'denied_schema', 400, { error: built.reason });
    ctx.target = describeTarget(op, built.path);

    let outcome;
    try {
      outcome = await withTenantCredential(workload.tenant_id, (token) => callGraph(op, built.path, token));
    } catch {
      return finish(ctx, 'denied_no_credential', 503, { error: 'no credential is provisioned for this tenant' });
    }
    if (!outcome.ok) {
      return finish(
        ctx,
        'upstream_failed',
        outcome.failure === 'upstream_error' ? 502 : 504,
        { error: 'the upstream request did not succeed', failure: outcome.failure },
        { upstream: outcome.status, failure: outcome.failure },
      );
    }
    const projected = project(outcome.body, op.projection) ?? {};
    return finish(ctx, 'ok', 200, { operation_id: op.id, data: projected }, { upstream: outcome.status });
  }

  if (req.method !== 'POST' || !req.path.startsWith('/v1/operations/')) {
    return { status: 404, body: { error: 'no such route' } };
  }

  // ---- authentication: the caller AND the request -----------------------
  //
  // The operation route is reachable from the public internet through the
  // reverse proxy, because Foundation runs on Replit and cannot join a private
  // overlay. A bearer token proves who is calling; the signature proves THIS
  // call, bound to its body and a moment in time, so a captured request cannot
  // be resent or retargeted.
  const bearer = req.authorization?.startsWith('Bearer ') ? req.authorization.slice(7).trim() : null;
  const authed = authenticateSigned(bearer, {
    method: req.method,
    path: req.path,
    rawBody: req.rawBody,
    headers: req.signing,
    nowMs: Date.now(),
  });
  if (!authed.ok) {
    // One response for every authentication failure. Distinguishing "unknown
    // caller" from "bad signature" from "replayed nonce" tells an attacker
    // which half to work on.
    return finish(ctx, 'denied_auth', 401, { error: 'unauthenticated' }, { failure: authed.failure });
  }
  const workload = authed.workload;
  ctx.workload = workload;

  if (killSwitchEngaged()) {
    return finish(ctx, 'denied_kill_switch', 503, { error: 'Meta egress is administratively disabled' });
  }

  // ---- operation resolution ---------------------------------------------
  const opId = decodeURIComponent(req.path.slice('/v1/operations/'.length));
  const op = findOperation(opId);
  if (!op) {
    return finish(ctx, 'denied_unknown_operation', 404, { error: 'unknown operation' });
  }
  ctx.op = op;

  // ---- input schema ------------------------------------------------------
  const validated = validateInput(op, req.body);
  if (!validated.ok) {
    return finish(ctx, 'denied_schema', 400, { error: validated.reason });
  }

  // ---- tenant + asset scope ---------------------------------------------
  const assetId = validated.value[op.scopeField];
  if (typeof assetId !== 'string') {
    return finish(ctx, 'denied_schema', 400, { error: `operation ${op.id} requires ${op.scopeField}` });
  }
  ctx.assetKind = op.scopeKind;
  ctx.assetId = assetId;

  if (!tenantOwnsAsset(workload.tenant_id, op.scopeKind, assetId)) {
    // The message does not distinguish "not yours" from "does not exist":
    // that difference is itself cross-tenant information.
    return finish(ctx, 'denied_scope', 403, { error: 'asset is not in scope for this tenant' });
  }

  if (op.requiresApproval) {
    // No mutation operation exists in this phase. If one is ever added without
    // an approval check being implemented, it fails closed here rather than
    // executing unapproved.
    return finish(ctx, 'denied_approval', 403, { error: 'this operation requires an approval that is not implemented' });
  }

  if (rateLimited(workload.tenant_id, op, Date.now())) {
    return finish(ctx, 'denied_rate', 429, { error: 'rate limit exceeded for this operation' });
  }

  // ---- server-constructed request ---------------------------------------
  const built = buildPath(op, validated.value);
  if (!built.ok) {
    return finish(ctx, 'denied_schema', 400, { error: built.reason });
  }
  ctx.target = describeTarget(op, built.path);

  let outcome;
  try {
    outcome = await withTenantCredential(workload.tenant_id, (token) => callGraph(op, built.path, token));
  } catch {
    return finish(ctx, 'denied_no_credential', 503, { error: 'no credential is provisioned for this tenant' });
  }

  if (!outcome.ok) {
    return finish(ctx, 'upstream_failed', outcome.failure === 'upstream_error' ? 502 : 504, { error: 'the upstream request did not succeed', failure: outcome.failure }, { upstream: outcome.status, failure: outcome.failure });
  }

  // ---- projection --------------------------------------------------------
  const projected = project(outcome.body, op.projection) ?? {};
  return finish(ctx, 'ok', 200, { operation_id: op.id, data: projected }, { upstream: outcome.status });
}
