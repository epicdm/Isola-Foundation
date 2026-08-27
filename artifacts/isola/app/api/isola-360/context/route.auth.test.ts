import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getSessionFromCookieMock,
  getMembershipRoleMock,
  resolveOdooConfigMock,
  readCustomer360Mock,
  chatwootBindingFindFirstMock,
  conversationFindFirstMock,
} = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  getMembershipRoleMock: vi.fn(),
  resolveOdooConfigMock: vi.fn(),
  readCustomer360Mock: vi.fn(),
  chatwootBindingFindFirstMock: vi.fn(),
  conversationFindFirstMock: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }))
vi.mock('@/lib/permissions', () => ({ getMembershipRole: getMembershipRoleMock }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: resolveOdooConfigMock }))
vi.mock('@/lib/customer-360/odoo-projection', () => ({ readCustomer360: readCustomer360Mock }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatwootBinding: { findFirst: chatwootBindingFindFirstMock },
    conversation: { findFirst: conversationFindFirstMock },
  },
}))

import { POST } from './route'

const TENANT = 'tenant-c360'

const session = {
  identityId: 'identity-1',
  effectiveTenantId: TENANT,
  isAdmin: false,
  isOwner: true,
  user: { tenant_id: TENANT },
}

const hint = { accountIdHint: 2, inboxIdHint: 7, conversationDisplayIdHint: 15 }
const request = (body: unknown = { hint }) =>
  new Request('http://localhost/api/isola-360/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'sid=whatever' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

beforeEach(() => {
  getSessionFromCookieMock.mockReset()
  getMembershipRoleMock.mockReset()
  resolveOdooConfigMock.mockReset()
  readCustomer360Mock.mockReset()
  chatwootBindingFindFirstMock.mockReset()
  conversationFindFirstMock.mockReset()
})

/* ── this is the exact defect the h2 fix targeted: the embedded panel must
 * refuse, not silently render, when no session cookie reaches the API ── */
describe('unauthenticated Customer 360 refusal', () => {
  it('answers 401 with no session cookie, before any Chatwoot or Odoo lookup', async () => {
    getSessionFromCookieMock.mockResolvedValue(null)

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(chatwootBindingFindFirstMock).not.toHaveBeenCalled()
    expect(resolveOdooConfigMock).not.toHaveBeenCalled()
  })
})

/* ── the embedded browser flow: a real session cookie reaches the API and
 * the same account/inbox/conversation hint Chatwoot posts resolves ── */
describe('authenticated iframe context', () => {
  beforeEach(() => {
    getSessionFromCookieMock.mockResolvedValue(session)
    getMembershipRoleMock.mockResolvedValue('member')
    chatwootBindingFindFirstMock.mockResolvedValue({ id: 'binding-1' })
    conversationFindFirstMock.mockResolvedValue({
      id: 'conv-1',
      customer_phone: '+17672951770',
      messages: [{ content: 'hello' }],
    })
    resolveOdooConfigMock.mockResolvedValue({ url: 'https://tenant.odoo.com', apiKey: 'k', db: 'd' })
  })

  it('returns state=ready for a session-scoped conversation that resolves in Odoo', async () => {
    readCustomer360Mock.mockResolvedValue({ customerId: 163, documents: [], balances: [] })

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.state).toBe('ready')
    // The tenant comes from the session, never from the posted hint.
    expect(resolveOdooConfigMock).toHaveBeenCalledWith(TENANT)
  })

  it('reports unavailable, not a fabricated match, when Odoo does not answer', async () => {
    readCustomer360Mock.mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.state).toBe('unavailable')
  })
})
