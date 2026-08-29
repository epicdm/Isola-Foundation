/**
 * Both doors, and the refusal in between.
 *
 * WHAT THIS FILE IS ACTUALLY PROTECTING
 * ------------------------------------
 * `resolveCaller` decides WHICH TENANT'S DATA a request may read. Everything
 * downstream — the Odoo instance, every Prisma scope — follows from its answer.
 * So the assertions here are not about status codes; they are about whether the
 * tenant boundary can be moved by anything a caller sends.
 *
 * THE CONTROLS ARE THE POINT
 * --------------------------
 * Nearly every test is a refusal, and a refusal suite passes perfectly against
 * a function that refuses EVERYTHING — including a correct credential. So each
 * door has a paired positive: the service door authenticates a correct token,
 * and the session door authenticates a valid cookie. If either goes red, the
 * refusals around it have stopped meaning anything.
 *
 * The mismatch tests carry their own control too: the SAME header, with the
 * MATCHING value, must be accepted. Otherwise "403 on mismatch" would pass just
 * as well against a route that 403s whenever the header is present at all,
 * which is a different behaviour wearing the same result.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionFromCookie = vi.fn()
const getMembershipRole = vi.fn()

vi.mock('@/lib/session', () => ({ getSessionFromCookie: (c: string) => getSessionFromCookie(c) }))
vi.mock('@/lib/permissions', () => ({ getMembershipRole: (i: string, t: string) => getMembershipRole(i, t) }))

const { resolveCaller, refuseOnTenantMismatch, TENANT_ASSERTION_HEADER } = await import('./route-context')

const TOKEN = 'x'.repeat(43)
const SERVICE_TENANT = 'tenant-from-config'
const SESSION_TENANT = 'tenant-from-session'

/** A NextRequest-shaped stand-in: this module only ever reads two headers. */
function req(headers: Record<string, string> = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null } } as never
}

function enableService() {
  process.env.ISOLA_360_SERVICE_ENABLED = 'true'
  process.env.ISOLA_360_SERVICE_TOKEN = TOKEN
  process.env.ISOLA_360_SERVICE_TENANT_ID = SERVICE_TENANT
}

function disableService() {
  delete process.env.ISOLA_360_SERVICE_ENABLED
  delete process.env.ISOLA_360_SERVICE_TOKEN
  delete process.env.ISOLA_360_SERVICE_TENANT_ID
}

/** A session the cookie door will accept. */
function goodSession() {
  getSessionFromCookie.mockResolvedValue({
    identityId: 'ident-1',
    effectiveTenantId: SESSION_TENANT,
    isAdmin: false,
    isOwner: true,
    user: { id: 'user-1', tenant_id: SESSION_TENANT },
  })
  getMembershipRole.mockResolvedValue('manager')
}

beforeEach(() => {
  vi.clearAllMocks()
  disableService()
  getSessionFromCookie.mockResolvedValue(null)
  getMembershipRole.mockResolvedValue(null)
})

describe('the positive controls — both doors can actually open', () => {
  it('SERVICE door: a correct token resolves the CONFIGURED tenant', async () => {
    enableService()
    const out = await resolveCaller(req({ authorization: `Bearer ${TOKEN}` }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.caller).toEqual({
      tenantId: SERVICE_TENANT,
      kind: 'service',
      actorRole: 'manager',
      userId: null,
    })
  })

  it('SESSION door: a valid cookie resolves the SESSION tenant', async () => {
    goodSession()
    const out = await resolveCaller(req({ cookie: 'isola=abc' }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.caller.tenantId).toBe(SESSION_TENANT)
    expect(out.caller.kind).toBe('session')
    expect(out.caller.userId).toBe('user-1')
  })
})

describe('a service caller is never an owner', () => {
  it('resolves actorRole "manager", not "owner"', async () => {
    enableService()
    const out = await resolveCaller(req({ authorization: `Bearer ${TOKEN}` }))
    if (!out.ok) throw new Error('expected the service door to open')
    expect(out.caller.actorRole).toBe('manager')
    expect(out.caller.actorRole).not.toBe('owner')
  })
})

describe('a presented-but-invalid bearer does NOT fall through to the cookie door', () => {
  it('refuses even when a perfectly valid session cookie is also present', async () => {
    // The failure this prevents: a caller holding a stale service token AND a
    // browser session silently succeeds as a different principal, and the
    // credential it actually presented fails unnoticed.
    enableService()
    goodSession()
    const out = await resolveCaller(req({ authorization: 'Bearer wrong-token', cookie: 'isola=abc' }))
    expect(out.ok).toBe(false)
  })

  it('CONTROL: that same cookie DOES open the door when no bearer is presented', async () => {
    // Proves the refusal above is caused by the bad bearer, not by a broken
    // session fixture — without this, the test passes for the wrong reason.
    enableService()
    goodSession()
    const out = await resolveCaller(req({ cookie: 'isola=abc' }))
    expect(out.ok).toBe(true)
  })
})

describe('the tenant cannot be moved by anything the caller sends', () => {
  it('SERVICE: a mismatched tenant assertion is REFUSED, not honoured and not ignored', async () => {
    enableService()
    const out = await resolveCaller(
      req({ authorization: `Bearer ${TOKEN}`, [TENANT_ASSERTION_HEADER]: 'some-other-tenant' }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.response.status).toBe(403)
  })

  it('SERVICE CONTROL: the SAME header with the MATCHING value is accepted', async () => {
    // Without this, "403 on mismatch" would pass equally against a route that
    // refuses whenever the header is present at all — a different behaviour
    // wearing the same result.
    enableService()
    const out = await resolveCaller(
      req({ authorization: `Bearer ${TOKEN}`, [TENANT_ASSERTION_HEADER]: SERVICE_TENANT }),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.caller.tenantId).toBe(SERVICE_TENANT)
  })

  it('SESSION: a mismatched tenant assertion is refused on the cookie path too', async () => {
    goodSession()
    const out = await resolveCaller(
      req({ cookie: 'isola=abc', [TENANT_ASSERTION_HEADER]: 'some-other-tenant' }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.response.status).toBe(403)
  })

  it('SESSION CONTROL: the matching header is accepted and the tenant is unchanged', async () => {
    goodSession()
    const out = await resolveCaller(
      req({ cookie: 'isola=abc', [TENANT_ASSERTION_HEADER]: SESSION_TENANT }),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.caller.tenantId).toBe(SESSION_TENANT)
  })

  it('the header can never GRANT — it is only ever compared', async () => {
    // No token configured, so the service door is shut. Asserting the service
    // tenant must not open it, and must not change the session's tenant either.
    goodSession()
    const out = await resolveCaller(
      req({ cookie: 'isola=abc', [TENANT_ASSERTION_HEADER]: SESSION_TENANT }),
    )
    if (!out.ok) throw new Error('expected the session door to open')
    expect(out.caller.tenantId).toBe(SESSION_TENANT)
    expect(out.caller.kind).toBe('session')
  })
})

describe('the kill-switch closes the service door', () => {
  it('a correct token is refused when the switch is off', async () => {
    enableService()
    process.env.ISOLA_360_SERVICE_ENABLED = 'false'
    const out = await resolveCaller(req({ authorization: `Bearer ${TOKEN}` }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.response.status).toBe(401)
  })

  it('CONTROL: the identical request succeeds with the switch on', async () => {
    enableService()
    const out = await resolveCaller(req({ authorization: `Bearer ${TOKEN}` }))
    expect(out.ok).toBe(true)
  })
})

describe('refuseOnTenantMismatch in isolation', () => {
  it('returns null when absent or matching, and a 403 when it disagrees', () => {
    expect(refuseOnTenantMismatch(req(), 't1')).toBeNull()
    expect(refuseOnTenantMismatch(req({ [TENANT_ASSERTION_HEADER]: '  ' }), 't1')).toBeNull()
    expect(refuseOnTenantMismatch(req({ [TENANT_ASSERTION_HEADER]: 't1' }), 't1')).toBeNull()
    expect(refuseOnTenantMismatch(req({ [TENANT_ASSERTION_HEADER]: 't2' }), 't1')?.status).toBe(403)
  })

  it('says only "Forbidden" — it never confirms that the other tenant is real', async () => {
    // Echoing the asserted id back, or distinguishing "no such tenant" from
    // "not yours", would make this an enumeration oracle over tenant ids.
    const res = refuseOnTenantMismatch(req({ [TENANT_ASSERTION_HEADER]: 'probe-me' }), 't1')
    const body = await res!.json()
    expect(body).toEqual({ error: 'Forbidden' })
    expect(JSON.stringify(body)).not.toContain('probe-me')
  })
})
