import { describe, expect, it, vi } from 'vitest'

import {
  buildContextBundle,
  CONTEXT_BUNDLE_VERSION,
  MAX_SECTION_LIMIT,
  type BundleAdapter,
} from './context-bundle'

const NOW = new Date('2026-07-31T12:00:00Z')

function adapter(
  section: BundleAdapter['section'],
  over: Partial<BundleAdapter> = {},
): BundleAdapter {
  return {
    section,
    allowedRoles: ['staff', 'manager', 'owner'],
    load: async () => ({
      data: [`${section}-row`],
      provenance: { source: `odoo.${section}`, fetchedAt: NOW, stale: false },
      nextCursor: null,
    }),
    ...over,
  }
}

const REQ = {
  correlationId: 'c-1',
  companyId: 'co-1',
  role: 'staff',
  objectType: 'customer',
  objectId: 'cust-1',
}

const ports = (adapters: BundleAdapter[]) => ({
  adapters,
  workspaceUrlFor: (t: string, id: string) => `/workspace/${t}/${id}`,
  now: () => NOW,
})

describe('context-bundle — assembly and provenance', () => {
  it('returns sections with the source and time that produced them', async () => {
    const b = await buildContextBundle(REQ, ports([adapter('customer'), adapter('invoices')]))
    expect(b.version).toBe(CONTEXT_BUNDLE_VERSION)
    const customer = b.sections.customer
    expect(customer?.status).toBe('ok')
    if (customer?.status !== 'ok') return
    expect(customer.provenance.source).toBe('odoo.customer')
    expect(customer.provenance.fetchedAt).toEqual(NOW)
  })

  it('carries a workspace url', async () => {
    const b = await buildContextBundle(REQ, ports([adapter('customer')]))
    expect(b.workspaceUrl).toBe('/workspace/customer/cust-1')
  })

  it('fetches only the sections asked for', async () => {
    const invoices = vi.fn(adapter('invoices').load)
    const b = await buildContextBundle(
      { ...REQ, sections: ['customer'] },
      ports([adapter('customer'), adapter('invoices', { load: invoices })]),
    )
    expect(b.sections.customer?.status).toBe('ok')
    expect(b.sections.invoices).toBeUndefined()
    expect(invoices).not.toHaveBeenCalled()
  })
})

describe('context-bundle — a partial outage is a partial answer', () => {
  it('one dead adapter does not blank the bundle', async () => {
    const dead = adapter('invoices', {
      load: async () => {
        throw new Error('odoo timeout')
      },
    })
    const b = await buildContextBundle(REQ, ports([adapter('customer'), dead]))
    expect(b.sections.customer?.status).toBe('ok')
    expect(b.sections.invoices?.status).toBe('unavailable')
    expect(b.degraded).toEqual(['invoices'])
  })

  it('NEVER represents an outage as empty data', async () => {
    const dead = adapter('invoices', {
      load: async () => {
        throw new Error('odoo timeout')
      },
    })
    const b = await buildContextBundle(REQ, ports([dead]))
    const s = b.sections.invoices
    expect(s?.status).toBe('unavailable')
    // The distinction that matters: an outage must not be readable as "no invoices".
    expect(JSON.stringify(s)).toContain('odoo timeout')
    expect(s).not.toHaveProperty('data')
  })

  it('reports staleness rather than hiding it', async () => {
    const cached = adapter('customer', {
      load: async () => ({
        data: ['cached'],
        provenance: { source: 'cache', fetchedAt: NOW, stale: true },
      }),
    })
    const b = await buildContextBundle(REQ, ports([cached]))
    const s = b.sections.customer
    expect(s?.status).toBe('ok')
    if (s?.status !== 'ok') return
    expect(s.provenance.stale).toBe(true)
  })
})

describe('context-bundle — permissions do not leak existence', () => {
  it('forbidden sections say only forbidden', async () => {
    const ownerOnly = adapter('invoices', { allowedRoles: ['owner'] })
    const b = await buildContextBundle(REQ, ports([ownerOnly]))
    const s = b.sections.invoices
    expect(s).toEqual({ status: 'forbidden' })
    // No data, no reason, no source: nothing to infer from.
    expect(Object.keys(s ?? {})).toEqual(['status'])
  })

  it('does not call the adapter at all when the role is not allowed', async () => {
    const load = vi.fn(adapter('invoices').load)
    await buildContextBundle(REQ, ports([adapter('invoices', { allowedRoles: ['owner'], load })]))
    expect(load).not.toHaveBeenCalled()
  })

  it('a forbidden section is not counted as degraded', async () => {
    const b = await buildContextBundle(
      REQ,
      ports([adapter('invoices', { allowedRoles: ['owner'] })]),
    )
    expect(b.degraded).toEqual([])
  })
})

describe('context-bundle — pagination is bounded', () => {
  it('clamps the limit so one caller cannot ask for everything', async () => {
    let seen = 0
    const spy = adapter('activities', {
      load: async ({ limit }) => {
        seen = limit
        return { data: [], provenance: { source: 's', fetchedAt: NOW, stale: false } }
      },
    })
    await buildContextBundle({ ...REQ, limit: 10_000 }, ports([spy]))
    expect(seen).toBe(MAX_SECTION_LIMIT)
  })

  it('passes the cursor through and returns the next one', async () => {
    let seenCursor: string | null | undefined
    const spy = adapter('activities', {
      load: async ({ cursor }) => {
        seenCursor = cursor
        return {
          data: [],
          provenance: { source: 's', fetchedAt: NOW, stale: false },
          nextCursor: 'page-2',
        }
      },
    })
    const b = await buildContextBundle(
      { ...REQ, cursors: { activities: 'page-1' } },
      ports([spy]),
    )
    expect(seenCursor).toBe('page-1')
    const s = b.sections.activities
    expect(s?.status === 'ok' && s.nextCursor).toBe('page-2')
  })
})
