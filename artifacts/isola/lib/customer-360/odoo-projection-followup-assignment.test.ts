/**
 * ev-isola-360-followup-assignment-2026-09-27: createCustomerFollowUp's new
 * assigneeRef parameter — the W2 gap (persist a follow-up AND assign it to a
 * real human/agent, provably). json2Call is mocked at the module boundary so
 * BOTH odoo-record-system.ts's internal calls (activityVals/scheduleFollowup/
 * readFollowup) and odoo-projection.ts's own resolveAssignableUser call are
 * intercepted uniformly, since odoo-record-system.ts defaults to the same
 * real json2Call when no `call` override is injected. findBindingByOdooUser
 * is mocked separately (Codex review, PR #156: Odoo identity alone is not
 * tenant proof — see resolveAssignableUser's own comment in odoo-projection.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: Array<{ model: string; method: string; params: Record<string, unknown> }> = []

vi.mock('@/engines/odoo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engines/odoo')>()
  return {
    ...actual,
    json2Call: vi.fn(async (_config: unknown, model: string, method: string, params: Record<string, unknown> = {}) => {
      calls.push({ model, method, params })
      const key = `${model}.${method}`
      const script = (globalThis as any).__followupScript as Record<string, unknown>
      if (!(key in script)) throw new Error(`test script has no entry for ${key}`)
      const v = script[key]
      return typeof v === 'function' ? (v as () => unknown)() : v
    }),
  }
})

const findBindingByOdooUserMock = vi.fn()
vi.mock('@/lib/staff-ops/service', () => ({
  findBindingByOdooUser: findBindingByOdooUserMock,
}))

import { createCustomerFollowUp } from './odoo-projection'
import type { OdooConfig } from '@/engines/odoo'

const CONFIG: OdooConfig = { url: 'https://example.invalid', apiKey: 'unused', db: 'testdb' } as OdooConfig
const TENANT = 'tenant-a'

const BASE_SCRIPT = {
  'ir.model.search_read': [{ id: 55 }],
  'mail.activity.type.search_read': [{ id: 9 }],
  'mail.activity.create': 4242,
}

function setScript(overrides: Record<string, unknown>) {
  ;(globalThis as any).__followupScript = { ...BASE_SCRIPT, ...overrides }
}

beforeEach(() => {
  calls.length = 0
  findBindingByOdooUserMock.mockReset()
})

describe('createCustomerFollowUp — assigneeRef', () => {
  it('CONTROL — no assigneeRef → unchanged behavior, no res.users lookup, no binding check, assignee null', async () => {
    setScript({
      'mail.activity.search_read': [{ id: 4242, summary: 'call back', date_deadline: '2026-10-01', user_id: false }],
    })
    const result = await createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01')
    expect(result.assignee).toBeNull()
    expect(calls.some((c) => c.model === 'res.users')).toBe(false)
    expect(findBindingByOdooUserMock).not.toHaveBeenCalled()
  })

  it('real assigneeRef, bound to the tenant → resolved, written, and the readback confirms the SAME id Odoo actually stored', async () => {
    findBindingByOdooUserMock.mockResolvedValue({ id: 'binding-1', active: true })
    setScript({
      'res.users.search_read': [{ id: 7, name: 'Ann Owner' }],
      'mail.activity.search_read': [{ id: 4242, summary: 'call back', date_deadline: '2026-10-01', user_id: [7, 'Ann Owner'] }],
    })
    const result = await createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7', TENANT)
    expect(result.assignee).toBe('Ann Owner')
    expect(findBindingByOdooUserMock).toHaveBeenCalledWith(TENANT, 7)
    const createCall = calls.find((c) => c.model === 'mail.activity' && c.method === 'create')
    expect(createCall?.params.vals_list).toMatchObject([{ user_id: 7 }])
  })

  it('SECURITY — binding row exists but is DEACTIVATED (offboarded staff, still-active Odoo account) → thrown, not assignable', async () => {
    findBindingByOdooUserMock.mockResolvedValue({ id: 'binding-1', active: false })
    setScript({ 'res.users.search_read': [{ id: 7, name: 'Formerly Staff' }] })
    await expect(createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7', TENANT)).rejects.toThrow(
      /does not match a real, active, internal user bound to this tenant/,
    )
    expect(calls.some((c) => c.model === 'mail.activity')).toBe(false)
  })

  it('assigneeRef that does not resolve in Odoo at all → thrown BEFORE any write, binding check never called', async () => {
    setScript({ 'res.users.search_read': [] })
    await expect(createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '999999', TENANT)).rejects.toThrow(
      /does not match a real, active, internal user bound to this tenant/,
    )
    expect(calls.some((c) => c.model === 'mail.activity')).toBe(false)
    expect(findBindingByOdooUserMock).not.toHaveBeenCalled()
  })

  it('SECURITY — real, active, internal Odoo user but NOT bound to this tenant → thrown, never assigned across a tenant boundary', async () => {
    findBindingByOdooUserMock.mockResolvedValue(null)
    setScript({ 'res.users.search_read': [{ id: 7, name: 'Someone Else Tenant’s Staff' }] })
    await expect(createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7', TENANT)).rejects.toThrow(
      /does not match a real, active, internal user bound to this tenant/,
    )
    expect(findBindingByOdooUserMock).toHaveBeenCalledWith(TENANT, 7)
    expect(calls.some((c) => c.model === 'mail.activity')).toBe(false)
  })

  it('assigneeRef supplied with no tenantId → refused before any Odoo call at all (a caller bug, not a valid state)', async () => {
    await expect(createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7', null)).rejects.toThrow(
      /tenantId is required/,
    )
    expect(calls.length).toBe(0)
    expect(findBindingByOdooUserMock).not.toHaveBeenCalled()
  })

  it('SABOTAGE — write reports success but the readback disagrees on the assignee ID → thrown, never silently reported as assigned', async () => {
    findBindingByOdooUserMock.mockResolvedValue({ id: 'binding-1', active: true })
    setScript({
      'res.users.search_read': [{ id: 7, name: 'Ann Owner' }],
      // Readback shows a DIFFERENT user id than what was requested/written --
      // the exact "created but not what was asked for" failure mode.
      'mail.activity.search_read': [{ id: 4242, summary: 'call back', date_deadline: '2026-10-01', user_id: [3, 'Ann Owner'] }],
    })
    // Same DISPLAY NAME as the requested assignee ('Ann Owner') but a
    // DIFFERENT id -- proves the comparison is by id, not name (Codex
    // review, PR #156: two users can share a display name).
    await expect(createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7', TENANT)).rejects.toThrow(
      /assignment could not be confirmed/,
    )
  })

  it('CONTROL for the sabotage case — an UNTAMPERED write with the same assignee id executes cleanly', async () => {
    findBindingByOdooUserMock.mockResolvedValue({ id: 'binding-1', active: true })
    setScript({
      'res.users.search_read': [{ id: 7, name: 'Ann Owner' }],
      'mail.activity.search_read': [{ id: 4242, summary: 'call back', date_deadline: '2026-10-01', user_id: [7, 'Ann Owner'] }],
    })
    const result = await createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7', TENANT)
    expect(result.assignee).toBe('Ann Owner')
  })
})
