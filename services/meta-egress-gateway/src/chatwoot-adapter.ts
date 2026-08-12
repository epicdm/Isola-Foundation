/**
 * The Chatwoot compatibility surface.
 *
 * Chatwoot v4.16.1 speaks Graph. It cannot be taught operation ids without a
 * fork, and a fork is not authorised. So this adapter accepts EXACTLY the request
 * shapes the deployed image emits — enumerated by reading it, not inferred — and
 * maps each to an allowlisted operation with the same scope check, projection
 * and audit as the operation surface.
 *
 * THIS IS NOT A PROXY. An unmatched method, path, version, query key or body
 * field is a 404 or 400, never a forwarded request. The shapes below are the
 * whole contract:
 *
 *   GET    /{v}/{waba}/message_templates              query or header auth
 *   GET    /{v}/{waba}/message_templates?name=…       header auth (CSAT)
 *   POST   /{v}/{waba}/message_templates              header auth (CSAT create)
 *   DELETE /{v}/{waba}/message_templates?name=…       header auth (CSAT delete)
 *   GET    /{v}/{waba}/phone_numbers?fields&limit     query auth (validation)
 *   POST   /{v}/{phone_id}/messages                   header auth (send)
 *   GET    /{v}/{media_id}                            header auth (media meta)
 *
 * Only the two validation reads are ENABLED. The rest are implemented and
 * refused at the gate until their cutover, so enabling one is a reviewed change
 * rather than a configuration accident.
 */

import type { Workload } from './credentials.js';

/**
 * Versions the deployed Chatwoot actually emits. Read from the image:
 *
 *   phone_id_path(version = 'v13.0')          → messages, and media_url
 *   phone_id_path('v24.0')                    → attachment messages
 *   business_account_path → hardcoded 'v14.0' → templates, phone_numbers
 *   CsatTemplateService   → WHATSAPP_API_VERSION, GlobalConfigService default 'v22.0'
 *
 * The CSAT one is admin-configurable in Chatwoot's super-admin UI. If an
 * operator changes it to something outside this list the adapter refuses loudly
 * rather than guessing — which is the correct failure, and is why the mapping is
 * a tested allowlist rather than a permissive regex.
 */
export const ACCEPTED_VERSIONS: readonly string[] = ['v13.0', 'v14.0', 'v22.0', 'v24.0'];

export type AdapterAuth = 'query' | 'header';

export interface AdapterRoute {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Path AFTER the version segment, with {asset} standing for the id. */
  readonly shape: string;
  readonly auth: readonly AdapterAuth[];
  readonly assetKind: 'waba' | 'phone_number' | 'media';
  /** Query keys Chatwoot may send. Anything else is refused. */
  readonly allowedQuery: readonly string[];
  /** Enabled for live production use. */
  readonly enabled: boolean;
  readonly isMutation: boolean;
  readonly rateLimitPerMinute: number;
}

export const ADAPTER_ROUTES: readonly AdapterRoute[] = [
  {
    id: 'cw.templates.list',
    method: 'GET',
    shape: '{asset}/message_templates',
    // sync_templates and validate_provider_config? put the token in the query;
    // CsatTemplateService uses the header for the same path with ?name=.
    auth: ['query', 'header'],
    assetKind: 'waba',
    allowedQuery: ['access_token', 'continuation', 'name', 'limit', 'after', 'fields'],
    enabled: true,
    isMutation: false,
    rateLimitPerMinute: 30,
  },
  {
    id: 'cw.phone_numbers.list',
    method: 'GET',
    shape: '{asset}/phone_numbers',
    auth: ['query', 'header'],
    assetKind: 'waba',
    allowedQuery: ['access_token', 'continuation', 'fields', 'limit', 'after'],
    enabled: true,
    isMutation: false,
    rateLimitPerMinute: 30,
  },
  {
    id: 'cw.media.metadata',
    method: 'GET',
    shape: '{asset}',
    auth: ['header'],
    assetKind: 'media',
    allowedQuery: [],
    // Held: a media id is not in the tenant asset registry, so ownership cannot
    // be proven before the fetch. Enabling it needs a decision about how media
    // ownership is established, not just a flag.
    enabled: false,
    isMutation: false,
    rateLimitPerMinute: 120,
  },
  {
    id: 'cw.messages.send',
    method: 'POST',
    shape: '{asset}/messages',
    auth: ['header'],
    assetKind: 'phone_number',
    allowedQuery: [],
    enabled: false,
    isMutation: true,
    rateLimitPerMinute: 60,
  },
  {
    id: 'cw.templates.create',
    method: 'POST',
    shape: '{asset}/message_templates',
    auth: ['header'],
    assetKind: 'waba',
    allowedQuery: [],
    enabled: false,
    isMutation: true,
    rateLimitPerMinute: 10,
  },
  {
    id: 'cw.templates.delete',
    method: 'DELETE',
    shape: '{asset}/message_templates',
    auth: ['header'],
    assetKind: 'waba',
    allowedQuery: ['name'],
    enabled: false,
    isMutation: true,
    rateLimitPerMinute: 10,
  },
];

export interface MatchedRoute {
  readonly route: AdapterRoute;
  readonly version: string;
  readonly assetId: string;
}

const ID_RE = /^[0-9]{5,25}$/;

/**
 * Match a request path against the adapter contract.
 *
 * Returns null for anything not in the contract, which the caller turns into a
 * 404. Ambiguity is resolved by shape, not by guesswork: `/{v}/{id}` with no
 * sub-path is the media read, `/{v}/{id}/messages` is a send, and so on.
 */
export function matchRoute(method: string, pathAfterPrefix: string): MatchedRoute | null {
  const parts = pathAfterPrefix.replace(/^\/+/, '').split('/');
  const version = parts[0];
  if (!version || !ACCEPTED_VERSIONS.includes(version)) return null;

  const assetId = parts[1];
  if (!assetId || !ID_RE.test(assetId)) return null;

  const tail = parts.slice(2).join('/');
  for (const route of ADAPTER_ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const expectedTail = route.shape.replace('{asset}', '').replace(/^\/+/, '');
    if (tail !== expectedTail) continue;
    return { route, version, assetId };
  }
  return null;
}

export type AuthPresentation =
  | { kind: 'query'; token: string }
  | { kind: 'header'; token: string }
  | { kind: 'continuation'; token: string }
  | { kind: 'none' }
  | { kind: 'conflict' };

/**
 * Determine how the caller presented credentials.
 *
 * Duplicate and conflicting inputs are a refusal, not a preference order: a
 * request carrying both a header bearer and a query token is not a request this
 * contract describes, and picking one would let an attacker probe which.
 */
export function presentedAuth(args: {
  authorization: string | null;
  queryAccessToken: string | string[] | null;
  queryContinuation: string | string[] | null;
}): AuthPresentation {
  const { authorization, queryAccessToken, queryContinuation } = args;

  if (Array.isArray(queryAccessToken) || Array.isArray(queryContinuation)) return { kind: 'conflict' };

  const header = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
  const present = [header, queryAccessToken, queryContinuation].filter((v) => v != null && v !== '');
  if (present.length === 0) return { kind: 'none' };
  if (present.length > 1) return { kind: 'conflict' };

  if (queryContinuation) return { kind: 'continuation', token: String(queryContinuation) };
  if (queryAccessToken) return { kind: 'query', token: String(queryAccessToken) };
  return { kind: 'header', token: header as string };
}

/**
 * Rewrite Meta's paging object so every subsequent page stays inside the
 * gateway. Meta's absolute URLs, its API version and any credential in them are
 * dropped entirely and replaced with a gateway URL carrying a continuation
 * token — never the caller's long-lived workload token.
 */
export function rewritePaging(
  body: unknown,
  make: (metaCursor: string) => string | null,
): unknown {
  if (body === null || typeof body !== 'object') return body;
  const obj = body as Record<string, unknown>;
  const paging = obj['paging'];
  if (paging === null || typeof paging !== 'object') return body;

  const p = paging as Record<string, unknown>;
  const next = typeof p['next'] === 'string' ? (p['next'] as string) : null;

  // Only the opaque `after` cursor survives; the URL itself never does.
  let afterCursor: string | null = null;
  if (next) {
    try {
      afterCursor = new URL(next).searchParams.get('after');
    } catch {
      afterCursor = null;
    }
  }

  const rewritten: Record<string, unknown> = {};
  const gatewayNext = afterCursor ? make(afterCursor) : null;
  if (gatewayNext) rewritten['next'] = gatewayNext;

  // `cursors` carries opaque before/after strings and no URL, so it is safe to
  // keep — Chatwoot does not read it, but dropping data it might later use is a
  // silent behaviour change.
  const cursors = p['cursors'];
  if (cursors && typeof cursors === 'object') rewritten['cursors'] = cursors;

  return { ...obj, paging: rewritten };
}

/** Extract the Meta cursor a continuation refers to, for the upstream call. */
export function upstreamQueryFor(route: AdapterRoute, incoming: URLSearchParams, after: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  // Only the shapes Chatwoot actually sends are forwarded upstream. The caller's
  // credential is never among them: `access_token` is a gateway workload token
  // and must not reach Meta.
  for (const key of ['fields', 'limit', 'name']) {
    if (!route.allowedQuery.includes(key)) continue;
    const v = incoming.get(key);
    if (v != null && v !== '') out[key] = v;
  }
  if (after) out['after'] = after;
  return out;
}
