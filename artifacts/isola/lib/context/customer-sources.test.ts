import { describe, expect, it, vi } from 'vitest'

import { OdooApiError, OdooNoApiError } from '@/engines/odoo'
import { LEAD_FIELDS } from '@/lib/customer-tools/lookup'

import { BUNDLE_SECTIONS, buildContextBundle, type BundleSection } from './context-bundle'
import {
  CONTACT_FIELDS,
  ISSUE_FIELDS,
  MAX_SECTION_ROWS,
  PARTNER_FIELDS,
  TASKS_NOT_PROVEN_REASON,
  UNIDENTIFIED_SECTIONS,
  buildCustomerAdapters,
  odooDeepLink,
  parseCustomerId,
  readContacts,
  readCustomer,
  readIssues,
  readOpportunities,
  sanitiseOdooFailure,
  type OdooCaller,
} from './customer-sources'

const NOW = new Date('2026-08-01T18:00:00Z')
const CUSTOMER = 605
const BASE = 'https://tenant.odoo.com'

/** Records every call so the tests can assert what was SENT, not just returned. */
function recorder(reply: (model: string) => unknown) {
  const calls: { model: string; method: string; params: Record<string, unknown> }[] = []
  const call: OdooCaller = async (model, method, params) => {
    calls.push({ model, method, params })
    return reply(model)
  }
  return { call, calls }
}

const PARTNER_ROW = {
  id: CUSTOMER,
  name: 'Brent Symes',
  email: 'brent@example.test',
  phone: '+17671234567',
  city: 'Roseau',
  street: 'Great George St',
  is_company: false,
  parent_id: [12, 'Symes Holdings'],
  active: true,
}

function adapters(call: OdooCaller, odooBaseUrl: string | null = BASE) {
  return buildCustomerAdapters({ call, odooBaseUrl, now: () => NOW })
}

function bundle(call: OdooCaller, role = 'manager') {
  return buildContextBundle(
    {
      correlationId: 'corr-1',
      companyId: 'tenant-1',
      role,
      objectType: 'customer',
      objectId: String(CUSTOMER),
    },
    {
      adapters: adapters(call),
      workspaceUrlFor: () => `${BASE}/odoo/res.partner/${CUSTOMER}`,
      now: () => NOW,
    },
  )
}

describe('bounded readers — the allowlist is enforced, not merely written down', () => {
  it('the customer read is keyed on id, fixed-field and limited to one', async () => {
    const { call, calls } = recorder(() => [PARTNER_ROW])
    const out = await readCustomer(call, CUSTOMER)

    expect(calls[0].model).toBe('res.partner')
    expect(calls[0].method).toBe('search_read')
    expect(calls[0].params.domain).toEqual([['id', '=', CUSTOMER]])
    expect(calls[0].params.fields).toEqual([...PARTNER_FIELDS])
    expect(calls[0].params.limit).toBe(1)

    expect(out[0]).toMatchObject({ id: CUSTOMER, name: 'Brent Symes', companyName: 'Symes Holdings' })
  })

  it('contacts are the customer’s OWN children and nothing broader', async () => {
    const { call, calls } = recorder(() => [])
    await readContacts(call, CUSTOMER, 10)

    // A name- or company-based match would pull in unrelated partners.
    expect(calls[0].params.domain).toEqual([
      ['parent_id', '=', CUSTOMER],
      ['active', '=', true],
    ])
    expect(calls[0].params.fields).toEqual([...CONTACT_FIELDS])
  })

  it('opportunities use the reviewed LEAD_FIELDS allowlist, unwidened', async () => {
    const { call, calls } = recorder(() => [])
    await readOpportunities(call, CUSTOMER, 10)

    expect(calls[0].model).toBe('crm.lead')
    expect(calls[0].params.domain).toEqual([['partner_id', '=', CUSTOMER]])
    // Imported, not restated — this is the assertion that stops it drifting.
    expect(calls[0].params.fields).toEqual([...LEAD_FIELDS])
    expect(calls[0].params.order).toBe('write_date desc')
  })

  it('issues are customer-keyed with a fixed field list', async () => {
    const { call, calls } = recorder(() => [])
    await readIssues(call, CUSTOMER, 10)

    expect(calls[0].model).toBe('helpdesk.ticket')
    expect(calls[0].params.domain).toEqual([['partner_id', '=', CUSTOMER]])
    expect(calls[0].params.fields).toEqual([...ISSUE_FIELDS])
  })

  it('a caller cannot ask for more rows than the ceiling', async () => {
    const { call, calls } = recorder(() => [])
    await readContacts(call, CUSTOMER, 100_000)
    expect(calls[0].params.limit).toBe(MAX_SECTION_ROWS)
  })

  it('only a positive integer is accepted as a customer reference', () => {
    expect(parseCustomerId('605')).toBe(605)
    expect(parseCustomerId(605)).toBe(605)
    // Anything that could reach a domain as something other than an id.
    expect(parseCustomerId('0')).toBeNull()
    expect(parseCustomerId('-1')).toBeNull()
    expect(parseCustomerId('1 OR 1=1')).toBeNull()
    expect(parseCustomerId("605']")).toBeNull()
    expect(parseCustomerId('')).toBeNull()
    expect(parseCustomerId(undefined)).toBeNull()
  })
})

describe('failure wording — driver text never reaches a screen', () => {
  it('a raw connection error keeps its host and port out of the sentence', () => {
    const said = sanitiseOdooFailure(new Error('connect ECONNREFUSED 10.1.2.3:8069 db=prod'))
    expect(said).toBe('the source could not be reached')
    expect(said).not.toMatch(/10\.1\.2\.3|8069|db=prod/)
  })

  it('“this plan has no external API” is its own sentence, not “no data”', () => {
    const said = sanitiseOdooFailure(new OdooNoApiError(404))
    expect(said).toContain('does not expose the external API')
    expect(said).not.toMatch(/no data|empty|nothing/i)
  })

  it('a refusal and a timeout are told apart', () => {
    expect(sanitiseOdooFailure(new OdooApiError(403, { message: 'Access Denied for user x' }))).toBe(
      'the source refused the read',
    )
    expect(sanitiseOdooFailure(new Error('operation timed out'))).toBe(
      'the source did not answer in time',
    )
  })
})

describe('deep links — three conditions, or no link', () => {
  it('no base URL means no link, however good the record is', () => {
    expect(odooDeepLink(null, 'res.partner', CUSTOMER)).toBeNull()
    expect(odooDeepLink('', 'res.partner', CUSTOMER)).toBeNull()
  })

  it('no record means no link, however good the base URL is', () => {
    expect(odooDeepLink(BASE, 'res.partner', null)).toBeNull()
    expect(odooDeepLink(BASE, 'res.partner', 0)).toBeNull()
  })

  it('both present builds exactly one shape, with the model escaped', () => {
    expect(odooDeepLink(`${BASE}/`, 'crm.lead', 11)).toBe(`${BASE}/odoo/crm.lead/11`)
  })
})

describe('the bundle — every expected section is present, and states do not blur', () => {
  const EXPECTED: readonly BundleSection[] = [
    'customer',
    'contacts',
    'opportunities',
    'issues',
    'tasks',
    'services',
    'devices',
    'pbx',
    'invoices',
    'notes',
  ]

  it('opportunities is a declared bundle section', () => {
    expect(BUNDLE_SECTIONS).toContain('opportunities')
  })

  it('no expected section is omitted — absence and emptiness are not the same', async () => {
    const { call } = recorder((model) => (model === 'res.partner' ? [PARTNER_ROW] : []))
    const result = await bundle(call)

    for (const section of EXPECTED) {
      expect(Object.keys(result.sections)).toContain(section)
      expect(result.sections[section]).toBeDefined()
    }
  })

  it('a successful read with no rows is empty; a read that threw is unavailable', async () => {
    const { call } = recorder((model) => {
      if (model === 'res.partner') return []
      throw new Error('connect ECONNREFUSED 10.0.0.1:8069')
    })
    const result = await bundle(call)

    // res.partner answered, with nothing.
    expect(result.sections.contacts).toMatchObject({ status: 'ok' })
    expect((result.sections.contacts as { data: unknown[] }).data).toEqual([])

    // crm.lead threw.
    expect(result.sections.opportunities).toMatchObject({ status: 'unavailable' })
    expect(result.sections.opportunities?.status).not.toBe('ok')

    const reason = (result.sections.opportunities as { reason: string }).reason
    expect(reason).toBe('the source could not be reached')
    expect(reason).not.toMatch(/10\.0\.0\.1|8069|ECONNREFUSED/)
  })

  it('one dead source degrades the bundle, it does not blank it', async () => {
    const { call } = recorder((model) => {
      if (model === 'helpdesk.ticket') throw new OdooNoApiError(404)
      return [PARTNER_ROW]
    })
    const result = await bundle(call)

    expect(result.sections.customer).toMatchObject({ status: 'ok' })
    expect(result.sections.issues).toMatchObject({ status: 'unavailable' })
    expect(result.degraded).toContain('issues')
    expect(result.degraded).not.toContain('customer')
  })

  it('the five unidentified sections are unavailable, individually, and never empty', async () => {
    const { call } = recorder(() => [PARTNER_ROW])
    const result = await bundle(call)

    for (const section of UNIDENTIFIED_SECTIONS) {
      const got = result.sections[section]
      expect(got, section).toMatchObject({ status: 'unavailable' })
      expect(got?.status, section).not.toBe('ok')
      const reason = (got as { reason: string }).reason
      expect(reason, section).toContain('not connected')
      // Says only that it is not connected. No stack, no speculation.
      expect(reason, section).not.toMatch(/at .*\(|Error:|undefined|null/)
    }
    expect(UNIDENTIFIED_SECTIONS).toEqual(['services', 'devices', 'pbx', 'invoices', 'notes'])
  })

  it('tasks are unavailable and the reason names the missing relationship', async () => {
    // Pins the RULE. project.task carries no proven customer linkage in this
    // codebase, so the section refuses rather than guessing a domain — the risk
    // is not an empty list, it is one customer's work under another's name.
    const { call } = recorder(() => [PARTNER_ROW])
    const result = await bundle(call)

    expect(result.sections.tasks).toMatchObject({ status: 'unavailable' })
    expect((result.sections.tasks as { reason: string }).reason).toBe(TASKS_NOT_PROVEN_REASON)
    expect(TASKS_NOT_PROVEN_REASON).toContain('project.task')
  })

  it('an unusable customer reference is refused before it can reach a domain', async () => {
    const { call, calls } = recorder(() => [PARTNER_ROW])
    const result = await buildContextBundle(
      {
        correlationId: 'c',
        companyId: 'tenant-1',
        role: 'manager',
        objectType: 'customer',
        objectId: "605' OR 1=1",
      },
      { adapters: adapters(call), workspaceUrlFor: () => '', now: () => NOW },
    )

    expect(result.sections.customer).toMatchObject({
      status: 'unavailable',
      reason: 'the customer reference is not usable',
    })
    // The decisive part: nothing was sent to Odoo at all.
    expect(calls).toHaveLength(0)
  })

  it('a role that may not see business context gets forbidden, disclosing nothing', async () => {
    const { call } = recorder(() => [PARTNER_ROW])
    const result = await bundle(call, 'staff')

    const got = result.sections.customer
    expect(got).toEqual({ status: 'forbidden' })
    // No reason, no provenance, no count — each would confirm the record exists.
    expect(got).not.toHaveProperty('reason')
    expect(got).not.toHaveProperty('provenance')
    expect(result.degraded).not.toContain('customer')
  })

  it('every served section carries provenance naming the system that answered', async () => {
    const { call } = recorder(() => [PARTNER_ROW])
    const result = await bundle(call)

    expect(result.sections.customer).toMatchObject({
      provenance: { source: 'odoo:res.partner', fetchedAt: NOW, stale: false },
    })
    expect(result.sections.opportunities).toMatchObject({
      provenance: { source: 'odoo:crm.lead' },
    })
  })

  it('nothing is returned that the source did not say', async () => {
    // Odoo answers with one partner and nothing else; no section may invent rows.
    const { call } = recorder((model) => (model === 'res.partner' ? [PARTNER_ROW] : []))
    const result = await bundle(call)

    const served = Object.entries(result.sections).filter(([, v]) => v?.status === 'ok')
    for (const [name, value] of served) {
      const data = (value as { data: unknown }).data
      expect(Array.isArray(data), name).toBe(true)
    }
    expect((result.sections.opportunities as { data: unknown[] }).data).toEqual([])
    expect((result.sections.issues as { data: unknown[] }).data).toEqual([])
  })
})
