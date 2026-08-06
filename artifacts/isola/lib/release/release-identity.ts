/**
 * release-identity.ts — after a publish, prove the thing that is now serving is
 * the thing that was reviewed.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `publish-gate.ts` asserts the workspace BEFORE a publish. It cannot say
 * anything about what Replit then compiled. On 2026-08-06 that gap was the whole
 * failure: the pre-publish state was correct, the build succeeded, every public
 * hash changed, and the promoted artifact was compiled from an earlier snapshot.
 * `dec-cb0-build-identity-six-hostname-corrected-release-2026-08-06`.
 *
 * So this module reads the identity the artifact reports about ITSELF at
 * `/api/health` and compares it to the owner-authorised source.
 *
 * ── Why the TREE is the assertion ──────────────────────────────────────────
 *
 * Replit mints an empty deploy-marker commit at publish time, so the SHA the
 * build sees is the marker, not the reviewed commit — while the marker's tree is
 * identical to the reviewed commit's tree. `dec-foundation-active-release-line-2026-08-06`:
 * marker commits are not authoritative source identities; resolve marker tree
 * ancestry to an accepted source SHA. The tree is therefore required and the SHA
 * optional; supplying `--expect-sha` tightens the check for releases published
 * from a workspace whose HEAD is known to be the reviewed commit itself.
 *
 * The owner computes the expected tree with:
 *   git rev-parse <REVIEWED_SHA>^{tree}
 *
 * ── This module is pure ────────────────────────────────────────────────────
 *
 * No network, no clock, no process. `scripts/verify-release-identity.ts` performs
 * the requests and does nothing else. Nothing here formats a response header, a
 * cookie, a token or an environment value: the only things that reach the report
 * are the hostname, the HTTP status, and the four public build fields.
 */

import { BUILD_INFO_SCHEMA, FULL_SHA, ISO_INSTANT } from '@/lib/build-info/contract'

/**
 * Every hostname currently routed to the single Foundation Autoscale deployment.
 * All six are inside CB-0 containment scope: deployment equivalence does not
 * excuse an unsafe or unidentified response on any of them.
 */
export const FOUNDATION_ROUTED_HOSTS: readonly string[] = [
  'test.epic.dm',
  'app.isola.epic.dm',
  'isola.epic.dm',
  'ema.epic.dm',
  'staging.isola.epic.dm',
  'isola-foundation.replit.app',
]

export const HEALTH_PATH = '/api/health'

/** What the runner observed. Deliberately not a Response — no headers cross here. */
export type HostProbe =
  | { kind: 'transport_error'; detail: string }
  | { kind: 'response'; status: number; bodyText: string; redirectedTo?: string }

export type HostVerdictKind =
  | 'ok'
  | 'transport_failure'
  | 'http_error'
  | 'malformed_body'
  | 'unhealthy'
  | 'identity_missing'
  | 'identity_unknown'
  | 'identity_malformed'
  | 'identity_development'
  | 'identity_mismatch'

export interface HostVerdict {
  host: string
  kind: HostVerdictKind
  detail: string
  /** Present only when the artifact reported a well-formed production identity. */
  sourceSha?: string
  sourceTree?: string
  sourceDirty?: boolean
  builtAt?: string
  redirectedTo?: string
}

export interface ExpectedIdentity {
  /** Required. `git rev-parse <REVIEWED_SHA>^{tree}`. */
  sourceTree: string
  /** Optional. Omit when the publish is expected to carry a deploy-marker HEAD. */
  sourceSha?: string
  /** A release must never be published from a dirty worktree. */
  allowDirty?: boolean
}

/**
 * A redirect is followed at most once, and only when the destination is another
 * hostname already inside the routed set, over https, on the same path.
 *
 * A branded Foundation host that answers a health probe by bouncing to a
 * different path, a different scheme or an unknown host is not a host we are
 * willing to describe as verified — the point of the check is to learn what THAT
 * hostname serves.
 */
export function resolveRedirect(fromHost: string, location: string | null | undefined): { follow: true; url: string } | { follow: false; why: string } {
  if (!location) return { follow: false, why: 'redirect with no Location' }
  let url: URL
  try {
    url = new URL(location, `https://${fromHost}${HEALTH_PATH}`)
  } catch {
    return { follow: false, why: 'redirect Location is not a URL' }
  }
  if (url.protocol !== 'https:') return { follow: false, why: `redirect to non-https ${url.protocol}` }
  if (url.pathname !== HEALTH_PATH) return { follow: false, why: `redirect changes path to ${url.pathname}` }
  if (!FOUNDATION_ROUTED_HOSTS.includes(url.hostname)) return { follow: false, why: `redirect to unrouted host ${url.hostname}` }
  return { follow: true, url: url.toString() }
}

function isUnknownish(v: unknown): boolean {
  return typeof v === 'string' && ['unknown', 'UNKNOWN', 'null', 'undefined', ''].includes(v.trim())
}

/** Judge one hostname's probe against the authorised identity. */
export function evaluateHost(host: string, probe: HostProbe, expected: ExpectedIdentity): HostVerdict {
  if (probe.kind === 'transport_error') {
    return { host, kind: 'transport_failure', detail: probe.detail }
  }

  const base = probe.redirectedTo ? { redirectedTo: probe.redirectedTo } : {}

  let body: unknown
  try {
    body = JSON.parse(probe.bodyText)
  } catch {
    return { host, kind: 'malformed_body', detail: `HTTP ${probe.status}: response is not JSON`, ...base }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { host, kind: 'malformed_body', detail: `HTTP ${probe.status}: response is not a JSON object`, ...base }
  }
  const b = body as Record<string, unknown>

  if (probe.status !== 200) {
    const reported = b.build && typeof b.build === 'object' ? (b.build as Record<string, unknown>).error : undefined
    return {
      host,
      kind: 'unhealthy',
      detail: `HTTP ${probe.status}${typeof reported === 'string' ? ` build.error=${reported}` : ''}`,
      ...base,
    }
  }
  if (b.status !== 'ok') {
    return { host, kind: 'unhealthy', detail: `status=${JSON.stringify(b.status)}`, ...base }
  }

  const build = b.build
  if (typeof build !== 'object' || build === null || Array.isArray(build)) {
    return { host, kind: 'identity_missing', detail: 'no build block — this artifact predates the build-identity contract', ...base }
  }
  const bi = build as Record<string, unknown>

  if (bi.schema !== BUILD_INFO_SCHEMA) {
    return { host, kind: 'identity_malformed', detail: `build.schema=${JSON.stringify(bi.schema)}, expected ${BUILD_INFO_SCHEMA}`, ...base }
  }
  if (bi.mode === 'development') {
    return { host, kind: 'identity_development', detail: 'artifact reports a DEVELOPMENT build identity', ...base }
  }
  if (isUnknownish(bi.source_sha) || isUnknownish(bi.source_tree) || isUnknownish(bi.built_at)) {
    return { host, kind: 'identity_unknown', detail: 'build identity is an unknown placeholder', ...base }
  }
  if (bi.source_sha === undefined || bi.source_tree === undefined || bi.source_sha === null || bi.source_tree === null) {
    return { host, kind: 'identity_missing', detail: 'build block carries no source identity', ...base }
  }
  if (typeof bi.source_sha !== 'string' || !FULL_SHA.test(bi.source_sha)) {
    return { host, kind: 'identity_malformed', detail: 'build.source_sha is not a full 40-char SHA', ...base }
  }
  if (typeof bi.source_tree !== 'string' || !FULL_SHA.test(bi.source_tree)) {
    return { host, kind: 'identity_malformed', detail: 'build.source_tree is not a full 40-char SHA', ...base }
  }
  if (typeof bi.built_at !== 'string' || !ISO_INSTANT.test(bi.built_at)) {
    return { host, kind: 'identity_malformed', detail: 'build.built_at is not an ISO-8601 UTC instant', ...base }
  }
  if (typeof bi.source_dirty !== 'boolean') {
    return { host, kind: 'identity_malformed', detail: 'build.source_dirty is not a boolean', ...base }
  }

  const observed = {
    sourceSha: bi.source_sha,
    sourceTree: bi.source_tree,
    sourceDirty: bi.source_dirty,
    builtAt: bi.built_at,
    ...base,
  }

  if (bi.source_tree !== expected.sourceTree) {
    return {
      host,
      kind: 'identity_mismatch',
      detail: `serving source_tree ${bi.source_tree}, authorised ${expected.sourceTree}`,
      ...observed,
    }
  }
  if (expected.sourceSha !== undefined && bi.source_sha !== expected.sourceSha) {
    return {
      host,
      kind: 'identity_mismatch',
      detail: `serving source_sha ${bi.source_sha}, authorised ${expected.sourceSha}`,
      ...observed,
    }
  }
  if (bi.source_dirty === true && expected.allowDirty !== true) {
    return {
      host,
      kind: 'identity_mismatch',
      detail: 'serving artifact was built from a DIRTY worktree — its tree identity does not describe what was compiled',
      ...observed,
    }
  }

  return { host, kind: 'ok', detail: 'source identity matches the authorised release', ...observed }
}

export interface ReleaseIdentityResult {
  pass: boolean
  verdicts: HostVerdict[]
  /** Distinct source_tree values observed across hosts, when more than one. */
  divergentTrees: string[]
  lines: string[]
}

/**
 * Judge the whole release.
 *
 * Divergence is checked separately from matching: six hostnames that all report
 * the SAME wrong tree is one failure to reason about, while six hostnames
 * reporting different trees means the deployment is not what everyone believes
 * it is, and that distinction is the difference between a re-publish and an
 * incident.
 */
export function evaluateRelease(verdicts: HostVerdict[], expected: ExpectedIdentity): ReleaseIdentityResult {
  const trees = [...new Set(verdicts.map((v) => v.sourceTree).filter((t): t is string => typeof t === 'string'))]
  const divergentTrees = trees.length > 1 ? trees : []

  const expectedIsFullSha = FULL_SHA.test(expected.sourceTree)
  const allOk = verdicts.length > 0 && verdicts.every((v) => v.kind === 'ok')
  const pass = expectedIsFullSha && allOk && divergentTrees.length === 0

  const lines: string[] = [
    '── Foundation release identity ───────────────────────────',
    `authorised tree   ${expected.sourceTree}${expectedIsFullSha ? '' : '  (NOT A FULL 40-CHAR TREE SHA)'}`,
    `authorised sha    ${expected.sourceSha ?? '(not asserted — deploy-marker HEAD expected)'}`,
    `hosts checked     ${verdicts.length}`,
  ]
  for (const v of verdicts) {
    const id = v.sourceTree ? ` tree=${v.sourceTree.slice(0, 12)} sha=${(v.sourceSha ?? '').slice(0, 12)}` : ''
    const via = v.redirectedTo ? ` via=${v.redirectedTo}` : ''
    lines.push(`  ${v.kind === 'ok' ? 'ok  ' : 'FAIL'} ${v.host}${id}${via} — ${v.detail}`)
  }
  if (divergentTrees.length > 0) {
    lines.push(`  FAIL deployment divergence: hosts report ${divergentTrees.length} different source trees`)
  }
  if (!expectedIsFullSha) {
    lines.push('  FAIL the authorised tree must be 40 hex characters — a prefix is not an identity')
  }
  lines.push(`RELEASE_IDENTITY=${pass ? 'PASS' : 'FAIL'}`)

  return { pass, verdicts, divergentTrees, lines }
}
