import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Direct unit tests for the REAL `resolveOdooScope`/`readLeadCompanyId`
 * implementations — exercised only indirectly (via injected fakes) in
 * revenue-mcp-actions.test.ts. These tests prove the actual production code
 * fails closed: no explicit OdooBinding row, no bound login, or an
 * unreachable Odoo all deny rather than fall back.
 */

const { odooBindingMock, json2CallMock, decryptSecretMock } = vi.hoisted(() => ({
  odooBindingMock: { findUnique: vi.fn() },
  json2CallMock: vi.fn(),
  decryptSecretMock: vi.fn((v: string) => `decrypted:${v}`),
}))

vi.mock('@/lib/prisma', () => ({ prisma: { odooBinding: odooBindingMock } }))
vi.mock('@/lib/tenant-secrets', () => ({ decryptSecret: decryptSecretMock }))
vi.mock('@/engines/odoo', () => ({ json2Call: json2CallMock }))

import { DEFAULT_ODOO_SCOPE_PORTS } from './revenue-odoo-scope'

const TENANT = 'tenant-epic'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveOdooScope — correction 1: no global fallback', () => {
  it('denies when the tenant has NO explicit OdooBinding row at all', async () => {
    odooBindingMock.findUnique.mockResolvedValue(null)
    const scope = await DEFAULT_ODOO_SCOPE_PORTS.resolveOdooScope(TENANT)
    expect(scope).toBeNull()
    expect(json2CallMock).not.toHaveBeenCalled() // never even asks Odoo — refused before any call
  })

  it('denies when the binding exists but has no bound login', async () => {
    odooBindingMock.findUnique.mockResolvedValue({
      tenant_id: TENANT,
      url: 'https://epic.odoo.com',
      db: 'epic',
      login: null,
      api_key_enc: 'enc',
    })
    const scope = await DEFAULT_ODOO_SCOPE_PORTS.resolveOdooScope(TENANT)
    expect(scope).toBeNull()
    expect(json2CallMock).not.toHaveBeenCalled()
  })

  it('denies when the binding has an empty-string login', async () => {
    odooBindingMock.findUnique.mockResolvedValue({
      tenant_id: TENANT,
      url: 'https://epic.odoo.com',
      db: 'epic',
      login: '   ',
      api_key_enc: 'enc',
    })
    const scope = await DEFAULT_ODOO_SCOPE_PORTS.resolveOdooScope(TENANT)
    expect(scope).toBeNull()
  })

  it('resolves the bound company id from res.users when a binding + login exist', async () => {
    odooBindingMock.findUnique.mockResolvedValue({
      tenant_id: TENANT,
      url: 'https://epic.odoo.com',
      db: 'epic',
      login: 'eric@epic.com',
      api_key_enc: 'k',
    })
    json2CallMock.mockResolvedValue([{ id: 1, company_id: [10, 'EPIC Communications Inc'] }])

    const scope = await DEFAULT_ODOO_SCOPE_PORTS.resolveOdooScope(TENANT)
    expect(scope).toEqual({
      config: { url: 'https://epic.odoo.com', db: 'epic', apiKey: 'decrypted:k' },
      boundCompanyId: 10,
    })
    expect(json2CallMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://epic.odoo.com', db: 'epic' }),
      'res.users',
      'search_read',
      expect.objectContaining({ domain: [['login', '=', 'eric@epic.com']] }),
    )
  })

  it('denies when Odoo is unreachable while resolving the bound company (fail closed, not assume ok)', async () => {
    odooBindingMock.findUnique.mockResolvedValue({
      tenant_id: TENANT,
      url: 'https://epic.odoo.com',
      db: 'epic',
      login: 'eric@epic.com',
      api_key_enc: 'k',
    })
    json2CallMock.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const scope = await DEFAULT_ODOO_SCOPE_PORTS.resolveOdooScope(TENANT)
    expect(scope).toBeNull()
  })

  it('denies when res.users returns no row for the bound login', async () => {
    odooBindingMock.findUnique.mockResolvedValue({
      tenant_id: TENANT,
      url: 'https://epic.odoo.com',
      db: 'epic',
      login: 'ghost@epic.com',
      api_key_enc: 'k',
    })
    json2CallMock.mockResolvedValue([])
    const scope = await DEFAULT_ODOO_SCOPE_PORTS.resolveOdooScope(TENANT)
    expect(scope).toBeNull()
  })
})

describe('readLeadCompanyId', () => {
  const config = { url: 'https://epic.odoo.com', db: 'epic', apiKey: 'k' }

  it('reads the crm.lead\'s own company_id directly from Odoo', async () => {
    json2CallMock.mockResolvedValue([{ id: 1642, company_id: [10, 'EPIC Communications Inc'] }])
    const companyId = await DEFAULT_ODOO_SCOPE_PORTS.readLeadCompanyId(config, '1642')
    expect(companyId).toBe(10)
    expect(json2CallMock).toHaveBeenCalledWith(
      config,
      'crm.lead',
      'search_read',
      expect.objectContaining({ domain: [['id', '=', 1642]] }),
    )
  })

  it('returns null when the lead does not exist', async () => {
    json2CallMock.mockResolvedValue([])
    const companyId = await DEFAULT_ODOO_SCOPE_PORTS.readLeadCompanyId(config, '999999')
    expect(companyId).toBeNull()
  })

  it('returns null (never throws) when Odoo is unreachable', async () => {
    json2CallMock.mockRejectedValue(new Error('timeout'))
    const companyId = await DEFAULT_ODOO_SCOPE_PORTS.readLeadCompanyId(config, '1642')
    expect(companyId).toBeNull()
  })

  it('returns null for a non-numeric leadId rather than sending it to Odoo', async () => {
    const companyId = await DEFAULT_ODOO_SCOPE_PORTS.readLeadCompanyId(config, 'not-a-number')
    expect(companyId).toBeNull()
    expect(json2CallMock).not.toHaveBeenCalled()
  })
})
