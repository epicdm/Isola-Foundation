import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSessionMock, requireWorkspaceAccessMock, json2CallMock, resolveOdooConfigMock } =
  vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    requireWorkspaceAccessMock: vi.fn(),
    json2CallMock: vi.fn(),
    resolveOdooConfigMock: vi.fn(),
  }))

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }))
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }))
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

const session = { effectiveTenantId: TENANT, user: { id: 'user-1' } }
const allow = () => ({
  ok: true,
  authz: { level: 'manager', basis: 'membership', membershipRole: 'admin', canViewAudit: false, canViewConfiguration: false },
})

const search = (q: string) => GET(new Request(`http://localhost/api/v1/customers/search?q=${encodeURIComponent(q)}`))

beforeEach(() => {
  getSessionMock.mockReset()
  requireWorkspaceAccessMock.mockReset()
  json2CallMock.mockReset()
  resolveOdooConfigMock.mockReset()
  resolveOdooConfigMock.mockResolvedValue({ url: ODOO, apiKey: 'k', db: 'd' })
  getSessionMock.mockResolvedValue(session)
  requireWorkspaceAccessMock.mockResolvedValue(allow())
})

describe('the guard runs before the search does', () => {
  it('answers 401 with no session and never queries', async () => {
    getSessionMock.mockResolvedValue(null)
    const res = await search('EPIC')

    expect(res.status).toBe(401)
    expect(json2CallMock).not.toHaveBeenCalled()
  })

  it('answers 403 without the manager role', async () => {
    requireWorkspaceAccessMock.mockResolvedValue({ ok: false, status: 403, error: 'nope', authz: {} })
    const res = await search('EPIC')

    expect(res.status).toBe(403)
    expect(json2CallMock).not.toHaveBeenCalled()
  })
})

describe('the tenant comes from the session', () => {
  it('searches the instance bound to the SESSION tenant', async () => {
    json2CallMock.mockResolvedValue([PARTNER])
    await search('EPIC')

    expect(resolveOdooConfigMock).toHaveBeenCalledWith(TENANT)
  })

  it('cannot be redirected to another tenant by a query parameter', async () => {
    json2CallMock.mockResolvedValue([PARTNER])
    await GET(new Request('http://localhost/api/v1/customers/search?q=EPIC&company=someone-else'))

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
