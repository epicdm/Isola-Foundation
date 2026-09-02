import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveCallerMock, json2CallMock, resolveOdooConfigMock } =
  vi.hoisted(() => ({
    resolveCallerMock: vi.fn(),
    json2CallMock: vi.fn(),
    resolveOdooConfigMock: vi.fn(),
  }))

vi.mock('@/lib/customer-360/route-context', () => ({ resolveCaller: resolveCallerMock }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: resolveOdooConfigMock }))
vi.mock('@/engines/odoo', async (orig) => {
  const actual = await orig<typeof import('@/engines/odoo')>()
  return { ...actual, json2Call: json2CallMock }
})

import { OdooNoApiError } from '@/engines/odoo'
import { GET } from './route'

const TENANT = 'tenant-1'
const ODOO = 'https://tenant.odoo.com'
const PARTNER = {
  id: 42,
  name: 'EPIC Communications Inc',
  email: 'info@epic.dm',
  phone: '+1 767-818-3742',
  city: 'Roseau',
  street: '8 Castle Street',
  is_company: true,
  parent_id: false,
  active: true,
}

type Req = import('next/server').NextRequest
const req = (url: string) => new Request(url) as unknown as Req

/** A caller resolved by either door. `kind` and `actorRole` are what the route reads. */
const caller = (over: Record<string, unknown> = {}) => ({
  ok: true,
  caller: { tenantId: TENANT, kind: 'session', actorRole: 'manager', userId: 'user-1', ...over },
})
const refused = (status: number) => ({
  ok: false,
  response: new Response(JSON.stringify({ error: 'no' }), { status }),
})

const search = (q: string) => GET(req(`http://localhost/api/v1/customers/search?q=${encodeURIComponent(q)}`))

beforeEach(() => {
  resolveCallerMock.mockReset()
  json2CallMock.mockReset()
  resolveOdooConfigMock.mockReset()
  resolveOdooConfigMock.mockResolvedValue({ url: ODOO, apiKey: 'k', db: 'd' })
  resolveCallerMock.mockResolvedValue(caller())
})

describe('the guard runs before the search does', () => {
  it('answers 401 with no credential at either door, and never queries', async () => {
    resolveCallerMock.mockResolvedValue(refused(401))
    const res = await search('EPIC')

    expect(res.status).toBe(401)
    expect(json2CallMock).not.toHaveBeenCalled()
  })

  it('answers 403 when the caller is refused by the preamble', async () => {
    resolveCallerMock.mockResolvedValue(refused(403))
    const res = await search('EPIC')

    expect(res.status).toBe(403)
    expect(json2CallMock).not.toHaveBeenCalled()
  })
})

/* ── the door this route gained, and the floor it must NOT lose ────────────
 *
 * The route previously took the cookie door only, so the published
 * customer-search@1 contract was unreachable by the portal, which calls
 * Foundation with a per-tenant service token. Adding the door is the fix.
 * The risk in adding it is the opposite mistake: resolveCaller's cookie path
 * admits 'staff', while the guard it replaced required 'manager'. A refactor
 * that quietly widens who can enumerate customers is not a refactor, so the
 * floor is asserted here in both directions.
 */
describe('both doors, and the role floor', () => {
  it('a SERVICE caller may search — this is the door the contract was published for', async () => {
    resolveCallerMock.mockResolvedValue(caller({ kind: 'service', actorRole: 'manager', userId: null }))
    json2CallMock.mockResolvedValue([PARTNER])
    const body = await (await search('EPIC')).json()

    expect(body.state).toBe('available')
    expect(resolveOdooConfigMock).toHaveBeenCalledWith(TENANT)
  })

  it('a STAFF session is refused, exactly as it was before the door was added', async () => {
    resolveCallerMock.mockResolvedValue(caller({ actorRole: 'staff' }))
    const res = await search('EPIC')

    expect(res.status).toBe(403)
    expect(json2CallMock).not.toHaveBeenCalled()
  })

  it('CONTROL — an owner is allowed, so the 403 above is the floor and not a blanket refusal', async () => {
    resolveCallerMock.mockResolvedValue(caller({ actorRole: 'owner' }))
    json2CallMock.mockResolvedValue([PARTNER])
    const res = await search('EPIC')

    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe('available')
  })

  it('the tenant comes from the CALLER, never the request — service door included', async () => {
    resolveCallerMock.mockResolvedValue(caller({ kind: 'service', tenantId: 'tenant-from-token' }))
    json2CallMock.mockResolvedValue([PARTNER])
    await GET(req('http://localhost/api/v1/customers/search?q=EPIC&tenant=tenant-from-query'))

    expect(resolveOdooConfigMock).toHaveBeenCalledWith('tenant-from-token')
    expect(resolveOdooConfigMock).not.toHaveBeenCalledWith('tenant-from-query')
  })
})

describe('the tenant comes from the caller', () => {
  it('searches the instance bound to the CALLER tenant', async () => {
    json2CallMock.mockResolvedValue([PARTNER])
    await search('EPIC')

    expect(resolveOdooConfigMock).toHaveBeenCalledWith(TENANT)
  })

  it('cannot be redirected to another tenant by a query parameter', async () => {
    json2CallMock.mockResolvedValue([PARTNER])
    await GET(req('http://localhost/api/v1/customers/search?q=EPIC&company=someone-else'))

    expect(resolveOdooConfigMock).toHaveBeenCalledWith(TENANT)
    expect(resolveOdooConfigMock).not.toHaveBeenCalledWith('someone-else')
  })
})

describe('a match', () => {
  it('returns available with an openable partner id', async () => {
    json2CallMock.mockResolvedValue([PARTNER])
    const body = await (await search('EPIC')).json()

    expect(body.state).toBe('available')
    expect(body.count).toBe(1)
    expect(body.results[0].id).toBe(42)
    expect(body.results[0].link).toBe(`${ODOO}/odoo/res.partner/42`)
  })

  it('reports which kind of search ran', async () => {
    json2CallMock.mockResolvedValue([])
    expect((await (await search('info@epic.dm')).json()).term).toBe('email')
    expect((await (await search('42')).json()).term).toBe('partner_id')
  })
})

/* ── the assertion this route exists for ───────────────────────────────────*/

describe('a search that could not run is NOT a search that found nothing', () => {
  it('reports empty only when Odoo actually answered', async () => {
    json2CallMock.mockResolvedValue([])
    const body = await (await search('nobody')).json()

    expect(body.state).toBe('empty')
    expect(body.reason).toBeNull()
  })

  it('reports unavailable when Odoo could not be reached', async () => {
    json2CallMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:443'))
    const body = await (await search('EPIC')).json()

    expect(body.state).toBe('unavailable')
    expect(body.state).not.toBe('empty')
    expect(body.count).toBe(0)
    expect(body.retryable).toBe(true)
  })

  it('does not claim the Odoo plan lacks an API when the server merely faltered', async () => {
    json2CallMock.mockRejectedValue(new OdooNoApiError(502))
    const body = await (await search('EPIC')).json()

    expect(body.state).toBe('unavailable')
    expect(body.reason).not.toContain('plan')
    expect(body.reason).toContain('temporarily')
  })

  it('reports unavailable when the tenant has no directory connected', async () => {
    resolveOdooConfigMock.mockRejectedValue(new Error('no binding'))
    const body = await (await search('EPIC')).json()

    expect(body.state).toBe('unavailable')
    expect(body.results).toEqual([])
  })

  it('puts no driver text on the wire', async () => {
    json2CallMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:443'))
    const body = await (await search('EPIC')).json()

    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(body)).not.toContain('10.1.2.3')
  })
})

describe('a term that is not a question', () => {
  it('returns empty without querying anything', async () => {
    const body = await (await search('a')).json()

    expect(body.state).toBe('empty')
    expect(body.term).toBeNull()
    expect(json2CallMock).not.toHaveBeenCalled()
  })
})
