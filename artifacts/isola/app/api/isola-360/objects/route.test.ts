/**
 * The object-detail route's boundary tests.
 *
 * The security-critical property here is that a record id is a LOCATOR, never
 * an authorisation. Production Odoo holds 2,661 partners, 607 orders and 408
 * invoices; without the ownership check this route would answer "here is
 * invoice 391" to anyone who could count. Every test below exists because a
 * missing check would be invisible in normal use — the panel only ever asks for
 * ids it already displayed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getSessionFromCookieMock,
  getMembershipRoleMock,
  resolveOdooConfigMock,
  readCustomer360Mock,
  readObjectMock,
  conversationFindFirstMock,
} = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  getMembershipRoleMock: vi.fn(),
  resolveOdooConfigMock: vi.fn(),
  readCustomer360Mock: vi.fn(),
  readObjectMock: vi.fn(),
  conversationFindFirstMock: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }))
vi.mock('@/lib/permissions', () => ({ getMembershipRole: getMembershipRoleMock }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: resolveOdooConfigMock }))
vi.mock('@/lib/customer-360/odoo-projection', () => ({
  readCustomer360: readCustomer360Mock,
  readCustomer360Object: readObjectMock,
}))
vi.mock('@/lib/prisma', () => ({
  prisma: { conversation: { findFirst: conversationFindFirstMock } },
}))

import { POST } from './route'

const TENANT = 'tenant-c360'

const OURS = { id: 9, reference: 'INV/2026/00004', kind: 'invoice' as const }
const THEIRS_ID = 391

const request = (body: unknown) =>
  new Request('http://localhost/api/isola-360/objects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'sid=x' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

const hint = { accountIdHint: 2, inboxIdHint: 6, conversationDisplayIdHint: 28 }

beforeEach(() => {
  for (const m of [
    getSessionFromCookieMock, getMembershipRoleMock, resolveOdooConfigMock,
    readCustomer360Mock, readObjectMock, conversationFindFirstMock,
  ]) m.mockReset()

  getSessionFromCookieMock.mockResolvedValue({
    identityId: 'identity-1',
    effectiveTenantId: TENANT,
    isAdmin: false,
    isOwner: true,
    user: { id: 'user-1', tenant_id: TENANT },
  })
  getMembershipRoleMock.mockResolvedValue('owner')
  resolveOdooConfigMock.mockResolvedValue({ url: 'https://erp.example.com' })
  conversationFindFirstMock.mockResolvedValue({ customer_phone: '+15005550006' })
  readCustomer360Mock.mockResolvedValue({
    customer: { id: 163, name: 'Patricia Armour' },
    documents: [OURS],
  })
  readObjectMock.mockResolvedValue({
    kind: 'invoice', id: OURS.id, reference: OURS.reference,
    state: 'posted', paymentState: 'not_paid', total: 129.26, currency: 'USD',
    date: '2026-08-29', dueDate: null, odooLink: null,
    stages: [], lines: [], linesAvailability: 'available',
    payments: [], paymentsAvailability: 'available',
  })
})

describe('a record id is a locator, never an authorisation', () => {
  it("REFUSES a record that is not on this conversation's customer", async () => {
    // The id is real and well-formed. It simply belongs to someone else. The
    // detail read must never be reached.
    const res = await POST(request({ hint, objectId: THEIRS_ID, objectKind: 'invoice' }))
    const body = await res.json()

    expect(body.state).toBe('not-found')
    expect(readObjectMock).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: the customer’s OWN record opens', async () => {
    // Without this, the refusal above would pass equally against a route broken
    // to refuse everything.
    const res = await POST(request({ hint, objectId: OURS.id, objectKind: 'invoice' }))
    const body = await res.json()

    expect(body.state).toBe('ready')
    expect(body.detail.reference).toBe('INV/2026/00004')
    expect(readObjectMock).toHaveBeenCalledTimes(1)
  })

  it('pins the detail read to the resolved partner, not to the caller', async () => {
    await POST(request({ hint, objectId: OURS.id, objectKind: 'invoice' }))
    // Second argument is the partner id from the snapshot — 163 — and it comes
    // from the conversation, never from the request body.
    expect(readObjectMock.mock.calls[0][1]).toBe(163)
  })

  it('gives the SAME wording for "not yours" and "does not exist"', async () => {
    // Distinguishing them tells an unauthorised caller which ids are real,
    // which is the whole of what they wanted to learn.
    const notOurs = await (await POST(request({ hint, objectId: THEIRS_ID, objectKind: 'invoice' }))).json()

    readObjectMock.mockResolvedValue(null)
    const missing = await (await POST(request({ hint, objectId: OURS.id, objectKind: 'invoice' }))).json()

    expect(notOurs.message).toBe(missing.message)
  })
})

describe('boundaries and input', () => {
  it('401s with no session, before any lookup', async () => {
    getSessionFromCookieMock.mockResolvedValue(null)
    const res = await POST(request({ hint, objectId: OURS.id, objectKind: 'invoice' }))
    expect(res.status).toBe(401)
    expect(conversationFindFirstMock).not.toHaveBeenCalled()
  })

  it('400s on a malformed id or an unknown kind', async () => {
    expect((await POST(request({ hint, objectId: 0, objectKind: 'invoice' }))).status).toBe(400)
    expect((await POST(request({ hint, objectId: -1, objectKind: 'invoice' }))).status).toBe(400)
    expect((await POST(request({ hint, objectId: OURS.id, objectKind: 'ticket' }))).status).toBe(400)
  })

  it('refuses when the conversation has not reached the mirror', async () => {
    conversationFindFirstMock.mockResolvedValue(null)
    const body = await (await POST(request({ hint, objectId: OURS.id, objectKind: 'invoice' }))).json()
    expect(body.state).toBe('not-found')
    expect(readCustomer360Mock).not.toHaveBeenCalled()
  })

  it('reports a failed Odoo read as UNAVAILABLE, never as an empty record', async () => {
    // The distinction the whole surface rests on: "could not read" and
    // "nothing there" must never look alike.
    readCustomer360Mock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await POST(request({ hint, objectId: OURS.id, objectKind: 'invoice' }))
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.state).toBe('unavailable')
    expect(body.state).not.toBe('not-found')
  })

  it('scopes the conversation lookup to the session tenant', async () => {
    await POST(request({ hint, objectId: OURS.id, objectKind: 'invoice' }))
    expect(conversationFindFirstMock.mock.calls[0][0].where.tenant_id).toBe(TENANT)
  })
})
