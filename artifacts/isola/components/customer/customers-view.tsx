/**
 * The Customers search screen, as a PURE FUNCTION of its props.
 *
 * Same arrangement as the workspace view: no fetching, no hooks, no router, so
 * renderToStaticMarkup can assert the exact markup a reader is sent in a
 * workspace with no jsdom.
 *
 * THIS SCREEN IS A DOOR, NOT A RECORD
 * ----------------------------------
 * It shows only what is needed to tell two customers apart and open the right
 * one. Everything else about a customer belongs to Customer 360, one navigation
 * away. A search result that grew a context section would be a second, worse
 * copy of the workspace.
 *
 * THE PAIR THAT MATTERS, AGAIN
 * ---------------------------
 * `empty` is "Odoo answered and there is no such customer". `unavailable` is
 * "Odoo did not answer". This is the first thing a staff member does each day,
 * so rendering an outage as "no customer found" tells them the customer is not
 * in the system — and they will act on that.
 */

import type { CustomerSearchResult } from '@/lib/context/customer-search'

export type CustomersSearchState =
  | 'idle'
  | 'loading'
  | 'available'
  | 'empty'
  | 'forbidden'
  | 'unavailable'
  | 'error'
  | 'retrying'

export interface CustomersViewProps {
  query: string
  state: CustomersSearchState
  results: readonly CustomerSearchResult[]
  /** Safe for a screen. Absent for `forbidden`, where a reason is a disclosure. */
  reason: string | null
  retryable: boolean
  onQueryChange: (value: string) => void
  onSubmit: () => void
  onRetry: () => void
}

const STATE_TEXT: Readonly<Record<CustomersSearchState, { marker: string; label: string }>> = {
  idle: { marker: '·', label: 'Ready' },
  loading: { marker: '…', label: 'Searching' },
  available: { marker: '•', label: 'Showing' },
  empty: { marker: '–', label: 'No match' },
  forbidden: { marker: '🔒', label: 'Not available to you' },
  unavailable: { marker: '⟳', label: 'Could not search' },
  error: { marker: '!', label: 'Could not be understood' },
  retrying: { marker: '↻', label: 'Retrying' },
}

/** What a reader is told, per state. No state renders as silence. */
function stateSentence(props: CustomersViewProps): string | null {
  switch (props.state) {
    case 'idle':
      return 'Search by company name, contact name, email address, phone number or Odoo reference.'
    case 'loading':
    case 'retrying':
      return 'Looking for matching customers…'
    case 'empty':
      // Says what was searched and what it means. Never "not a customer".
      return 'That search reached the customer directory and matched nothing. Try a shorter name, or search by phone or email.'
    case 'forbidden':
      return 'You do not have access to the customer directory.'
    case 'unavailable':
      return props.reason ?? 'The customer directory could not be reached, so this search did not run.'
    case 'error':
      return props.reason ?? 'That search could not be understood.'
    case 'available':
      return null
  }
}

export function CustomerResultRow({ result }: { result: CustomerSearchResult }) {
  const secondary = [result.email, result.phone, result.city].filter(Boolean).join(' · ')
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="break-words font-medium">{result.name ?? `Customer ${result.id}`}</span>
          {result.companyName ? (
            <span className="text-xs text-muted-foreground">part of {result.companyName}</span>
          ) : null}
          {!result.active ? (
            <span className="text-xs text-muted-foreground">· archived in the system of record</span>
          ) : null}
        </div>
        {secondary ? <div className="break-words text-xs text-muted-foreground">{secondary}</div> : null}
        <div className="text-xs text-muted-foreground">Odoo reference {result.id}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* The whole purpose of the row. */}
        <a
          href={`/customer/${result.id}`}
          data-open-customer={result.id}
          className="inline-flex min-h-11 items-center rounded-md border px-3 py-2 text-sm font-medium underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Open customer
        </a>
        {/* Only when the API supplied one. Never constructed here. */}
        {result.link ? (
          <a
            href={result.link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center rounded-md px-2 py-2 text-xs underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Open in Odoo
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
    </li>
  )
}

export function CustomersView(props: CustomersViewProps) {
  const text = STATE_TEXT[props.state]
  const sentence = stateSentence(props)

  return (
    <div id="customers" className="flex flex-col gap-5">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          props.onSubmit()
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="customer-search" className="text-sm font-medium">
            Find a customer
          </label>
          <input
            id="customer-search"
            name="q"
            type="search"
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            aria-describedby="customer-search-help"
            className="min-h-11 w-full rounded-md border px-3 py-2 text-sm"
            placeholder="Company name, email, phone or Odoo reference"
          />
          <p id="customer-search-help" className="text-xs text-muted-foreground">
            Searches the customer directory in your business system of record.
          </p>
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium"
        >
          Search
        </button>
      </form>

      <div
        role="status"
        aria-live="polite"
        data-search-state={props.state}
        className="text-sm text-muted-foreground"
      >
        <span aria-hidden="true">{text.marker} </span>
        {text.label}
        {props.state === 'available' ? ` ${props.results.length}` : ''}
        {sentence ? <span> — {sentence}</span> : null}
      </div>

      {/* A failed search offers a retry. An empty one does not, because there
          is nothing to retry: the directory already answered. */}
      {props.state === 'unavailable' && props.retryable ? (
        <div>
          <button
            type="button"
            onClick={props.onRetry}
            className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium"
          >
            Try again
          </button>
        </div>
      ) : null}

      {props.results.length > 0 ? (
        <ul className="flex flex-col rounded-lg border px-4">
          {props.results.map((result) => (
            <CustomerResultRow key={result.id} result={result} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}
