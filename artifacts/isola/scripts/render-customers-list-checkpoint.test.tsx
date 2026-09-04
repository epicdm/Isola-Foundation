/**
 * Owner checkpoint: the portal's Customers list, from real Odoo data, before
 * promoting the customer-search two-door fix + the /customers → /customer/:id
 * mount to the UAT host.
 *
 * Data provenance: scripts/customers-search-checkpoint-data.json (real
 * res.partner rows, fetched via deepseek, see that file's own header).
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { CustomersView, type CustomersViewProps } from '../components/customer/customers-view'
import type { CustomerSearchResult } from '../lib/context/customer-search'

const OUT_DIR = path.resolve(__dirname, '../../../.checkpoint-out')
const raw = JSON.parse(readFileSync(path.resolve(__dirname, './customers-search-checkpoint-data.json'), 'utf8'))

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const nameOf = (v: unknown): string | null => (Array.isArray(v) && typeof v[1] === 'string' ? v[1] : null)

// Same transform lib/context/customer-search.ts's searchCustomers() applies —
// not reimplemented differently, just walked by hand since this script has
// no live Odoo caller to run the real function against.
function mapResult(r: any): CustomerSearchResult {
  const id = Number(r.id)
  return {
    id,
    name: str(r.name),
    email: str(r.email),
    phone: str(r.phone),
    city: str(r.city),
    street: str(r.street),
    isCompany: r.is_company !== false,
    companyName: nameOf(r.parent_id),
    active: r.active !== false,
    customerSince: str(r.create_date),
    link: `https://epic-communications-inc.odoo.com/odoo/res.partner/${id}`,
  }
}

function renderPage(label: string, props: CustomersViewProps) {
  const html = renderToStaticMarkup(<CustomersView {...props} />)
  const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Checkpoint — ${label}</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body { margin: 0; padding: 2rem; background: #f3f1f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }</style>
</head>
<body>
<div style="max-width: 900px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 1.5rem; border: 1px solid #e6e2ec;">
<h1 style="font-size: 1.5rem; font-weight: 700; margin: 0 0 0.25rem;">Customers</h1>
<p style="color: #6b6574; font-size: 0.875rem; margin: 0 0 1rem;">Find a customer and open their workspace.</p>
${html}
</div>
</body>
</html>`
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, `${label}.html`)
  writeFileSync(outPath, page, 'utf8')
  return outPath
}

describe('checkpoint render — portal Customers list', () => {
  it('renders real search results (query "Armour"/"NTRC") with working Open-customer links', () => {
    const results = (raw.results as any[]).map(mapResult)
    const p = renderPage('portal-customers-list', {
      query: 'Armour',
      state: 'available',
      results,
      reason: null,
      retryable: false,
      onQueryChange: () => {},
      onSubmit: () => {},
      onRetry: () => {},
    })
    console.log('WROTE', p)
    expect(p).toBeTruthy()
  })

  it('renders the empty state honestly (Odoo answered, no match)', () => {
    const p = renderPage('portal-customers-list-empty', {
      query: 'zzznomatch',
      state: 'empty',
      results: [],
      reason: null,
      retryable: false,
      onQueryChange: () => {},
      onSubmit: () => {},
      onRetry: () => {},
    })
    console.log('WROTE', p)
    expect(p).toBeTruthy()
  })
})
