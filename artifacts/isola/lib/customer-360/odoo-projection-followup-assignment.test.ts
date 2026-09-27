/**
 * ev-isola-360-followup-assignment-2026-09-27: createCustomerFollowUp's new
 * assigneeRef parameter — the W2 gap (persist a follow-up AND assign it to a
 * real human/agent, provably). json2Call is mocked at the module boundary so
 * BOTH odoo-record-system.ts's internal calls (activityVals/scheduleFollowup/
 * readFollowup) and odoo-projection.ts's own resolveAssignableUser call are
 * intercepted uniformly, since odoo-record-system.ts defaults to the same
 * real json2Call when no `call` override is injected.
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

import { createCustomerFollowUp } from './odoo-projection'
import type { OdooConfig } from '@/engines/odoo'

const CONFIG: OdooConfig = { url: 'https://example.invalid', apiKey: 'unused', db: 'testdb' } as OdooConfig

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
})

describe('createCustomerFollowUp — assigneeRef', () => {
  it('CONTROL — no assigneeRef → unchanged behavior, no res.users lookup, assignee null', async () => {
    setScript({
      'mail.activity.search_read': [{ id: 4242, summary: 'call back', date_deadline: '2026-10-01', user_id: false }],
    })
    const result = await createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01')
    expect(result.assignee).toBeNull()
    expect(calls.some((c) => c.model === 'res.users')).toBe(false)
  })

  it('real assigneeRef → resolved, written, and the readback confirms the SAME name Odoo actually stored', async () => {
    setScript({
      'res.users.search_read': [{ id: 7, name: 'Ann Owner' }],
      'mail.activity.search_read': [{ id: 4242, summary: 'call back', date_deadline: '2026-10-01', user_id: [7, 'Ann Owner'] }],
    })
    const result = await createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7')
    expect(result.assignee).toBe('Ann Owner')
    const createCall = calls.find((c) => c.model === 'mail.activity' && c.method === 'create')
    expect(createCall?.params.vals_list).toMatchObject([{ user_id: 7 }])
  })

  it('assigneeRef that does not resolve (inactive/nonexistent user) → thrown BEFORE any write, no mail.activity.create call', async () => {
    setScript({ 'res.users.search_read': [] })
    await expect(createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '999999')).rejects.toThrow(
      /does not match a real, active user/,
    )
    expect(calls.some((c) => c.model === 'mail.activity')).toBe(false)
  })

  it('SABOTAGE — write reports success but the readback disagrees on the assignee → thrown, never silently reported as assigned', async () => {
    setScript({
      'res.users.search_read': [{ id: 7, name: 'Ann Owner' }],
      // Readback shows a DIFFERENT user than what was requested/written --
      // the exact "created but not what was asked for" failure mode.
      'mail.activity.search_read': [{ id: 4242, summary: 'call back', date_deadline: '2026-10-01', user_id: [3, 'Someone Else'] }],
    })
    await expect(createCustomerFollowUp(CONFIG, 99, 'call back', '2026-10-01', '7')).rejects.toThrow(
      /assignment could not be confirmed/,
    )
  })
})
