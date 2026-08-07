import { describe, expect, it } from 'vitest'

import type { WorkspaceRole } from './contracts'
import {
  customerResolutionOverrideFor,
  extractSingleQueryValue,
  narrowPreviewRole,
  resolvePreviewFixtureScenario,
  resolveWorkspacePreviewRequest,
  underlyingFixtureTenant,
  type WorkspacePreviewRawQuery,
} from './preview-authorization'

/**
 * The route-level authorization matrix for `/isola-workspace/preview`, expressed against the
 * pure functions the route composes (`preview-authorization.ts`) rather than against the
 * Server Component itself — this repository has no `page.test.tsx` precedent anywhere
 * (`resolveWorkspaceAuthz`, `getSession` and the membership resolver each already carry their
 * own dedicated test coverage; `lib/workspace/authz.test.ts` covers unauthenticated / no
 * membership / malformed authorization results at that layer). What is new here, and was
 * previously untested anywhere, is: does a requested preview role ever WIDEN the actor's real
 * role, and can a fixture-scenario string ever become tenant authority.
 */

describe('narrowPreviewRole — never widens', () => {
  it('a denied actor (no membership / staff) gets null regardless of what is requested', () => {
    expect(narrowPreviewRole(null, null)).toBeNull()
    expect(narrowPreviewRole(null, 'admin')).toBeNull()
    expect(narrowPreviewRole(null, 'manager')).toBeNull()
    expect(narrowPreviewRole(null, 'operator')).toBeNull()
    expect(narrowPreviewRole(null, 'bogus')).toBeNull()
  })

  it('no role query uses the actor\'s real resolved role, never a manager default', () => {
    expect(narrowPreviewRole('admin', null)).toBe('admin')
    expect(narrowPreviewRole('manager', null)).toBe('manager')
  })

  it('owner (admin) may narrow to manager or operator', () => {
    expect(narrowPreviewRole('admin', 'manager')).toBe('manager')
    expect(narrowPreviewRole('admin', 'operator')).toBe('operator')
    expect(narrowPreviewRole('admin', 'admin')).toBe('admin')
  })

  it('manager may narrow to operator, but a request for admin is refused (falls back)', () => {
    expect(narrowPreviewRole('manager', 'operator')).toBe('operator')
    expect(narrowPreviewRole('manager', 'admin')).toBe('manager')
  })

  it('operator requesting manager or admin is refused (falls back)', () => {
    expect(narrowPreviewRole('operator', 'manager')).toBe('operator')
    expect(narrowPreviewRole('operator', 'admin')).toBe('operator')
  })

  it('an unknown role string is ignored, not honoured and not an error', () => {
    expect(narrowPreviewRole('admin', 'superadmin')).toBe('admin')
    expect(narrowPreviewRole('manager', 'root')).toBe('manager')
  })

  it('an empty role string, explicitly supplied, is ignored like an unknown one', () => {
    expect(narrowPreviewRole('admin', '')).toBe('admin')
  })

  it('duplicated conflicting role parameters (pre-collapsed to null by the caller) fall back', () => {
    // extractSingleQueryValue returns null for a conflicting repeated key; narrowPreviewRole
    // treats that exactly like "no query was supplied" — the real role wins.
    expect(narrowPreviewRole('manager', extractSingleQueryValue(['operator', 'admin']))).toBe(
      'manager',
    )
  })

  it('duplicated AGREEING role parameters behave like a single value', () => {
    expect(narrowPreviewRole('admin', extractSingleQueryValue(['operator', 'operator']))).toBe(
      'operator',
    )
  })
})

describe('extractSingleQueryValue', () => {
  it('absent parameter is null', () => {
    expect(extractSingleQueryValue(undefined)).toBeNull()
  })

  it('single value passes through', () => {
    expect(extractSingleQueryValue('operator')).toBe('operator')
  })

  it('repeated identical values collapse to that value', () => {
    expect(extractSingleQueryValue(['manager', 'manager'])).toBe('manager')
  })

  it('repeated conflicting values collapse to null', () => {
    expect(extractSingleQueryValue(['manager', 'admin'])).toBeNull()
  })

  it('empty string is preserved as a value, not treated as absent', () => {
    expect(extractSingleQueryValue('')).toBe('')
  })
})

describe('resolvePreviewFixtureScenario — never tenant authority', () => {
  it('a known scenario is honoured', () => {
    expect(resolvePreviewFixtureScenario('marche', null)).toBe('marche')
    expect(resolvePreviewFixtureScenario('epic', null)).toBe('epic')
  })

  it('an unknown scenario string falls back to the default rather than erroring or leaking', () => {
    expect(resolvePreviewFixtureScenario('not-a-real-scenario', null)).toBe('epic')
  })

  it('a real-looking tenant id is never treated as a valid scenario', () => {
    expect(resolvePreviewFixtureScenario('preview-tenant-epic-shaped', null)).toBe('epic')
    expect(resolvePreviewFixtureScenario('tenant-abc123', null)).toBe('epic')
  })

  it('the deprecated `tenant` alias still works when `scenario` is absent', () => {
    expect(resolvePreviewFixtureScenario(null, 'marche')).toBe('marche')
  })

  it('`scenario` takes precedence over the deprecated `tenant` alias when both are present', () => {
    expect(resolvePreviewFixtureScenario('epic', 'marche')).toBe('epic')
  })

  it('no parameters at all falls back to the default scenario', () => {
    expect(resolvePreviewFixtureScenario(null, null)).toBe('epic')
  })
})

describe('composition: the route-level cases from the correction brief', () => {
  // Each case names the actor's REAL resolved role (or null for denied/no-membership) and the
  // requested `?role=` value, and asserts the role that would actually be used to build
  // WorkspaceContext.actor.role — i.e. what the operator sees.
  const cases: Array<[string, string | null, string | null]> = [
    ['owner, no query -> owner', 'admin', null],
    ['manager, no query -> manager', 'manager', null],
    ['owner requesting manager -> manager (narrow, honoured)', 'admin', 'manager'],
    ['owner requesting operator -> operator (narrow, honoured)', 'admin', 'operator'],
    ['manager requesting operator -> operator (narrow, honoured)', 'manager', 'operator'],
    ['manager requesting owner -> manager (widen, refused)', 'manager', 'admin'],
    ['unknown role query -> real role used', 'manager', 'unknown-role'],
    ['empty role query -> real role used', 'manager', ''],
  ]

  it.each(cases)('%s', (_label, authoritative, requested) => {
    // Every row in `cases` above supplies a real role string, never null (a dedicated test
    // below covers the null/denied case) — the cast reflects that, not a type escape hatch.
    const result = narrowPreviewRole(authoritative as WorkspaceRole, requested)
    // Whatever comes out must never outrank the authoritative role.
    const RANK: Record<string, number> = { admin: 3, manager: 2, operator: 1 }
    expect(RANK[result]).toBeLessThanOrEqual(RANK[authoritative as string])
  })

  it('staff/no-membership requesting owner remains denied', () => {
    expect(narrowPreviewRole(null, 'admin')).toBeNull()
  })

  it('no-membership requesting manager remains denied', () => {
    expect(narrowPreviewRole(null, 'manager')).toBeNull()
  })
})

// ── resolveWorkspacePreviewRequest — the behavioral route-decision seam ─────
//
// Closes `defect-pr82-authorization-wiring-test-control-flow-gap-2026-08-06`. Everything below
// asserts on the RETURNED VALUE of the pure function `page.tsx` calls, not on the page's source
// text — this is what proves control flow (denied-in, nothing-out) rather than merely proving
// the right function names appear somewhere in the file.

const NO_QUERY: WorkspacePreviewRawQuery = { role: undefined, scenario: undefined, tenant: undefined }

function queryWith(overrides: Partial<WorkspacePreviewRawQuery>): WorkspacePreviewRawQuery {
  return { ...NO_QUERY, ...overrides }
}

describe('resolveWorkspacePreviewRequest — denied never reaches fixture selection', () => {
  it('a denied actor (no membership / staff) is unauthorized with no query at all', () => {
    const result = resolveWorkspacePreviewRequest(null, NO_QUERY)
    expect(result).toEqual({ authorized: false })
  })

  it('a denied actor cannot widen out of denial with any query combination', () => {
    const attempts: WorkspacePreviewRawQuery[] = [
      queryWith({ role: 'admin' }),
      queryWith({ role: 'manager' }),
      queryWith({ scenario: 'marche' }),
      queryWith({ tenant: 'marche' }),
      queryWith({ scenario: 'customer-none' }),
      queryWith({ scenario: 'customer-many' }),
      queryWith({ role: 'admin', scenario: 'marche', tenant: 'epic' }),
      queryWith({ role: 'admin', scenario: 'customer-many' }),
    ]
    for (const query of attempts) {
      expect(resolveWorkspacePreviewRequest(null, query)).toEqual({ authorized: false })
    }
  })

  it('no `scenario`, `role` or `authoritativeRole` field exists anywhere on a denied result', () => {
    const result = resolveWorkspacePreviewRequest(null, queryWith({ role: 'admin', scenario: 'marche' }))
    expect(result.authorized).toBe(false)
    expect('scenario' in result).toBe(false)
    expect('role' in result).toBe(false)
    expect('authoritativeRole' in result).toBe(false)
  })

  it('a malformed authoritative role (not admin/manager/operator) fails closed, exactly like denial', () => {
    // Defensive: toWorkspaceRole's closed switch cannot actually produce this today, but the
    // route-decision seam does not trust that invariant blindly either.
    const malformed = 'owner-typo' as unknown as WorkspaceRole
    expect(resolveWorkspacePreviewRequest(malformed, NO_QUERY)).toEqual({ authorized: false })
    expect(resolveWorkspacePreviewRequest(malformed, queryWith({ role: 'admin' }))).toEqual({
      authorized: false,
    })
  })
})

describe('resolveWorkspacePreviewRequest — authorized path composes the same safe primitives', () => {
  it('missing query uses the authoritative role and the default scenario, never a manager default', () => {
    expect(resolveWorkspacePreviewRequest('admin', NO_QUERY)).toEqual({
      authorized: true,
      authoritativeRole: 'admin',
      role: 'admin',
      scenario: 'epic',
    })
    expect(resolveWorkspacePreviewRequest('operator', NO_QUERY)).toEqual({
      authorized: true,
      authoritativeRole: 'operator',
      role: 'operator',
      scenario: 'epic',
    })
  })

  it('a query role may narrow but never widen', () => {
    expect(
      resolveWorkspacePreviewRequest('admin', queryWith({ role: 'operator' })),
    ).toMatchObject({ role: 'operator' })
    expect(
      resolveWorkspacePreviewRequest('manager', queryWith({ role: 'admin' })),
    ).toMatchObject({ role: 'manager' })
  })

  it('scenario is selected only for an authorized request, and only from the closed allowlist', () => {
    expect(
      resolveWorkspacePreviewRequest('manager', queryWith({ scenario: 'marche' })),
    ).toMatchObject({ scenario: 'marche' })
    expect(
      resolveWorkspacePreviewRequest('manager', queryWith({ scenario: 'not-a-real-tenant-id' })),
    ).toMatchObject({ scenario: 'epic' })
  })

  it('an authorized actor can reach the customer-none/customer-many scenarios', () => {
    expect(
      resolveWorkspacePreviewRequest('operator', queryWith({ scenario: 'customer-none' })),
    ).toEqual({
      authorized: true,
      authoritativeRole: 'operator',
      role: 'operator',
      scenario: 'customer-none',
    })
    expect(
      resolveWorkspacePreviewRequest('manager', queryWith({ scenario: 'customer-many' })),
    ).toEqual({
      authorized: true,
      authoritativeRole: 'manager',
      role: 'manager',
      scenario: 'customer-many',
    })
  })

  it('staff/no-membership requesting every role stays denied through the full seam', () => {
    for (const role of ['admin', 'manager', 'operator', 'bogus']) {
      expect(resolveWorkspacePreviewRequest(null, queryWith({ role }))).toEqual({
        authorized: false,
      })
    }
  })
})

// ── Fixture-scenario mapping (customer-none/customer-many are not tenants) ──

describe('underlyingFixtureTenant / customerResolutionOverrideFor', () => {
  it('epic and marche map to themselves with no customer-resolution override', () => {
    expect(underlyingFixtureTenant('epic')).toBe('epic')
    expect(underlyingFixtureTenant('marche')).toBe('marche')
    expect(customerResolutionOverrideFor('epic')).toBeUndefined()
    expect(customerResolutionOverrideFor('marche')).toBeUndefined()
  })

  it('customer-none and customer-many ride on the epic tenant identity', () => {
    expect(underlyingFixtureTenant('customer-none')).toBe('epic')
    expect(underlyingFixtureTenant('customer-many')).toBe('epic')
  })

  it('customer-none and customer-many force the matching CustomerResolution kind', () => {
    expect(customerResolutionOverrideFor('customer-none')).toBe('none')
    expect(customerResolutionOverrideFor('customer-many')).toBe('many')
  })
})

describe('resolvePreviewFixtureScenario — customer-none/customer-many join the closed allowlist', () => {
  it('both new scenario names are honoured', () => {
    expect(resolvePreviewFixtureScenario('customer-none', null)).toBe('customer-none')
    expect(resolvePreviewFixtureScenario('customer-many', null)).toBe('customer-many')
  })

  it('a real-looking tenant id is still never treated as a valid scenario, allowlist widening notwithstanding', () => {
    expect(resolvePreviewFixtureScenario('a1b2c3d4-e5f6-7890-abcd-ef1234567890', null)).toBe('epic')
    expect(resolvePreviewFixtureScenario('preview-tenant-epic-shaped', null)).toBe('epic')
  })

  it('the deprecated tenant alias also accepts the two new scenario names', () => {
    expect(resolvePreviewFixtureScenario(null, 'customer-none')).toBe('customer-none')
  })
})
