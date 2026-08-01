'use client'

/**
 * The controller. Fetches, holds the query, and decides nothing.
 *
 * `empty` and `unavailable` arrive from the server already distinguished. The
 * only judgement made here is for a fetch that never returned at all — and that
 * becomes `unavailable`, because we did not ask, so we did not learn that the
 * customer is absent.
 */

import { useCallback, useState } from 'react'

import type { CustomerSearchResult } from '@/lib/context/customer-search'

import { CustomersView, type CustomersSearchState } from './customers-view'

interface SearchResponse {
  state?: string
  count?: number
  results?: CustomerSearchResult[]
  reason?: string | null
  retryable?: boolean
}

export function CustomersSearch() {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<CustomersSearchState>('idle')
  const [results, setResults] = useState<readonly CustomerSearchResult[]>([])
  const [reason, setReason] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)

  const run = useCallback(
    async (term: string) => {
      const trimmed = term.trim()
      if (!trimmed) {
        setState('idle')
        setResults([])
        setReason(null)
        return
      }

      setState((current) => (current === 'available' ? 'retrying' : 'loading'))
      setReason(null)

      try {
        const res = await fetch(`/api/v1/customers/search?q=${encodeURIComponent(trimmed)}`, {
          cache: 'no-store',
        })

        if (res.status === 403) {
          setResults([])
          setReason(null)
          return setState('forbidden')
        }
        if (res.status === 401) {
          setResults([])
          setReason('Your session could not be confirmed. Reload the page to sign in again.')
          return setState('error')
        }
        if (!res.ok) {
          setResults([])
          setReason('The customer directory could not be searched.')
          setRetryable(true)
          return setState('unavailable')
        }

        const body = (await res.json()) as SearchResponse
        setResults(body.results ?? [])
        setReason(body.reason ?? null)
        setRetryable(body.retryable === true)
        setState(
          body.state === 'available' ? 'available' : body.state === 'unavailable' ? 'unavailable' : 'empty',
        )
      } catch {
        // We never got an answer, so we did NOT learn that there is no such
        // customer. This is the branch that must never become `empty`.
        setResults([])
        setReason('The customer directory could not be reached, so this search did not run.')
        setRetryable(true)
        setState('unavailable')
      }
    },
    [],
  )

  return (
    <CustomersView
      query={query}
      state={state}
      results={results}
      reason={reason}
      retryable={retryable}
      onQueryChange={setQuery}
      onSubmit={() => void run(query)}
      onRetry={() => void run(query)}
    />
  )
}
