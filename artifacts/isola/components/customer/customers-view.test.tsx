import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { CustomerSearchResult } from '@/lib/context/customer-search'

import { CustomersView, type CustomersSearchState, type CustomersViewProps } from './customers-view'

const noop = () => {}

const result = (over: Partial<CustomerSearchResult> = {}): CustomerSearchResult => ({
  id: 42,
  name: 'EPIC Communications Inc',
  email: 'info@epic.dm',
  phone: '+1 767-818-3742',
  city: 'Roseau',
  street: '8 Castle Street',
  isCompany: true,
  companyName: null,
  active: true,
  customerSince: '2026-01-15',
  link: 'https://tenant.odoo.com/odoo/res.partner/42',
  ...over,
})

const props = (over: Partial<CustomersViewProps> = {}): CustomersViewProps => ({
  query: '',
  state: 'idle',
  results: [],
  reason: null,
  retryable: false,
  onQueryChange: noop,
  onSubmit: noop,
  onRetry: noop,
  ...over,
})

const render = (p: CustomersViewProps) => renderToStaticMarkup(<CustomersView {...p} />)
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

const STATES: CustomersSearchState[] = [
  'idle',
  'loading',
  'available',
  'empty',
  'forbidden',
  'unavailable',
  'error',
  'retrying',
]

describe('every search state says something', () => {
  it.each(STATES)('%s renders words', (state) => {
    const text = textOf(render(props({ state, results: state === 'available' ? [result()] : [] })))
    expect(text.trim().length).toBeGreaterThan(30)
    expect(text).toContain('Find a customer')
  })

  it('marks the state in the markup for assistive technology', () => {
    expect(render(props({ state: 'unavailable' }))).toContain('data-search-state="unavailable"')
    expect(render(props({ state: 'unavailable' }))).toContain('aria-live="polite"')
  })
})

/* ── the pair that matters ─────────────────────────────────────────────────*/

describe('"no match" and "could not ask" read differently', () => {
  it('says an empty result reached the directory', () => {
    const text = textOf(render(props({ state: 'empty' })))

    expect(text).toContain('reached the customer directory and matched nothing')
    expect(text).not.toContain('could not be reached')
  })

  it('never says "no customer" when the directory did not answer', () => {
    const text = textOf(
      render(props({ state: 'unavailable', reason: 'the source could not be reached' })),
    )

    expect(text).toContain('could not be reached')
    expect(text).not.toContain('matched nothing')
    expect(text).not.toMatch(/no customer found/i)
  })

  it('offers a retry for a failed search and not for an empty one', () => {
    expect(render(props({ state: 'unavailable', retryable: true }))).toContain('Try again')
    expect(render(props({ state: 'empty' }))).not.toContain('Try again')
  })

  it('says nothing about how many customers exist when forbidden', () => {
    const text = textOf(render(props({ state: 'forbidden' })))

    expect(text).toContain('do not have access')
    expect(text).not.toMatch(/\d+ customer/i)
  })
})

/* ── the row is a door ─────────────────────────────────────────────────────*/

describe('a result opens the authoritative workspace', () => {
  const html = render(props({ state: 'available', results: [result()] }))

  it('links to /customer/<id>', () => {
    expect(html).toContain('href="/customer/42"')
    expect(html).toContain('data-open-customer="42"')
    expect(textOf(html)).toContain('Open customer')
  })

  it('shows enough to tell two customers apart and no more', () => {
    const text = textOf(html)
    expect(text).toContain('EPIC Communications Inc')
    expect(text).toContain('info@epic.dm')
    expect(text).toContain('Odoo reference 42')
    // Not a second copy of the workspace.
    expect(text).not.toMatch(/opportunit|helpdesk|governed action|invoice/i)
  })

  it('offers the Odoo link only when the API supplied one', () => {
    expect(html).toContain('https://tenant.odoo.com/odoo/res.partner/42')
    const noLink = render(props({ state: 'available', results: [result({ link: null })] }))
    expect(noLink).not.toContain('/odoo/res.partner/42')
    expect(noLink).toContain('href="/customer/42"')
  })

  it('says when a customer is archived rather than hiding it', () => {
    const text = textOf(render(props({ state: 'available', results: [result({ active: false })] })))
    expect(text).toContain('archived in the system of record')
  })
})

/* ── accessibility and touch ───────────────────────────────────────────────*/

describe('the search form is reachable without a mouse', () => {
  const html = render(props())

  it('wires the label to the input', () => {
    expect(html).toContain('for="customer-search"')
    expect(html).toContain('id="customer-search"')
  })

  it('is a real search form with a real submit', () => {
    expect(html).toContain('role="search"')
    expect(html).toContain('type="submit"')
  })

  it('sizes targets for touch in CSS', () => {
    expect(html).toContain('min-h-11')
  })

  it('carries no fixture customer', () => {
    expect(textOf(html)).not.toMatch(/lorem|placeholder|john doe|acme|example\.com/i)
  })
})
