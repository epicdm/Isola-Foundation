/**
 * findCustomerByPhone() — the raw-`phone` fallback.
 *
 * def-odoo-phone-sanitized-false-for-767818-range: `phone_sanitized` is the
 * BOOLEAN `false`, not a phone string, for the entire 767-818 exchange
 * (confirmed live). The two existing stages both filter on that field, so
 * for every customer in that exchange they always return nothing,
 * regardless of whether the customer exists. This suite proves the third,
 * raw-`phone` stage makes those customers resolvable, WITHOUT weakening
 * refuse-on-ambiguity -- every positive case is paired with a control
 * proving the earlier stages are what actually answered when they can.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findCustomerByPhone, type OdooCustomer } from './odoo'

const CONFIG = { url: 'https://tenant.odoo.com', apiKey: 'test-key', db: 'tenant' }

const partner = (over: Partial<OdooCustomer> = {}): OdooCustomer => ({
  id: 1,
  name: 'Test Partner',
  email: null,
  phone: null,
  phone_sanitized: null,
  street: null,
  city: null,
  is_company: false,
  ...over,
})

function jsonResponse(body: unknown) {
  return Promise.resolve({
    headers: { get: () => 'application/json' },
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response)
}

/** Reads the `domain` the call under test sent, so a mock can branch by stage. */
function domainOf(callArgs: unknown[]): unknown[] {
  const [, opts] = callArgs as [string, { body: string }]
  return (JSON.parse(opts.body).domain ?? []) as unknown[]
}

describe('findCustomerByPhone — raw-phone fallback for phone_sanitized=false', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('too-short input never reaches the network at all', async () => {
    const result = await findCustomerByPhone(CONFIG, '12345')
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('CONTROL: a customer WITH a real phone_sanitized is found by the first stage, never reaching the raw-phone fallback', async () => {
    fetchMock.mockImplementation((...args: unknown[]) => {
      const domain = domainOf(args)
      if (JSON.stringify(domain).includes('phone_sanitized') && JSON.stringify(domain).includes('=')) {
        return jsonResponse([partner({ id: 5, name: 'Marigot Hardware', phone: '+17671234567', phone_sanitized: '+17671234567' })])
      }
      throw new Error('should not reach any later stage')
    })

    const result = await findCustomerByPhone(CONFIG, '17671234567')
    expect(result?.id).toBe(5)
  })

  it('a 767-818 customer, unresolvable via phone_sanitized (both stages return empty), is found via raw phone', async () => {
    fetchMock.mockImplementation((...args: unknown[]) => {
      const domain = domainOf(args)
      const asStr = JSON.stringify(domain)
      if (asStr.includes('phone_sanitized')) return jsonResponse([]) // both phone_sanitized stages: nothing
      if (asStr.includes('"phone"')) {
        return jsonResponse([
          partner({ id: 42, name: '767-818 Customer', phone: '(767) 818-9012' }),
        ])
      }
      throw new Error(`unexpected domain ${asStr}`)
    })

    const result = await findCustomerByPhone(CONFIG, '17678189012')
    expect(result?.id).toBe(42)
    expect(result?.name).toBe('767-818 Customer')
  })

  it('matches despite formatting differences between the search input and the stored phone (parens, spaces, dashes)', async () => {
    fetchMock.mockImplementation((...args: unknown[]) => {
      const domain = domainOf(args)
      const asStr = JSON.stringify(domain)
      if (asStr.includes('phone_sanitized')) return jsonResponse([])
      if (asStr.includes('"phone"')) {
        return jsonResponse([partner({ id: 7, phone: '767 818 5555' })])
      }
      throw new Error(`unexpected domain ${asStr}`)
    })

    const result = await findCustomerByPhone(CONFIG, '+1 (767) 818-5555')
    expect(result?.id).toBe(7)
  })

  it('REFUSE-ON-AMBIGUITY: two candidates whose phone strictly matches the same last-10-digits are refused, not guessed', async () => {
    fetchMock.mockImplementation((...args: unknown[]) => {
      const domain = domainOf(args)
      const asStr = JSON.stringify(domain)
      if (asStr.includes('phone_sanitized')) return jsonResponse([])
      if (asStr.includes('"phone"')) {
        return jsonResponse([
          partner({ id: 1, phone: '767-818-4444' }),
          partner({ id: 2, phone: '+1 767 818 4444' }), // same number, different formatting -- still a real duplicate
        ])
      }
      throw new Error(`unexpected domain ${asStr}`)
    })

    const result = await findCustomerByPhone(CONFIG, '17678184444')
    expect(result).toBeNull()
  })

  it('POSITIVE CONTROL for the ambiguity guard: a broad ilike candidate list with only ONE strict match still resolves', async () => {
    fetchMock.mockImplementation((...args: unknown[]) => {
      const domain = domainOf(args)
      const asStr = JSON.stringify(domain)
      if (asStr.includes('phone_sanitized')) return jsonResponse([])
      if (asStr.includes('"phone"')) {
        return jsonResponse([
          partner({ id: 1, phone: '767-818-4444' }), // strict match
          partner({ id: 2, phone: '999-000-4444' }), // shares the last-4 digits used for the loose ilike, but NOT the full last-10
        ])
      }
      throw new Error(`unexpected domain ${asStr}`)
    })

    const result = await findCustomerByPhone(CONFIG, '17678184444')
    expect(result?.id).toBe(1)
  })

  it('genuinely no match anywhere returns null, not a guess', async () => {
    fetchMock.mockImplementation(() => jsonResponse([]))
    const result = await findCustomerByPhone(CONFIG, '17679999999')
    expect(result).toBeNull()
  })

  it('a candidate with a null phone field is never treated as a match', async () => {
    fetchMock.mockImplementation((...args: unknown[]) => {
      const domain = domainOf(args)
      const asStr = JSON.stringify(domain)
      if (asStr.includes('phone_sanitized')) return jsonResponse([])
      if (asStr.includes('"phone"')) {
        return jsonResponse([partner({ id: 9, phone: null })])
      }
      throw new Error(`unexpected domain ${asStr}`)
    })

    const result = await findCustomerByPhone(CONFIG, '17678181111')
    expect(result).toBeNull()
  })
})
