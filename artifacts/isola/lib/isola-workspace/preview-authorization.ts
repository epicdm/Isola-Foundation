/**
 * Isola Workspace — preview-route authorization.
 *
 * Closes `defect-pr82-preview-route-browser-role-tenant-authority-2026-08-06`.
 *
 * THE BUG THIS FILE FIXES
 * ------------------------
 * `/isola-workspace/preview` used to take `role` and `tenant` straight from the URL query
 * string, defaulting an absent/unknown role to `'manager'`, and never called
 * `resolveWorkspaceAuthz` / `toWorkspaceRole` at all. Any authenticated Foundation user —
 * including one with no real workspace membership — could render the full admin-tier
 * fixture workspace for either fixture tenant by editing the URL.
 *
 * THE FIX
 * -------
 * The route now resolves the actor's REAL workspace role server-side first
 * (`resolveWorkspaceAuthz` -> `toWorkspaceRole`), and a `role` query parameter is honoured
 * ONLY when it narrows that real role for a QA preview — never widens it, never substitutes
 * for it. `narrowPreviewRole` is the single function that enforces this; nothing else in the
 * route is allowed to pick a role.
 *
 * Separately, `tenant`/`scenario` in the URL select which INVENTED fixture dataset is
 * rendered (Chunk 1's EPIC-shaped fixture vs. Marché Créole's). That choice is cosmetic and
 * is never tenant authority — the actor's real tenant membership is what `resolveWorkspaceAuthz`
 * already checked, and a fixture-scenario string can never stand in for it.
 */

import type { WorkspaceRole } from './contracts'
import type { FixtureTenantId } from './adapters/fixture-adapter'

// ── Role narrowing ───────────────────────────────────────────────────────────

const ROLE_RANK: Record<WorkspaceRole, number> = {
  admin: 3, // "owner" in Foundation membership terms — resolveWorkspaceAuthz's 'owner' level.
  manager: 2,
  operator: 1,
}

const KNOWN_WORKSPACE_ROLES: readonly WorkspaceRole[] = ['admin', 'manager', 'operator']

function isKnownWorkspaceRole(v: string): v is WorkspaceRole {
  return (KNOWN_WORKSPACE_ROLES as readonly string[]).includes(v)
}

/**
 * The one place a preview role is chosen. Never widens.
 *
 * `authoritativeRole` is the actor's REAL resolved workspace role (`null` means denied — no
 * membership, or `Membership.role === 'staff'`). `requestedRole` is whatever the `role` query
 * parameter said, already collapsed to a single value by `extractSingleQueryValue` (a
 * duplicated/conflicting parameter must reach this function as `null`, never as an arbitrary
 * pick of one of the conflicting values).
 *
 * A denied actor (`authoritativeRole === null`) has nothing to narrow FROM — every possible
 * requested role would be a widening — so the result is always `null`, regardless of what was
 * asked for. Callers must not reach this function at all for a denied actor except to prove
 * that invariant; the route itself renders the unauthorized experience before ever computing a
 * preview role.
 *
 * An absent, unknown, empty, or conflicting request is never an error on its own: it simply
 * fails to change anything, and the actor's real role is used. Only a well-formed request for a
 * role STRICTLY ABOVE the actor's real role is rejected as a widening attempt — and rejection
 * means "ignored", not "escalate to unauthorized", because the actor legitimately holds their
 * own real role regardless of what they typed in the URL.
 */
export function narrowPreviewRole(authoritativeRole: WorkspaceRole, requestedRole: string | null): WorkspaceRole
export function narrowPreviewRole(authoritativeRole: null, requestedRole: string | null): null
export function narrowPreviewRole(
  authoritativeRole: WorkspaceRole | null,
  requestedRole: string | null,
): WorkspaceRole | null {
  if (!authoritativeRole) return null
  if (requestedRole === null) return authoritativeRole
  if (!isKnownWorkspaceRole(requestedRole)) return authoritativeRole
  if (ROLE_RANK[requestedRole] > ROLE_RANK[authoritativeRole]) return authoritativeRole
  return requestedRole
}

// ── Fixture scenario (never tenant authority) ───────────────────────────────

/**
 * Every renderable fixture scenario. `epic`/`marche` are the two reference TENANTS (different
 * entitlements, different content). `customer-none`/`customer-many` are not tenants at all —
 * they render the `epic` tenant's shell with the Customer module's identity-resolution port
 * forced to the `none`/`many` `CustomerResolution` kind, so those two first-class states (long
 * declared by the type, previously unreachable because the fixture adapter always produced
 * `'one'`) are actually visitable and testable. See `underlyingFixtureTenant` and
 * `customerResolutionOverrideFor` below for the mapping down to what `fixtureTenant`/
 * `createFixturePorts` actually take.
 */
export type PreviewFixtureScenario = FixtureTenantId | 'customer-none' | 'customer-many'

const FIXTURE_SCENARIO_ALLOWLIST: readonly PreviewFixtureScenario[] = [
  'epic',
  'marche',
  'customer-none',
  'customer-many',
]
const DEFAULT_FIXTURE_SCENARIO: PreviewFixtureScenario = 'epic'

function isKnownFixtureScenario(v: string): v is PreviewFixtureScenario {
  return (FIXTURE_SCENARIO_ALLOWLIST as readonly string[]).includes(v)
}

/**
 * Resolve which INVENTED fixture scenario to render. This has no bearing on authorization —
 * the caller must have already established the actor's real workspace role independently.
 *
 * `scenario` is the current parameter name. `legacyTenant` is the old `?tenant=` parameter,
 * kept as a deprecated alias so existing bookmarked preview links keep working; it is
 * validated through the exact same allowlist and carries no special authority of its own.
 * An unrecognized value in either parameter — including a real tenant id, which this
 * allowlist will never contain — falls back to the default scenario rather than being
 * rendered, echoed, or used to look up anything.
 */
export function resolvePreviewFixtureScenario(
  scenario: string | null,
  legacyTenant: string | null,
): PreviewFixtureScenario {
  if (scenario !== null && isKnownFixtureScenario(scenario)) return scenario
  if (scenario === null && legacyTenant !== null && isKnownFixtureScenario(legacyTenant)) {
    return legacyTenant
  }
  return DEFAULT_FIXTURE_SCENARIO
}

/**
 * The fixture TENANT underlying a scenario — what `fixtureTenant()`/`createFixturePorts()`
 * actually key on. The two customer-resolution scenarios ride on `epic`'s tenant identity and
 * entitlements; only the Customer port's resolution kind differs (see
 * `customerResolutionOverrideFor`). Never a real tenant id, by construction: this function's
 * input is already restricted to `PreviewFixtureScenario` by the type system.
 */
export function underlyingFixtureTenant(scenario: PreviewFixtureScenario): FixtureTenantId {
  return scenario === 'customer-none' || scenario === 'customer-many' ? 'epic' : scenario
}

/**
 * Whether a scenario forces a specific `CustomerResolution.kind` on the fixture adapter's
 * Customer port. `undefined` for `epic`/`marche` means "use the fixture's default (`one`)" —
 * this function does not itself carry authority any more than `resolvePreviewFixtureScenario`
 * does; it only selects invented presentation data.
 */
export function customerResolutionOverrideFor(
  scenario: PreviewFixtureScenario,
): 'none' | 'many' | undefined {
  if (scenario === 'customer-none') return 'none'
  if (scenario === 'customer-many') return 'many'
  return undefined
}

// ── Query-parameter hygiene ──────────────────────────────────────────────────

/**
 * Collapse a Next.js `searchParams` value to a single string, or `null`.
 *
 * A repeated query key (`?role=admin&role=operator`) arrives as an array. When every
 * repetition agrees, that is just a duplicated parameter and the single value is used. When
 * they disagree, the request is ambiguous — a duplicated CONFLICTING role parameter must never
 * be resolved by silently picking one of the candidates (which could pick the more powerful
 * one), so this returns `null` and the caller falls back to the authoritative value.
 */
export function extractSingleQueryValue(v: string | string[] | undefined): string | null {
  if (v === undefined) return null
  const values = Array.isArray(v) ? v : [v]
  const unique = new Set(values)
  if (unique.size !== 1) return null
  return values[0]
}

// ── The one route-decision seam ─────────────────────────────────────────────

/** The raw, not-yet-collapsed searchParams values `resolveWorkspacePreviewRequest` reads. */
export interface WorkspacePreviewRawQuery {
  role: string | string[] | undefined
  scenario: string | string[] | undefined
  tenant: string | string[] | undefined
}

export type WorkspacePreviewRequest =
  | { authorized: false }
  | {
      authorized: true
      /** Echoed back so a caller never needs to keep its own reference to narrow from. */
      authoritativeRole: WorkspaceRole
      role: WorkspaceRole
      scenario: PreviewFixtureScenario
    }

/**
 * The single pure decision point for `/isola-workspace/preview`: given the actor's ALREADY
 * server-resolved authoritative role (never anything the browser sent) and the raw query
 * values, decide whether the request is authorized at all and, if so, which role and fixture
 * scenario to render.
 *
 * Deliberately pure — no session read, no database, no rendering, no fixture loading. That is
 * what makes it possible to write a BEHAVIORAL test that proves denied-in, nothing-out: earlier,
 * `page.tsx` inlined this decision directly in a Server Component, and the only test coverage
 * available (`authorization-wiring.test.ts`) could confirm the right function names appeared in
 * the file, but could not prove the unauthorized branch actually short-circuits before a
 * fixture scenario is chosen — a regression that kept the `if` line but broke its body would
 * have shipped silently (`defect-pr82-authorization-wiring-test-control-flow-gap-2026-08-06`).
 * Extracting the decision here means a test can call this function with a denied
 * `authoritativeRole` and assert, on the RETURNED VALUE — not on source text — that no `role`
 * and no `scenario` exist anywhere in the result.
 *
 * `authoritativeRole` is re-validated against the known role vocabulary here (not just checked
 * for truthiness) so that a malformed/unexpected value arriving from a broken future
 * `toWorkspaceRole` fails closed to `{ authorized: false }` rather than being narrowed and
 * echoed into the rendered role. `narrowPreviewRole` itself is untouched — this is an
 * additional, outer guard, not a change to the already-verified narrowing logic.
 */
export function resolveWorkspacePreviewRequest(
  authoritativeRole: WorkspaceRole | null,
  rawQuery: WorkspacePreviewRawQuery,
): WorkspacePreviewRequest {
  if (!authoritativeRole || !isKnownWorkspaceRole(authoritativeRole)) {
    return { authorized: false }
  }

  const role = narrowPreviewRole(authoritativeRole, extractSingleQueryValue(rawQuery.role))
  const scenario = resolvePreviewFixtureScenario(
    extractSingleQueryValue(rawQuery.scenario),
    extractSingleQueryValue(rawQuery.tenant),
  )
  return { authorized: true, authoritativeRole, role, scenario }
}
