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

/**
 * Exactly three things this door reads: the kill-switch, the tenant binding, and
 * the set of accepted secrets. Nothing else is consulted.
 *
 * ONE TENANT, SEVERAL CALLERS
 * ---------------------------
 * `tokens` is a SET because more than one deployment legitimately calls this
 * surface for the same tenant — production and staging both do. It is NOT a
 * widening of the ruling above: every accepted secret still resolves to the one
 * `ISOLA_360_SERVICE_TENANT_ID`, and the tenant is still absent from the
 * signature, so it still cannot be asserted by a caller. A set of tokens is a
 * set of CALLERS, never a set of tenants.
 *
 * Measured 2026-09-07, and the reason this is a set rather than a copied value:
 * production already holds its own distinct 44-character token, and Foundation
 * had simply never been told about it. Giving production staging's value instead
 * would have made the two ONE principal, and staging's access could then never
 * be revoked without taking production down with it.
 */
export interface ServiceAuthEnv {
  /** `ISOLA_360_SERVICE_ENABLED` — the kill-switch. Only "true" enables. */
  enabled: string | undefined
  /**
   * Every accepted shared secret, already enumerated. Each entry is one caller's
   * own credential, independently creatable and independently revocable — that
   * separability is the whole point of the set.
   */
  tokens: readonly string[]
  /** `ISOLA_360_SERVICE_TENANT_ID` — the ONE tenant these tokens may read. */
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

/**
 * The env names that hold an accepted secret: `ISOLA_360_SERVICE_TOKEN`, and any
 * `ISOLA_360_SERVICE_TOKEN_<LABEL>` where LABEL names the caller — `_PROD`,
 * `_STAGING`. The label is deployment vocabulary and carries no authority; it
 * exists so each caller's credential is a separate variable (and therefore a
 * separate swarm secret) that can be added or deleted on its own.
 *
 * The rule is a closed one, stated here and nowhere else: this prefix, that
 * shape. `ISOLA_360_SERVICE_TENANT_ID` does not match it, and neither does any
 * plural or near-miss spelling, because `TOKEN` must be followed by `_`.
 *
 * DELIBERATELY CASE-SENSITIVE, and the reason is not style. Review raised that
 * a Windows `process.env` is case-insensitive, so a variable set as
 * `isola_360_service_token_prod` could surface in `Object.keys` lowercased and
 * be missed here. That is true, and the fix — uppercase the key before testing
 * — is worse: on Linux, which is the only platform this ever deploys to, a
 * lowercase name is a genuinely DIFFERENT variable, and folding case would
 * start collecting it as a credential. So the choice is between failing CLOSED
 * on a developer's Windows box and WIDENING the credential surface in
 * production. Taken knowingly: closed on Windows.
 */
const LABELLED_TOKEN_ENV = /^ISOLA_360_SERVICE_TOKEN_[A-Z0-9]+(?:_[A-Z0-9]+)*$/

/**
 * Enumerate every accepted secret. Exported because the operator-facing env
 * readout in `lib/engines.ts` MUST answer "is this configured?" from the same
 * enumeration the door uses — otherwise the screen can say "not configured"
 * about a credential that in fact authenticates, or the reverse.
 *
 * Blank and whitespace-only entries are dropped here, so a secret file that
 * exists but is empty cannot quietly become an accepted empty token.
 */
export function serviceTokensFrom(env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>()
  for (const key of Object.keys(env).sort()) {
    if (key !== 'ISOLA_360_SERVICE_TOKEN' && !LABELLED_TOKEN_ENV.test(key)) continue
    const value = (env[key] ?? '').trim()
    if (value.length > 0) found.add(value)
  }
  return [...found]
}

/** Read what this door needs off a process env, without the route knowing them. */
export function serviceAuthEnvFrom(env: NodeJS.ProcessEnv): ServiceAuthEnv {
  return {
    enabled: env.ISOLA_360_SERVICE_ENABLED,
    tokens: serviceTokensFrom(env),
    tenantId: env.ISOLA_360_SERVICE_TENANT_ID,
  }
}

/**
 * Digest-then-compare against every accepted secret: constant time, and over a
 * fixed 32 bytes either way.
 *
 * There is deliberately NO early exit on the first match. An early exit would
 * make the elapsed time depend on WHICH credential was presented — so a caller
 * holding a valid token could learn its position in the set, and a caller
 * holding none could learn the set's shape by comparing timings. Comparing all
 * of them always leaks only the SET SIZE, which is not a secret.
 */
function secretsMatchAny(presented: string, expected: readonly string[]): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  let matched = false
  for (const candidate of expected) {
    const b = createHash('sha256').update(candidate, 'utf8').digest()
    if (timingSafeEqual(a, b)) matched = true
  }
  return matched
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

  const expected = env.tokens.map((t) => t.trim()).filter((t) => t.length > 0)
  const tenantId = (env.tenantId ?? '').trim()
  // An unconfigured token NEVER authenticates. Without this, an empty expected
  // value plus an empty presented value is a match, and a deploy that forgot
  // the secret becomes a deploy that accepts everyone. An EMPTY SET is the same
  // failure wearing the new shape, so it fails at the same line — and the trim
  // above means a set of nothing but blanks is an empty set, not a set of one.
  if (expected.length === 0 || !tenantId) return { ok: false, reason: 'not-configured' }

  const presented = bearerFrom(authorization)
  if (!presented) return { ok: false, reason: 'no-bearer' }

  if (!secretsMatchAny(presented, expected)) return { ok: false, reason: 'mismatch' }

  // The tenant is configuration. It was never in the request.
  return { ok: true, tenantId }
}
