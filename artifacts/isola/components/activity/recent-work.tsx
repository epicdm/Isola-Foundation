"use client"

/**
 * Recent Work: the URL, the hook and the view joined together.
 *
 * The address bar is the single source of truth for the filters. Holding them in
 * component state as well would give two places that can disagree, and the one a
 * reader shares, refreshes or navigates back to is always the URL.
 *
 * PUSH FOR A FILTER CHANGE, NOT REPLACE.
 * This file used to call router.replace for every filter change, on the theory
 * that a reader does not want to walk back through one select at a time. The
 * consequence was worse than the thing it avoided: because a filter change left
 * no history entry, the first press of Back threw the reader off /activity
 * altogether, taking their narrowed list with it. Changing a filter is a new
 * question, and Back has to be able to answer the previous one. The rule now
 * lives in navigation.ts, where it is tested against a simulated history stack
 * instead of being asserted in a comment.
 */

import { useCallback, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { RecentWorkView } from "./recent-work-view"
import { useActivityFeed } from "./use-activity-feed"
import { navigateForFilterChange } from "./navigation"
import {
  EMPTY_FILTERS,
  cursorFromParams,
  filtersFromParams,
  unrecognisedParamKeys,
  type ActivityFilters,
} from "./filters"

export function RecentWork() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams])

  // Parameters this page does not implement. It strips them before building the
  // API query, so the server never sees them and never gets to refuse them --
  // which makes the page the only thing that can tell the reader they were
  // dropped.
  const unknownParams = useMemo(() => unrecognisedParamKeys(searchParams), [searchParams])

  // A position a pasted or bookmarked link arrived with. Read ONCE, for the
  // first load: the controller sends it, and if the server refuses it the list
  // restarts at page one and says so.
  const initialCursor = useMemo(() => cursorFromParams(searchParams), [searchParams])

  const { state, refresh, loadMore } = useActivityFeed(filters, initialCursor)

  const apply = useCallback(
    (next: ActivityFilters) => navigateForFilterChange(router, next),
    [router],
  )

  const clear = useCallback(() => apply(EMPTY_FILTERS), [apply])

  // Rewriting the address with only the parameters this page understands. From
  // the reader's point of view they pressed a button and the address changed,
  // so it is a history stop like any other filter change.
  const clearUnknownParams = useCallback(() => apply(filters), [apply, filters])

  return (
    <RecentWorkView
      state={state}
      filters={filters}
      // Read once per render rather than on a timer. A ticking clock would
      // re-render the whole list every second to turn "5 minutes ago" into
      // "6 minutes ago", and would make the markup impossible to assert.
      now={new Date()}
      onRefresh={refresh}
      onLoadMore={loadMore}
      onFiltersChange={apply}
      onClearFilters={clear}
      unknownParams={unknownParams}
      onClearUnknownParams={clearUnknownParams}
    />
  )
}
