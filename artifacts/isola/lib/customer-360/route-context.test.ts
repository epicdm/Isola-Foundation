/**
 * ev-isola-360-followup-assignment-2026-09-27, Codex review PR #156:
 * actorRoleFor's membershipRole check was comparing against 'manager', a
 * value that has never existed in lib/permissions.ts's real Membership.role
 * vocabulary ('owner' | 'admin' | 'staff') -- a tenant admin's own
 * membership row was invisible to this mapping and silently fell through to
 * 'staff'. This tests the fixed mapping directly, without a server.
 */
import { describe, it, expect } from 'vitest'
import { actorRoleFor } from './route-context'

describe('actorRoleFor', () => {
  it('CONTROL — global admin or home owner → owner, whatever the membership row says', () => {
    expect(actorRoleFor(true, false, null)).toBe('owner')
    expect(actorRoleFor(false, true, 'staff')).toBe('owner')
  })

  it('Codex PR #156 fix — a real tenant admin (Membership.role="admin") maps to manager, not staff', () => {
    expect(actorRoleFor(false, false, 'admin')).toBe('manager')
  })

  it('a membership role of "owner" also maps to manager (this mapping never grants global owner from a membership row)', () => {
    expect(actorRoleFor(false, false, 'owner')).toBe('manager')
  })

  it('a real membership role of "staff" maps to staff', () => {
    expect(actorRoleFor(false, false, 'staff')).toBe('staff')
  })

  it('no membership row at all → staff, the safe default', () => {
    expect(actorRoleFor(false, false, null)).toBe('staff')
  })

  it('REGRESSION GUARD — "manager" is not a real Membership.role value and must never be checked for again', () => {
    // If this ever starts returning 'manager', someone reintroduced the
    // exact string that was never valid in lib/permissions.ts's Role type.
    expect(actorRoleFor(false, false, 'manager')).toBe('staff')
  })
})
