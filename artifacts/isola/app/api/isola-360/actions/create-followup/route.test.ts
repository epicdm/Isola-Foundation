/**
 * The button that writes a real mail.activity onto a real customer.
 *
 * The assertion that matters is not the response body — it is that
 * createCustomerFollowUp, the only thing here that reaches Odoo, is NEVER
 * CALLED for a tenant with no binding row. And its twin: for a tenant that IS
 * bound, it IS called, so the refusal cannot be passing against a route that
 * refuses everyone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveWriteMock, resolveReadMock, createFollowUpMock, resolveCallerMock } = vi.hoisted(
  () => ({
    resolveWriteMock: vi.fn(),
    resolveReadMock: vi.fn(),
    createFollowUpMock: vi.fn(),
    resolveCallerMock: vi.fn(),
  }),
)

// Prisma is never reached (the resolver is stubbed) but the real
// engine-bindings module imports it, so it is stood in for here rather than
// instantiating a client in a unit test.
vi.mock('@/lib/prisma', () => ({
  prisma: { odooBinding: { findUnique: async () => null } },
  default: {},
}))

// The REAL isOdooBindingRequiredError and the REAL error class are kept — only
// the two resolvers are stubbed. A test that supplied its own recogniser would
// be asserting against itself.
vi.mock('@/lib/engine-bindings', async (orig) => {
  const actual = await orig<typeof import('@/lib/engine-bindings')>()
  return {
    ...actual,
    resolveOdooConfigForTenant: resolveReadMock,
    resolveOdooConfigForTenantWrite: resolveWriteMock,
  }
})

vi.mock('@/lib/customer-360/odoo-projection', () => ({
  createCustomerFollowUp: createFollowUpMock,
}))

vi.mock('@/lib/customer-360/route-context', () => ({ resolveCaller: resolveCallerMock }))

import { OdooBindingRequiredError, TENANT_NOT_BOUND } from '@/lib/engine-bindings'

import { POST } from './route'

const TENANT = 'tenant-1'
const BOUND_CONFIG = { url: 'https://marigot.odoo.example', db: 'marigot', apiKey: 'k' }

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/isola-360/actions/create-followup', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as never,
  )

const followup = (over: Record<string, unknown> = {}) => ({
  customerId: 163,
  note: 'call back about the quotation',
  dueDate: '2026-09-11',
  ...over,
})

beforeEach(() => {
  resolveWriteMock.mockReset()
  resolveReadMock.mockReset()
  createFollowUpMock.mockReset()
  resolveCallerMock.mockReset()
  resolveCallerMock.mockResolvedValue({ ok: true, caller: { tenantId: TENANT } })
  resolveWriteMock.mockResolvedValue(BOUND_CONFIG)
  createFollowUpMock.mockResolvedValue({ id: 9001, summary: 'call back about the quotation' })
})

describe('an unbound tenant is refused, and Odoo is never touched', () => {
  it('answers ok:false with a named reason, and never calls the Odoo write', async () => {
    resolveWriteMock.mockRejectedValue(
      new OdooBindingRequiredError(TENANT, `tenant ${TENANT} has no OdooBinding row`),
    )

    const res = await post(followup())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe(TENANT_NOT_BOUND)
    // The whole point.
    expect(createFollowUpMock).not.toHaveBeenCalled()
  })

  it('CONTROL: a BOUND tenant is served and does reach the Odoo write', async () => {
    const res = await post(followup())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(createFollowUpMock).toHaveBeenCalledWith(
      BOUND_CONFIG,
      163,
      'call back about the quotation',
      '2026-09-11',
    )
  })

  it('resolves the destination through the WRITE door, never the read fallback', async () => {
    await post(followup())

    expect(resolveWriteMock).toHaveBeenCalledWith(TENANT)
    expect(resolveReadMock).not.toHaveBeenCalled()
  })
})

describe('the refusal is distinguishable from the failures it is not', () => {
  it('an unreachable Odoo is ok:false with NO tenant_not_bound reason', async () => {
    createFollowUpMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:443'))

    const body = await (await post(followup())).json()

    expect(body.ok).toBe(false)
    expect(body.reason).toBeUndefined()
    expect(String(body.error)).toContain('ECONNREFUSED')
  })

  it('a malformed request is still a 4xx, and reaches neither resolver nor Odoo', async () => {
    const res = await post(followup({ dueDate: 'next tuesday' }))

    expect(res.status).toBe(400)
    expect(resolveWriteMock).not.toHaveBeenCalled()
    expect(createFollowUpMock).not.toHaveBeenCalled()
  })
})
