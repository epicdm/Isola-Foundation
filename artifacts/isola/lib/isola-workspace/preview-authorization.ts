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

const FIXTURE_SCENARIO_ALLOWLIST: readonly FixtureTenantId[] = ['epic', 'marche']
const DEFAULT_FIXTURE_SCENARIO: FixtureTenantId = 'epic'

function isKnownFixtureScenario(v: string): v is FixtureTenantId {
  return (FIXTURE_SCENARIO_ALLOWLIST as readonly string[]).includes(v)
}

/**
 * Resolve which INVENTED fixture dataset to render. This has no bearing on authorization —
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
): FixtureTenantId {
  if (scenario !== null && isKnownFixtureScenario(scenario)) return scenario
  if (scenario === null && legacyTenant !== null && isKnownFixtureScenario(legacyTenant)) {
    return legacyTenant
  }
  return DEFAULT_FIXTURE_SCENARIO
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
