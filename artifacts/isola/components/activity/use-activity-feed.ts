"use client"

/**
 * The React shell around feed-controller and feed-scheduler.
 *
 * Deliberately thin. Every decision -- what a status code means, which rows
 * survive a failure, when a cursor is thrown away -- lives in runLoad, and every
 * decision about WHEN a load happens lives in createFeedScheduler, where both
 * can be tested in node without a browser. What is left here is the part that
 * genuinely needs React: holding state.
 *
 * NOTHING IN THIS FILE RETRIES ON A TIMER. Every load is caused by the reader
 * arriving, changing a filter, pressing Refresh or pressing Load more. That is
 * why an expired session cannot become a loop: there is no loop to get into.
 *
 * WHAT THE EFFECT USED TO DO WRONG
 * --------------------------------
 * It shared ONE in-flight boolean with the buttons, so an effect that fired for
 * a NEW filter key while the first load was still running returned without
 * issuing anything at all -- and because the lock was cleared by the request
 * that was already in flight, nothing ever came back to retry it. The client
 * simply never made the request (defect-activity-feed-request-never-issued).
 * The scheduler now distinguishes "the same question again" from "a different
 * question", and only the first of those is allowed to be a no-op.
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
import { createFeedScheduler, type FeedScheduler } from "./feed-scheduler"
import { semanticKey, type ActivityFilters } from "./filters"

export interface ActivityFeedController {
  state: FeedState
  refresh(): void
  loadMore(): void
}

export function useActivityFeed(
  filters: ActivityFilters,
  /**
   * A cursor the ADDRESS BAR arrived with, used for the first load of this
   * filter set and nothing else. Refresh and Load more both ignore it: refresh
   * means "the newest records", and Load more has the server's own cursor.
   */
  initialCursor: string | null = null,
): ActivityFeedController {
  const [state, setState] = useState<FeedState>(initialFeedState)

  // Refs, not dependencies. A callback that changed identity whenever the state
  // or the filters changed would re-run the effect below and load the same page
  // again on every keystroke in a filter box.
  const stateRef = useRef(state)
  stateRef.current = state
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const cursorRef = useRef(initialCursor)
  cursorRef.current = initialCursor

  const run = useCallback(async (mode: LoadMode, signal: AbortSignal) => {
    const base = mode === "initial" ? resetForFilters(stateRef.current) : stateRef.current
    // Paint the busy state immediately so the button disables before the request
    // comes back, rather than after.
    setState(beginLoad(base, mode))

    const next = await runLoad(
      base,
      { mode, filters: filtersRef.current, initialCursor: cursorRef.current },
      { signal },
    )

    // A superseded request answers a question nobody is asking any more, and its
    // rows would overwrite the ones the reader is actually waiting for.
    if (signal.aborted) return
    setState(next)
  }, [])

  const schedulerRef = useRef<FeedScheduler | null>(null)
  if (schedulerRef.current === null) schedulerRef.current = createFeedScheduler({ run })
  const scheduler = schedulerRef.current

  // Keyed on the SEMANTIC filters plus the page size. A changed semantic filter
  // is a different question, so the cursor from the old one is dropped and the
  // list starts again at page one; a changed page size restarts too, because
  // stitching a 100-row page onto a 10-row one gives a list nobody asked for.
  const key = semanticKey(filters) + "|" + filters.pageSize
  useEffect(() => {
    scheduler.start(key)
  }, [key, scheduler])

  const refresh = useCallback(() => {
    scheduler.refresh()
  }, [scheduler])

  const loadMore = useCallback(() => {
    scheduler.loadMore()
  }, [scheduler])

  return { state, refresh, loadMore }
}
