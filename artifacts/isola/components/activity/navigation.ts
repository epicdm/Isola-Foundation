/**
 * How a change to this screen is written into the browser history.
 *
 * WHY THIS IS A SEPARATE, ROUTER-FREE MODULE
 * ------------------------------------------
 * The rule below is a product decision, not a React detail, and it was wrong
 * for a long time precisely because it lived inside a component where nothing
 * could test it. Everything here takes a minimal router shape rather than the
 * Next.js one, so the whole rule is exercisable in node with a fake browser.
 *
 * THE RULE
 * --------
 * A FILTER CHANGE IS A HISTORY STOP. It is a new question the reader asked, and
 * Back has to answer the previous one. The screen used to call router.replace
 * for this, which meant a reader who narrowed the list and pressed Back was
 * thrown off /activity entirely -- their filter work vanished and so did the
 * page (defect-activity-filters-replace-state).
 *
 * A CURSOR OR PAGINATION UPDATE IS NOT. Rewriting the address bar because page
 * two arrived is bookkeeping, not navigation; making it a history entry would
 * force a reader to press Back once per page they had loaded just to leave.
 */

import { filtersToParams, type ActivityFilters } from "./filters"

export const ACTIVITY_PATH = "/activity"

/**
 * The part of the Next.js router this screen actually uses.
 *
 * Structural, so the real AppRouterInstance satisfies it without a cast, and so
 * a test can hand in a recorder or a whole simulated history stack.
 */
export interface ActivityRouterLike {
  push(href: string, options?: { scroll?: boolean }): void
  replace(href: string, options?: { scroll?: boolean }): void
}

/** The address this filter set is shown at. Same serialisation as the API query. */
export function activityHref(filters: ActivityFilters): string {
  const query = filtersToParams(filters).toString()
  return query ? ACTIVITY_PATH + "?" + query : ACTIVITY_PATH
}

/** Why the URL is being rewritten. This is what decides push vs replace. */
export type NavigationReason = "filter_change" | "pagination"

export type NavigationKind = "push" | "replace"

export function navigationKindFor(reason: NavigationReason): NavigationKind {
  return reason === "filter_change" ? "push" : "replace"
}

/**
 * A filter changed: PUSH, so Back returns to the previous filter set rather
 * than leaving the screen.
 */
export function navigateForFilterChange(
  router: ActivityRouterLike,
  next: ActivityFilters,
): void {
  router.push(activityHref(next), { scroll: false })
}

/**
 * A cursor or page-size bookkeeping update: REPLACE, so walking back through
 * the list is not a walk back through every page that was loaded.
 */
export function navigateForPaginationUpdate(
  router: ActivityRouterLike,
  next: ActivityFilters,
): void {
  router.replace(activityHref(next), { scroll: false })
}
