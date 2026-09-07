import { describe, expect, it, vi } from 'vitest'

import {
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_LENGTH,
  buildSearchDomain,
  parseSearchTerm,
  searchCustomers,
} from './customer-search'
import { PARTNER_FIELDS, type OdooCaller } from './customer-sources'

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

const caller = (rows: unknown[] = [PARTNER]): OdooCaller => vi.fn(async () => rows)

/* ── the term ──────────────────────────────────────────────────────────────*/

describe('the kind of search is decided from the shape, not by the caller', () => {
  it('reads a bare positive integer as a partner id', () => {
    expect(parseSearchTerm('42')).toEqual({ kind: 'partner_id', value: '42' })
  })

  it('reads an address as an email and lowercases it', () => {
    expect(parseSearchTerm('  Info@Epic.DM ')).toEqual({ kind: 'email', value: 'info@epic.dm' })
  })

  it('reads a formatted number as a phone, normalised to digits', () => {
    expect(parseSearchTerm('+1 (767) 818-3742')).toEqual({ kind: 'phone', value: '17678183742' })
  })

  it('reads anything else as a name', () => {
    expect(parseSearchTerm('EPIC Communications')).toEqual({
      kind: 'name',
      value: 'EPIC Communications',
    })
  })

  it('refuses a term too short to be a search', () => {
    expect(parseSearchTerm('a')).toBeNull()
    expect(parseSearchTerm('   ')).toBeNull()
    expect(parseSearchTerm('')).toBeNull()
    expect(parseSearchTerm(null)).toBeNull()
    expect(MIN_SEARCH_LENGTH).toBeGreaterThanOrEqual(2)
  })

  it('does not mistake a company name containing digits for a phone number', () => {
    expect(parseSearchTerm('Studio 54 Ltd')?.kind).toBe('name')
  })
})

/* ── the domain ────────────────────────────────────────────────────────────*/

describe('each kind maps to exactly one fixed domain', () => {
  it('matches an id exactly, as a number', () => {
    expect(buildSearchDomain({ kind: 'partner_id', value: '42' })).toEqual([['id', '=', 42]])
  })

  it('uses only searchable fields, and only ilike-family operators', () => {
    const domains = [
      buildSearchDomain({ kind: 'partner_id', value: '42' }),
      buildSearchDomain({ kind: 'email', value: 'a@b.co' }),
      buildSearchDomain({ kind: 'phone', value: '17678183742' }),
      buildSearchDomain({ kind: 'name', value: 'EPIC' }),
    ]

    for (const domain of domains) {
      for (const clause of domain as [string, string, unknown][]) {
        expect(['id', 'email', 'phone', 'name']).toContain(clause[0])
        expect(['=', 'ilike', '=ilike']).toContain(clause[1])
      }
    }
  })

  it('never searches a free-text field', () => {
    const serialised = JSON.stringify([
      buildSearchDomain({ kind: 'name', value: 'anything' }),
      buildSearchDomain({ kind: 'email', value: 'a@b.co' }),
    ])
    expect(serialised).not.toMatch(/comment|note|street|description/i)
  })

  it('puts the term in the VALUE position, so it cannot change the query shape', () => {
    const evil = "x'] , ['id','=',1"
    const domain = buildSearchDomain({ kind: 'name', value: evil }) as [string, string, unknown][]

    expect(domain).toHaveLength(1)
    expect(domain[0][0]).toBe('name')
    expect(domain[0][2]).toBe(evil)
  })
})

/* ── the read ──────────────────────────────────────────────────────────────*/

describe('the search read', () => {
  it('asks res.partner search_read with the reviewed field allowlist', async () => {
    const call = caller()
    await searchCustomers(call, { kind: 'name', value: 'EPIC' }, 25, ODOO)

    expect(call).toHaveBeenCalledWith('res.partner', 'search_read', {
      domain: [['name', 'ilike', 'EPIC']],
      fields: [...PARTNER_FIELDS],
      order: 'name asc',
      limit: 25,
    })
  })

  it('imposes its own ceiling whatever the caller asks for', async () => {
    const call = caller()
    await searchCustomers(call, { kind: 'name', value: 'a b' }, 5000, ODOO)

    const args = (call as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as {
      limit: number
    }
    expect(args.limit).toBeLessThanOrEqual(MAX_SEARCH_RESULTS)
  })

  it('returns only the reviewed fields, plus a link', async () => {
    const [row] = await searchCustomers(caller(), { kind: 'name', value: 'EPIC' }, 25, ODOO)

    expect(row.id).toBe(42)
    expect(row.name).toBe('EPIC Communications Inc')
    expect(row.link).toBe(`${ODOO}/odoo/res.partner/42`)
    expect(Object.keys(row).sort()).toEqual(
      [
        'active',
        'city',
        'companyName',
        'customerSince',
        'email',
        'id',
        'isCompany',
        'link',
        'name',
        'phone',
        'street',
        'link',
      ]
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort(),
    )
  })

  it('offers no link when the instance URL is not configured', async () => {
    const [row] = await searchCustomers(caller(), { kind: 'name', value: 'EPIC' }, 25, null)
    expect(row.link).toBeNull()
  })

  it('answers with nothing when the directory has no match', async () => {
    expect(await searchCustomers(caller([]), { kind: 'name', value: 'zzz' }, 25, ODOO)).toEqual([])
  })

  it('lets a failure THROW, so a route can tell unavailable from empty', async () => {
    const failing: OdooCaller = async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:443')
    }
    await expect(searchCustomers(failing, { kind: 'name', value: 'EPIC' }, 25, ODOO)).rejects.toThrow()
  })

  it('carries no fixture customer', async () => {
    const rows = await searchCustomers(caller([]), { kind: 'name', value: 'test' }, 25, ODOO)
    expect(rows).toHaveLength(0)
  })
})

describe('a Dominican phone number is not an account id', () => {
  /*
    Measured on PRODUCTION 2026-09-07, which is why these are exact strings and
    not invented ones: `767`, `7674490001` and `1767449` all came back
    `term=partner_id, count=0`, while `+17674490001` came back `term=phone`.
    The owner types a local number the way anyone in Dominica writes it, and
    the console told him he had no such customer.

    Note what the control below establishes: this was NEVER about 767.
    `5551234567` was misclassified identically. Any all-digit input was read as
    an account id; 767 only guarantees it hits every Dominican customer.
  */
  const digitsOnly = ['7674490001', '1767449', '17678183742']

  it('treats a long bare number as EITHER an id or a phone, never only an id', () => {
    for (const q of digitsOnly) {
      expect(parseSearchTerm(q)).toEqual({ kind: 'partner_id_or_phone', value: q })
    }
  })

  it('CONTROL — the bug was never 767-specific', () => {
    // A non-Dominican number of the same shape must take the same path. If
    // this ever diverges, someone has special-cased a country instead of
    // fixing the classification.
    expect(parseSearchTerm('5551234567')).toEqual({ kind: 'partner_id_or_phone', value: '5551234567' })
  })

  it('asks BOTH questions in one domain, so either kind of number answers', () => {
    const domain = buildSearchDomain({ kind: 'partner_id_or_phone', value: '7674490001' })
    // Odoo prefix notation: '|' applies to the next two leaves.
    expect(domain[0]).toBe('|')
    expect(domain).toContainEqual(['id', '=', 7674490001])
    expect(domain).toContainEqual(['phone', 'ilike', '7674490001'])
  })

  it('a SHORT bare integer is still just an account id', () => {
    // The positive control for the rule above: below the phone threshold there
    // is no phone reading to disambiguate, so nothing changes. Without this,
    // "everything numeric became partner_id_or_phone" would also pass.
    expect(parseSearchTerm('42')).toEqual({ kind: 'partner_id', value: '42' })
  })

  it('a formatted phone is still unambiguously a phone', () => {
    expect(parseSearchTerm('+1 767-449-0001')).toEqual({ kind: 'phone', value: '17674490001' })
  })

  it('an email and a name are untouched by any of this', () => {
    expect(parseSearchTerm('info@epic.dm')).toEqual({ kind: 'email', value: 'info@epic.dm' })
    expect(parseSearchTerm('EPIC')).toEqual({ kind: 'name', value: 'EPIC' })
  })
})

describe('a term too short is a term that was not asked, and must say so', () => {
  it('still refuses to search below the minimum', () => {
    expect(parseSearchTerm('e')).toBeNull()
  })

  it('CONTROL — one more character and it does search', () => {
    // Without this, "parseSearchTerm returns null" would pass against a
    // function that refuses everything, and the minimum would be unmeasurable.
    expect(parseSearchTerm('ep')).toEqual({ kind: 'name', value: 'ep' })
    expect(MIN_SEARCH_LENGTH).toBe(2)
  })
})
