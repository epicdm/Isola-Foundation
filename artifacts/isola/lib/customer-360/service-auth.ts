/**
 * Server-to-server authentication for the Customer 360 read surface.
 *
 * The portal's Django calls Foundation server-to-server. It has no Foundation
 * session cookie, and every isola-360 route until now authenticated by cookie
 * alone — so there was no door for it at all. This is that door.
 *
 * PER-TENANT, AND UNREACHABLE BY CONSTRUCTION
 * -------------------------------------------
 * The ruling (2026-08-29) is that a service token scopes to its OWN tenant and
 * that "one key over all tenants" must be impossible to express, not merely
 * refused. A refusal is a check someone can later remove, reorder, or fail to
 * reach; construction is not.
 *
 * So the construction is the signature itself:
 *
 *     resolveServiceCaller(authorizationHeader, env)
 *
 * It receives the Authorization header and the environment. It does NOT receive
 * the request, the body, the URL or the params — so there is no channel through
 * which a caller-supplied tenant could arrive, and no future edit inside this
 * function can invent one, because the value is not in scope. The tenant is read
 * from `ISOLA_360_SERVICE_TENANT_ID`, which is deployment configuration.
 *
 * That is a stronger claim than "we ignore the tenant field", and it is the
 * claim the tests below actually verify: not that a supplied tenant is refused,
 * but that there is nowhere to supply one.
 *
 * THE HOUSE PATTERN, FOLLOWED
 * ---------------------------
 * Copied from `app/api/agent-tools/invoke/route.ts` and
 * `app/api/internal/voicemail-poll/route.ts`, which already do this:
 *   · `Authorization: Bearer <token>`
 *   · a kill-switch env var, default OFF
 *   · AN UNCONFIGURED TOKEN NEVER AUTHENTICATES — the single most important
 *     line in both, because the failure it prevents is a deploy that forgets
 *     the secret and thereby accepts `Bearer ` from anyone.
 *   · a timing-safe comparison
 *
 * One deliberate improvement over the house implementation, stated so it is
 * reviewable rather than smuggled: both existing routes compare with a
 * hand-rolled loop that returns early when the lengths differ, which leaks the
 * secret's LENGTH through timing. Here both sides are SHA-256 digested first,
 * so the comparison is always over 32 equal bytes and no length is observable.
 * Same four named properties, one fewer side channel.
 *
 * WHY THE REFUSAL REASON MUST NOT REACH THE CALLER
 * ------------------------------------------------
 * `reason` exists for tests and for server-side logging. A route MUST collapse
 * every refusal into one wording. "Disabled" vs "wrong token" tells an
 * unauthenticated caller whether they found a live surface with the wrong key
 * or a dead one — which is the only thing they wanted to know.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Exactly the three variables this door reads. Nothing else is consulted. */
export interface ServiceAuthEnv {
  /** `ISOLA_360_SERVICE_ENABLED` — the kill-switch. Only "true" enables. */
  enabled: string | undefined
  /** `ISOLA_360_SERVICE_TOKEN` — the shared secret. */
  token: string | undefined
  /** `ISOLA_360_SERVICE_TENANT_ID` — the ONE tenant this token may read. */
  tenantId: string | undefined
}

export type ServiceAuthRefusal =
  /** The kill-switch is not "true". */
  | 'disabled'
  /** The token or its tenant binding is missing — fail closed, never open. */
  | 'not-configured'
  /** No `Authorization: Bearer <x>` header. */
  | 'no-bearer'
  /** A bearer was presented and it is not the configured token. */
  | 'mismatch'

export type ServiceAuthResult =
  | { ok: true; tenantId: string }
  | { ok: false; reason: ServiceAuthRefusal }

/** Read the three variables off a process env without the route knowing them. */
export function serviceAuthEnvFrom(env: NodeJS.ProcessEnv): ServiceAuthEnv {
  return {
    enabled: env.ISOLA_360_SERVICE_ENABLED,
    token: env.ISOLA_360_SERVICE_TOKEN,
    tenantId: env.ISOLA_360_SERVICE_TENANT_ID,
  }
}

/** Digest-then-compare: constant time, and over a fixed 32 bytes either way. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** The bearer token from an Authorization header, or null. */
export function bearerFrom(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? '').trim())
  if (!match) return null
  const token = match[1].trim()
  return token.length > 0 ? token : null
}

/**
 * Authenticate a service caller and resolve THE tenant it is scoped to.
 *
 * Note what is absent from the parameter list: the request, the body, the path.
 * A tenant cannot be asserted here because a tenant cannot be passed here.
 */
export function resolveServiceCaller(
  authorization: string | null | undefined,
  env: ServiceAuthEnv,
): ServiceAuthResult {
  // Kill-switch first: a disabled surface does no comparison at all, so a
  // disabled deployment cannot be probed for a token's validity.
  if (env.enabled !== 'true') return { ok: false, reason: 'disabled' }

  const expected = (env.token ?? '').trim()
  const tenantId = (env.tenantId ?? '').trim()
  // An unconfigured token NEVER authenticates. Without this, an empty expected
  // value plus an empty presented value is a match, and a deploy that forgot
  // the secret becomes a deploy that accepts everyone.
  if (!expected || !tenantId) return { ok: false, reason: 'not-configured' }

  const presented = bearerFrom(authorization)
  if (!presented) return { ok: false, reason: 'no-bearer' }

  if (!secretsMatch(presented, expected)) return { ok: false, reason: 'mismatch' }

  // The tenant is configuration. It was never in the request.
  return { ok: true, tenantId }
}
