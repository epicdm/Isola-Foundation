"use client"

/**
 * Recent Work: the URL, the hook and the view joined together.
 *
 * The address bar is the single source of truth for the filters. Holding them in
 * component state as well would give two places that can disagree, and the one a
 * reader shares, refreshes or navigates back to is always the URL.
 *
 * router.replace rather than push: changing a filter is not a place in the
 * history a reader wants to walk back through one select at a time. Back should
 * leave this screen, and refresh should return to exactly this list.
 */

import { useCallback, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { RecentWorkView } from "./recent-work-view"
import { useActivityFeed } from "./use-activity-feed"
import { EMPTY_FILTERS, filtersFromParams, filtersToParams, type ActivityFilters } from "./filters"

export function RecentWork() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams])
  const { state, refresh, loadMore } = useActivityFeed(filters)

  const apply = useCallback(
    (next: ActivityFilters) => {
      const query = filtersToParams(next).toString()
      router.replace(query ? "/activity?" + query : "/activity", { scroll: false })
    },
    [router],
  )

  const clear = useCallback(() => apply(EMPTY_FILTERS), [apply])

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
    />
  )
}
