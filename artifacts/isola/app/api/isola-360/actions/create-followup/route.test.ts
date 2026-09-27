/**
 * ev-isola-360-followup-assignment-2026-09-27: the assigneeRef permission
 * gate on POST /api/isola-360/actions/create-followup. resolveCaller and
 * createCustomerFollowUp are mocked; this test is only about the route's OWN
 * decision — who may pass an assigneeRef at all, and that a bad one never
 * reaches Odoo. createCustomerFollowUp's own assignment/readback behavior is
 * covered separately in odoo-projection-followup-assignment.test.ts (testing
 * the PATH here, the PIECE there — CLAUDE.md §2.20).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { resolveCallerMock, createFollowUpMock, resolveOdooConfigMock } = vi.hoisted(() => ({
  resolveCallerMock: vi.fn(),
  createFollowUpMock: vi.fn(),
  resolveOdooConfigMock: vi.fn(async () => ({ url: 'https://example.invalid', apiKey: 'x', db: 'd' })),
}))

vi.mock('@/lib/customer-360/route-context', () => ({ resolveCaller: resolveCallerMock }))
vi.mock('@/lib/customer-360/odoo-projection', () => ({ createCustomerFollowUp: createFollowUpMock }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: resolveOdooConfigMock }))

import { POST } from './route'

function caller(actorRole: string) {
  return { ok: true as const, caller: { tenantId: 't1', kind: 'session' as const, actorRole, userId: 'u1' } }
}

function req(body: Record<string, unknown>) {
  return new NextRequest('https://example.invalid/api/isola-360/actions/create-followup', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

const VALID_BODY = { customerId: 42, note: 'call back', dueDate: '2026-10-01' }

beforeEach(() => {
  resolveCallerMock.mockReset()
  createFollowUpMock.mockReset()
  createFollowUpMock.mockResolvedValue({ id: 1, summary: 'call back', dueDate: '2026-10-01', dueLabel: 'in 3 days', assignee: null })
})

describe('POST create-followup — assigneeRef authorization', () => {
  it('CONTROL — no assigneeRef, any role → passes through with assigneeRef=null, no role check applied', async () => {
    resolveCallerMock.mockResolvedValue(caller('staff'))
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(200)
    expect(createFollowUpMock).toHaveBeenCalledWith(expect.anything(), 42, 'call back', '2026-10-01', null, 't1')
  })

  it('staff caller WITH assigneeRef → 403, createCustomerFollowUp never called', async () => {
    resolveCallerMock.mockResolvedValue(caller('staff'))
    const res = await POST(req({ ...VALID_BODY, assigneeRef: 7 }))
    expect(res.status).toBe(403)
    expect(createFollowUpMock).not.toHaveBeenCalled()
  })

  it('manager caller WITH assigneeRef → allowed, forwarded as a string id plus the caller\'s tenantId', async () => {
    resolveCallerMock.mockResolvedValue(caller('manager'))
    const res = await POST(req({ ...VALID_BODY, assigneeRef: 7 }))
    expect(res.status).toBe(200)
    expect(createFollowUpMock).toHaveBeenCalledWith(expect.anything(), 42, 'call back', '2026-10-01', '7', 't1')
  })

  it('owner caller WITH assigneeRef → allowed', async () => {
    resolveCallerMock.mockResolvedValue(caller('owner'))
    const res = await POST(req({ ...VALID_BODY, assigneeRef: 7 }))
    expect(res.status).toBe(200)
    expect(createFollowUpMock).toHaveBeenCalledWith(expect.anything(), 42, 'call back', '2026-10-01', '7', 't1')
  })

  it('malformed assigneeRef (not a positive integer) → 400 before the role check, never reaches Odoo', async () => {
    resolveCallerMock.mockResolvedValue(caller('owner'))
    const res = await POST(req({ ...VALID_BODY, assigneeRef: 'not-a-number' }))
    expect(res.status).toBe(400)
    expect(createFollowUpMock).not.toHaveBeenCalled()
  })

  it('numeric-string assigneeRef from a manager is accepted (form fields commonly arrive as strings)', async () => {
    resolveCallerMock.mockResolvedValue(caller('manager'))
    const res = await POST(req({ ...VALID_BODY, assigneeRef: '7' }))
    expect(res.status).toBe(200)
    expect(createFollowUpMock).toHaveBeenCalledWith(expect.anything(), 42, 'call back', '2026-10-01', '7', 't1')
  })
})
