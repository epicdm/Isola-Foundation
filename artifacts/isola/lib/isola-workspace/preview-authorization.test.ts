import { describe, expect, it } from 'vitest'

import type { WorkspaceRole } from './contracts'
import {
  extractSingleQueryValue,
  narrowPreviewRole,
  resolvePreviewFixtureScenario,
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
