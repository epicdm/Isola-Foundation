/**
 * The write resolver, and the read resolver it must not have changed.
 *
 * Every refusal here carries its positive twin in the same describe: a tenant
 * WITH a binding row is served and reaches getOdooConfig with that row's own
 * fields. Without that control, "a tenant with no binding is refused" would
 * pass just as happily against a resolver that refuses everyone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUniqueMock, getOdooConfigMock, decryptSecretMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  getOdooConfigMock: vi.fn(),
  decryptSecretMock: vi.fn(),
}))

vi.mock('./prisma', () => ({
  prisma: {
    odooBinding: { findUnique: findUniqueMock },
    fiservBinding: { findUnique: vi.fn() },
    bffBinding: { findUnique: vi.fn() },
  },
  default: {},
}))

vi.mock('./tenant-secrets', () => ({ decryptSecret: decryptSecretMock }))

vi.mock('./engines', () => ({
  getOdooConfig: getOdooConfigMock,
  getFiservConfig: vi.fn(),
  getBffConfig: vi.fn(),
}))

import {
  TENANT_NOT_BOUND,
  isOdooBindingRequiredError,
  resolveOdooConfigForTenant,
  resolveOdooConfigForTenantWrite,
} from './engine-bindings'

/** What the deployment's own env named, measured on isola-360-uat. */
const PLATFORM_DEFAULT = {
  url: 'https://epic-communications-inc.odoo.com',
  db: 'epic-communications-inc',
  apiKey: 'the-deployment-key',
}

const BOUND_ROW = {
  tenant_id: 'tenant-bound',
  url: 'https://marigot.odoo.example',
  db: 'marigot',
  api_key_enc: 'ciphertext',
}

beforeEach(() => {
  findUniqueMock.mockReset()
  getOdooConfigMock.mockReset()
  decryptSecretMock.mockReset()
  decryptSecretMock.mockReturnValue('marigot-key')
  // The real getOdooConfig merges overrides over env. Modelled faithfully, so
  // a resolver that passes only SOME fields is visibly inheriting the rest.
  getOdooConfigMock.mockImplementation((overrides?: Record<string, unknown>) => ({
    ...PLATFORM_DEFAULT,
    ...(overrides ?? {}),
  }))
  findUniqueMock.mockResolvedValue(null)
})

describe('a write must name its tenant, not inherit it', () => {
  it('refuses a tenant with no binding row, and never asks for the platform config', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(resolveOdooConfigForTenantWrite('tenant-unbound')).rejects.toThrow(
      /no OdooBinding row/,
    )
    // The assertion that matters: not merely that it threw, but that nothing
    // on the way out touched the deployment's own connection.
    expect(getOdooConfigMock).not.toHaveBeenCalled()
  })

  it('CONTROL: serves a tenant that HAS a binding row, from that row', async () => {
    findUniqueMock.mockResolvedValue(BOUND_ROW)

    const config = await resolveOdooConfigForTenantWrite('tenant-bound')

    expect(getOdooConfigMock).toHaveBeenCalledWith({
      url: BOUND_ROW.url,
      db: BOUND_ROW.db,
      apiKey: 'marigot-key',
    })
    expect(config.url).toBe(BOUND_ROW.url)
    expect(config.db).toBe(BOUND_ROW.db)
    // Named, not inherited.
    expect(config.url).not.toBe(PLATFORM_DEFAULT.url)
    expect(config.db).not.toBe(PLATFORM_DEFAULT.db)
  })

  it('refuses when no tenant id arrives at all, without asking the database', async () => {
    await expect(resolveOdooConfigForTenantWrite(null)).rejects.toThrow(/must name its tenant/)
    await expect(resolveOdooConfigForTenantWrite('   ')).rejects.toThrow(/must name its tenant/)

    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(getOdooConfigMock).not.toHaveBeenCalled()
  })

  it('refuses a half-filled row rather than letting the env supply the other half', async () => {
    findUniqueMock.mockResolvedValue({ ...BOUND_ROW, db: '' })

    await expect(resolveOdooConfigForTenantWrite('tenant-bound')).rejects.toThrow(
      /both a url and a database/,
    )
    expect(getOdooConfigMock).not.toHaveBeenCalled()
  })

  it('refuses a row whose credential decrypts to nothing', async () => {
    findUniqueMock.mockResolvedValue(BOUND_ROW)
    decryptSecretMock.mockReturnValue('')

    await expect(resolveOdooConfigForTenantWrite('tenant-bound')).rejects.toThrow(
      /no usable credential/,
    )
    expect(getOdooConfigMock).not.toHaveBeenCalled()
  })
})

describe('the option form is the same door as the named alias', () => {
  it('refuses an unbound tenant with requireBinding:true', async () => {
    findUniqueMock.mockResolvedValue(null)

    const err = await resolveOdooConfigForTenant('tenant-unbound', { requireBinding: true }).catch(
      (e) => e,
    )

    expect(isOdooBindingRequiredError(err)).toBe(true)
    expect(getOdooConfigMock).not.toHaveBeenCalled()
  })

  it('CONTROL: the SAME call without the option still falls back', async () => {
    findUniqueMock.mockResolvedValue(null)

    const config = await resolveOdooConfigForTenant('tenant-unbound')

    expect(config.url).toBe(PLATFORM_DEFAULT.url)
  })

  it('CONTROL: requireBinding:false is the read behaviour, not a half-guard', async () => {
    findUniqueMock.mockResolvedValue(null)

    const config = await resolveOdooConfigForTenant('tenant-unbound', { requireBinding: false })

    expect(config.url).toBe(PLATFORM_DEFAULT.url)
  })
})

describe('the refusal is its own outcome, not an outage', () => {
  it('is recognisable by name and carries the tenant it was about', async () => {
    findUniqueMock.mockResolvedValue(null)

    const err = await resolveOdooConfigForTenantWrite('tenant-unbound').catch((e) => e)

    expect(isOdooBindingRequiredError(err)).toBe(true)
    expect(err.code).toBe(TENANT_NOT_BOUND)
    expect(err.tenantId).toBe('tenant-unbound')
  })

  it('CONTROL: a database that cannot answer is NOT reported as an unbound tenant', async () => {
    findUniqueMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432'))

    const err = await resolveOdooConfigForTenantWrite('tenant-bound').catch((e) => e)

    // A real failure to ask must not be dressed up as a proven absence.
    expect(isOdooBindingRequiredError(err)).toBe(false)
    expect(String(err.message)).toContain('ECONNREFUSED')
  })
})

describe('reads are unchanged — the fallback the customer list runs on still works', () => {
  it('CONTROL: a tenant with no binding row still falls back to the platform default', async () => {
    findUniqueMock.mockResolvedValue(null)

    const config = await resolveOdooConfigForTenant('tenant-unbound')

    expect(getOdooConfigMock).toHaveBeenCalledWith()
    expect(config.url).toBe(PLATFORM_DEFAULT.url)
    expect(config.db).toBe(PLATFORM_DEFAULT.db)
  })

  it('CONTROL: a read with no tenant id at all still falls back, exactly as before', async () => {
    const config = await resolveOdooConfigForTenant(null)

    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(config.url).toBe(PLATFORM_DEFAULT.url)
  })

  it('a read for a BOUND tenant still prefers the binding row', async () => {
    findUniqueMock.mockResolvedValue(BOUND_ROW)

    const config = await resolveOdooConfigForTenant('tenant-bound')

    expect(config.url).toBe(BOUND_ROW.url)
  })
})
