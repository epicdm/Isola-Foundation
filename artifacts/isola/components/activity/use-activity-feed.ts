"use client"

/**
 * The React shell around feed-controller.
 *
 * Deliberately thin. Every decision -- what a status code means, which rows
 * survive a failure, when a cursor is thrown away -- lives in runLoad, where it
 * can be tested in node without a browser. What is left here is the part that
 * genuinely needs React: holding state, and not firing two requests at once.
 *
 * NOTHING IN THIS FILE RETRIES ON A TIMER. Every load is caused by the reader
 * arriving, changing a filter, pressing Refresh or pressing Load more. That is
 * why an expired session cannot become a loop: there is no loop to get into.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import {
  beginLoad,
  initialFeedState,
  resetForFilters,
  runLoad,
  type FeedState,
  type LoadMode,
} from "./feed-controller"
import { semanticKey, type ActivityFilters } from "./filters"

export interface ActivityFeedController {
  state: FeedState
  refresh(): void
  loadMore(): void
}

export function useActivityFeed(filters: ActivityFilters): ActivityFeedController {
  const [state, setState] = useState<FeedState>(initialFeedState)

  // Refs, not dependencies. A callback that changed identity whenever the state
  // or the filters changed would re-run the effect below and load the same page
  // again on every keystroke in a filter box.
  const stateRef = useRef(state)
  stateRef.current = state
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const inFlight = useRef(false)

  const load = useCallback(async (mode: LoadMode) => {
    // The guard that makes a double-pressed Load more harmless. The button is
    // also disabled while busy, but a disabled button is a UI promise and this
    // is the one that actually holds.
    if (inFlight.current) return
    inFlight.current = true

    const base = mode === "initial" ? resetForFilters(stateRef.current) : stateRef.current
    // Paint the busy state immediately so the button disables before the request
    // comes back, rather than after.
    setState(beginLoad(base, mode))
    try {
      setState(await runLoad(base, { mode, filters: filtersRef.current }))
    } finally {
      inFlight.current = false
    }
  }, [])

  // Keyed on the SEMANTIC filters plus the page size. A changed semantic filter
  // is a different question, so the cursor from the old one is dropped and the
  // list starts again at page one; a changed page size restarts too, because
  // stitching a 100-row page onto a 10-row one gives a list nobody asked for.
  const key = semanticKey(filters) + "|" + filters.pageSize
  useEffect(() => {
    void load("initial")
  }, [key, load])

  const refresh = useCallback(() => {
    void load("refresh")
  }, [load])

  const loadMore = useCallback(() => {
    void load("more")
  }, [load])

  return { state, refresh, loadMore }
}
