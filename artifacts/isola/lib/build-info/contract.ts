/**
 * build-info/contract.ts — the public build-identity contract for Foundation.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * On 2026-08-06 a Replit publish of Foundation succeeded, minted a new Next.js
 * build, changed every content-hashed chunk name and the root HTML hash — and
 * still served pre-CB-0 behaviour. The build was genuine; the SOURCE SNAPSHOT it
 * compiled preceded the verified synchronisation to the accepted CB-0 source.
 * `dec-cb0-build-identity-six-hostname-corrected-release-2026-08-06`.
 *
 * The release lane had no way to see that, because the only observable signals
 * were public HTML and static chunk names, and a Next production build mints new
 * ones on every run even when the source is byte-identical. A changed hash proves
 * a build RAN. It proves nothing about WHAT was compiled.
 *
 * So the artifact has to carry its own source identity, generated from the
 * snapshot that `next build` actually compiles, and compiled INTO the server —
 * not read from a runtime environment variable that can drift independently of
 * the code beside it.
 *
 * ── What this module is ────────────────────────────────────────────────────
 *
 * Pure, total functions over values. No git, no filesystem, no process, no clock.
 * `scripts/generate-build-info.mjs` produces the value; `app/api/health/route.ts`
 * projects it; both delegate every judgement here so the failure modes can be
 * tested without a repository, a build, or a network.
 *
 * ── What is deliberately NOT in the public projection ──────────────────────
 *
 * Build identity is public deployment provenance. It is not tenant context, not
 * identity, not configuration. Nothing here reads a request, a header, a cookie,
 * a session or an environment secret, and `projectPublicBuildInfo` constructs its
 * result field-by-field from a fixed literal rather than spreading its input — so
 * a field added upstream cannot leak through by accident.
 */

/** Contract version. Bump only on a breaking shape change; the gate asserts it. */
export const BUILD_INFO_SCHEMA = 1

/** Forty lowercase hex characters. Nothing shorter is a git object identity. */
export const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * ISO-8601 instant, UTC, second or millisecond precision. Local offsets are
 * rejected: a provenance timestamp that needs a timezone table to compare is not
 * a provenance timestamp.
 */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

/**
 * A literal placeholder is more dangerous than a missing field, because it looks
 * like an answer. Named explicitly so the failure says so.
 */
export const UNKNOWN_SENTINELS: readonly string[] = ['unknown', 'UNKNOWN', 'null', 'undefined', '']

export type BuildInfoMode = 'production' | 'development'

/** The generated value. `lib/build-info/generated.ts` is the only producer. */
export interface BuildInfo {
  schema: number
  mode: BuildInfoMode
  /** `git rev-parse HEAD` of the compiled snapshot. */
  source_sha: string | null
  /** `git rev-parse HEAD^{tree}` of the compiled snapshot. */
  source_tree: string | null
  /** True when tracked files differed from HEAD at generation time. */
  source_dirty: boolean
  /** Generation instant, ISO-8601 UTC. */
  built_at: string | null
}

/** Exactly what `/api/health` publishes on a healthy production artifact. */
export interface PublicBuildInfo {
  schema: number
  mode: 'production'
  source_sha: string
  source_tree: string
  source_dirty: boolean
  built_at: string
}

export type BuildIdentityFailure =
  | 'build_identity_missing'
  | 'build_identity_unknown'
  | 'build_identity_malformed'
  | 'build_identity_development'
  | 'build_identity_schema_unsupported'

export type BuildIdentityVerdict =
  | { ok: true; info: PublicBuildInfo }
  | { ok: false; reason: BuildIdentityFailure }

function isUnknownSentinel(value: unknown): boolean {
  return typeof value === 'string' && UNKNOWN_SENTINELS.includes(value.trim())
}

/**
 * Decide whether a candidate build-info value is a usable production identity.
 *
 * Ordering matters and is deliberate: an explicit `unknown` placeholder is
 * reported as `build_identity_unknown` rather than folded into "malformed", so a
 * release operator can tell "the generator wrote a placeholder" apart from "the
 * file was corrupted or hand-edited".
 */
export function evaluateBuildIdentity(candidate: unknown): BuildIdentityVerdict {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { ok: false, reason: 'build_identity_missing' }
  }
  const c = candidate as Record<string, unknown>

  if (c.schema !== BUILD_INFO_SCHEMA) {
    return { ok: false, reason: 'build_identity_schema_unsupported' }
  }
  if (c.mode === 'development') {
    return { ok: false, reason: 'build_identity_development' }
  }
  if (c.mode !== 'production') {
    return { ok: false, reason: 'build_identity_malformed' }
  }
  if (c.source_sha === null || c.source_sha === undefined || c.source_tree === null || c.source_tree === undefined) {
    return { ok: false, reason: 'build_identity_missing' }
  }
  if (isUnknownSentinel(c.source_sha) || isUnknownSentinel(c.source_tree) || isUnknownSentinel(c.built_at)) {
    return { ok: false, reason: 'build_identity_unknown' }
  }
  if (typeof c.source_sha !== 'string' || !FULL_SHA.test(c.source_sha)) {
    return { ok: false, reason: 'build_identity_malformed' }
  }
  if (typeof c.source_tree !== 'string' || !FULL_SHA.test(c.source_tree)) {
    return { ok: false, reason: 'build_identity_malformed' }
  }
  if (typeof c.built_at !== 'string' || !ISO_INSTANT.test(c.built_at)) {
    return { ok: false, reason: 'build_identity_malformed' }
  }
  if (typeof c.source_dirty !== 'boolean') {
    return { ok: false, reason: 'build_identity_malformed' }
  }

  return { ok: true, info: projectPublicBuildInfo(c) }
}

/**
 * Build the public projection field-by-field from a fixed literal.
 *
 * Never spread the input. CB-0 is the whole reason this codebase projects rather
 * than spreads: a field added to an internal shape upstream must not become a
 * field on a public response by default.
 */
export function projectPublicBuildInfo(c: Record<string, unknown>): PublicBuildInfo {
  return {
    schema: BUILD_INFO_SCHEMA,
    mode: 'production',
    source_sha: c.source_sha as string,
    source_tree: c.source_tree as string,
    source_dirty: c.source_dirty as boolean,
    built_at: c.built_at as string,
  }
}

export interface HealthResponse {
  status: number
  body:
    | { status: 'ok'; build: PublicBuildInfo }
    | { status: 'ok'; build: { schema: number; mode: 'development' } }
    | { status: 'error'; build: { schema: number; error: BuildIdentityFailure } }
}

/**
 * The whole of `/api/health`'s decision, as a function of the compiled build
 * info and whether this is a production runtime. Takes no request, by design:
 * there is no input a caller could supply that should change the answer.
 *
 * Production with an unusable identity returns 503 and an error reason — never a
 * successful provenance contract with an unknown source. Development returns 200
 * with an explicitly labelled development block, which the post-publish gate
 * rejects, so the dev fallback cannot be mistaken for a release.
 *
 * `/api/healthz` — the Autoscale startup probe declared in
 * `.replit-artifact/artifact.toml` — is a different route and is untouched, so a
 * failed identity check surfaces the fault without preventing the container from
 * booting and being diagnosable.
 */
export function buildHealthResponse(candidate: unknown, opts: { isProduction: boolean }): HealthResponse {
  const verdict = evaluateBuildIdentity(candidate)

  if (verdict.ok) {
    return { status: 200, body: { status: 'ok', build: verdict.info } }
  }

  if (!opts.isProduction && verdict.reason === 'build_identity_development') {
    return { status: 200, body: { status: 'ok', build: { schema: BUILD_INFO_SCHEMA, mode: 'development' } } }
  }

  return { status: 503, body: { status: 'error', build: { schema: BUILD_INFO_SCHEMA, error: verdict.reason } } }
}
