/**
 * The lifecycle route's boundary tests.
 *
 * The security-critical property is the same as /api/isola-360/objects: a
 * `did` is a LOCATOR, never an authorisation. Without the ownership check
 * this route would answer "yes, this number has a Personal Line, here is
 * its onboarding status" to anyone who could guess a phone number.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getSessionFromCookieMock,
  getMembershipRoleMock,
  resolveOdooConfigMock,
  readCustomer360Mock,
  resolveAndReadLifecycleMock,
  conversationFindFirstMock,
} = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  getMembershipRoleMock: vi.fn(),
  resolveOdooConfigMock: vi.fn(),
  readCustomer360Mock: vi.fn(),
  resolveAndReadLifecycleMock: vi.fn(),
  conversationFindFirstMock: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }))
vi.mock('@/lib/permissions', () => ({ getMembershipRole: getMembershipRoleMock }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: resolveOdooConfigMock }))
vi.mock('@/lib/customer-360/odoo-projection', () => ({ readCustomer360: readCustomer360Mock }))
vi.mock('@/lib/customer-360/personal-line-services', () => ({ resolveAndReadLifecycle: resolveAndReadLifecycleMock }))
vi.mock('@/lib/prisma', () => ({
  prisma: { conversation: { findFirst: conversationFindFirstMock } },
}))

import { POST } from './route'

const TENANT = 'tenant-c360'

const OURS_DID = '17678185063'
const THEIRS_DID = '17679990000'

const FULL_MILESTONE = { status: 'done' as const, evidenceAt: null, failureReason: null, nextAction: null }
const FULL_LIFECYCLE = {
  signup: FULL_MILESTONE,
  number_assigned: FULL_MILESTONE,
  sip_registered: FULL_MILESTONE,
  first_confirmation_or_call: FULL_MILESTONE,
  trial_or_plan_active: FULL_MILESTONE,
  odoo_linked: FULL_MILESTONE,
}

const request = (body: unknown) =>
  new Request('http://localhost/api/isola-360/lifecycle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'sid=x' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

const hint = { accountIdHint: 2, inboxIdHint: 6, conversationDisplayIdHint: 28 }

beforeEach(() => {
  for (const m of [
    getSessionFromCookieMock, getMembershipRoleMock, resolveOdooConfigMock,
    readCustomer360Mock, resolveAndReadLifecycleMock, conversationFindFirstMock,
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
    services: [{ kind: 'personal_line', did: OURS_DID, sipRegistered: true, magnusUserAssigned: true, createdAt: null }],
    servicesAvailable: true,
  })
  resolveAndReadLifecycleMock.mockResolvedValue({ state: 'ready', lifecycle: FULL_LIFECYCLE })
})

describe('a did is a locator, never an authorisation', () => {
  it("REFUSES a did that is not on this conversation's customer", async () => {
    // The did is well-formed. It simply is not one of this customer's own
    // services. The bff-v2 read must never be reached.
    const res = await POST(request({ hint, did: THEIRS_DID }))
    const body = await res.json()

    expect(body.state).toBe('not-found')
    expect(resolveAndReadLifecycleMock).not.toHaveBeenCalled()
  })

  it("POSITIVE CONTROL: the customer's OWN Personal Line resolves", async () => {
    // Without this, the refusal above would pass equally against a route
    // broken to refuse everything.
    const res = await POST(request({ hint, did: OURS_DID }))
    const body = await res.json()

    expect(body.state).toBe('ready')
    expect(body.lifecycle).toEqual(FULL_LIFECYCLE)
    expect(resolveAndReadLifecycleMock).toHaveBeenCalledWith(OURS_DID)
  })

  it('gives the SAME wording for "not yours" and "does not exist"', async () => {
    const notOurs = await (await POST(request({ hint, did: THEIRS_DID }))).json()

    readCustomer360Mock.mockResolvedValue({ customer: { id: 163, name: 'Patricia Armour' }, services: [], servicesAvailable: true })
    const missing = await (await POST(request({ hint, did: OURS_DID }))).json()

    expect(notOurs.message).toBe(missing.message)
  })

  it('reports UNAVAILABLE, never "not-found", when bff-v2 itself did not answer for this customer’s services — an outage must never be presented as "this Personal Line does not exist"', async () => {
    // THE ACTUAL BUG: an empty services array always fails the ownership
    // check below, so without this gate a bff-v2 outage was silently
    // misreported as "that Personal Line is not available on this
    // customer" — indistinguishable from a genuine cross-customer probe.
    readCustomer360Mock.mockResolvedValue({ customer: { id: 163, name: 'Patricia Armour' }, services: [], servicesAvailable: false })
    const res = await POST(request({ hint, did: OURS_DID }))
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.state).toBe('unavailable')
    expect(body.state).not.toBe('not-found')
    expect(resolveAndReadLifecycleMock).not.toHaveBeenCalled()
  })
})

describe('boundaries and input', () => {
  it('401s with no session, before any lookup', async () => {
    getSessionFromCookieMock.mockResolvedValue(null)
    const res = await POST(request({ hint, did: OURS_DID }))
    expect(res.status).toBe(401)
    expect(conversationFindFirstMock).not.toHaveBeenCalled()
  })

  it('400s on a missing did', async () => {
    expect((await POST(request({ hint, did: '' }))).status).toBe(400)
    expect((await POST(request({ hint }))).status).toBe(400)
  })

  it('refuses when the conversation has not reached the mirror', async () => {
    conversationFindFirstMock.mockResolvedValue(null)
    const body = await (await POST(request({ hint, did: OURS_DID }))).json()
    expect(body.state).toBe('not-found')
    expect(readCustomer360Mock).not.toHaveBeenCalled()
  })

  it('reports a failed Odoo read as UNAVAILABLE, never as a missing checklist', async () => {
    readCustomer360Mock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await POST(request({ hint, did: OURS_DID }))
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.state).toBe('unavailable')
    expect(body.state).not.toBe('not-found')
  })

  it('forwards resolveAndReadLifecycle’s own unavailable/not-found states unchanged', async () => {
    resolveAndReadLifecycleMock.mockResolvedValue({ state: 'unavailable', message: 'bff-v2 could not be reached.' })
    const body = await (await POST(request({ hint, did: OURS_DID }))).json()
    expect(body).toEqual({ state: 'unavailable', message: 'bff-v2 could not be reached.' })
  })

  it('scopes the conversation lookup to the session tenant', async () => {
    await POST(request({ hint, did: OURS_DID }))
    expect(conversationFindFirstMock.mock.calls[0][0].where.tenant_id).toBe(TENANT)
  })
})
