/**
 * Defect 1: a filter change must be a history entry.
 *
 * WHAT THIS ACTUALLY TESTS
 * ------------------------
 * Not "push was called" -- that is the implementation restated. SimulatedBrowser
 * below is a real model of the two history operations: push appends an entry and
 * moves the pointer, replace overwrites the entry under the pointer, back moves
 * the pointer down and cannot go below the entry the reader arrived on. That is
 * enough to reproduce the ACTUAL defect, which was never about which method got
 * called: with replace, a reader who filtered and pressed Back left /activity,
 * because there was no second entry for Back to land on.
 *
 * `entered` models the page the reader came FROM. Back from index 0 leaves this
 * screen, and the tests assert exactly that boundary in both directions.
 */

import { describe, expect, it } from "vitest"

import {
  ACTIVITY_PATH,
  activityHref,
  navigateForFilterChange,
  navigateForPaginationUpdate,
  navigationKindFor,
  type ActivityRouterLike,
} from "./navigation"
import {
  EMPTY_FILTERS,
  filtersFromParams,
  withListFilter,
  withScalarFilter,
  type ActivityFilters,
} from "./filters"

class SimulatedBrowser implements ActivityRouterLike {
  /** Index 0 is the page the reader was on before /activity. */
  readonly entries: string[] = ["/dashboard", ACTIVITY_PATH]
  index = 1

  push(href: string): void {
    // A new entry truncates anything ahead of the pointer, as a browser does.
    this.entries.length = this.index + 1
    this.entries.push(href)
    this.index = this.entries.length - 1
  }

  replace(href: string): void {
    this.entries[this.index] = href
  }

  back(): void {
    if (this.index > 0) this.index -= 1
  }

  get url(): string {
    return this.entries[this.index]
  }

  get onActivity(): boolean {
    return this.url.startsWith(ACTIVITY_PATH)
  }

  /** The filter set the address bar is currently expressing. */
  get filters(): ActivityFilters {
    return filtersFromParams(new URLSearchParams(this.url.split("?")[1] ?? ""))
  }

  /** Entries added since the reader arrived on /activity. */
  get depth(): number {
    return this.entries.length - 2
  }
}

describe("a filter change is a history stop", () => {
  it("adds a history entry, and Back restores the previous filter set", () => {
    const browser = new SimulatedBrowser()
    expect(browser.depth).toBe(0)

    navigateForFilterChange(browser, withListFilter(EMPTY_FILTERS, "source", "lane2"))

    // The entry exists. This is the whole fix.
    expect(browser.depth).toBe(1)
    expect(browser.filters.source).toEqual(["lane2"])

    browser.back()

    // Back landed on the PREVIOUS FILTER SET, not on the previous page.
    expect(browser.onActivity).toBe(true)
    expect(browser.filters).toEqual(EMPTY_FILTERS)
  })

  it("walks back through several filter sets one at a time", () => {
    const browser = new SimulatedBrowser()
    const first = withListFilter(EMPTY_FILTERS, "source", "lane2")
    const second = withListFilter(first, "status", "pending")
    const third = withScalarFilter(second, "customer", "cust-1")

    navigateForFilterChange(browser, first)
    navigateForFilterChange(browser, second)
    navigateForFilterChange(browser, third)

    expect(browser.depth).toBe(3)
    expect(browser.filters.customer).toBe("cust-1")

    browser.back()
    expect(browser.filters.customer).toBe("")
    expect(browser.filters.status).toEqual(["pending"])

    browser.back()
    expect(browser.filters.status).toEqual([])
    expect(browser.filters.source).toEqual(["lane2"])

    browser.back()
    expect(browser.filters).toEqual(EMPTY_FILTERS)
    expect(browser.onActivity).toBe(true)
  })

  it("REGRESSION: with replace, one Back ejected the reader off the page", () => {
    // The old behaviour, reproduced through the same model so the difference is
    // visible rather than argued.
    const old = new SimulatedBrowser()
    navigateForPaginationUpdate(old, withListFilter(EMPTY_FILTERS, "source", "lane2"))
    expect(old.depth).toBe(0)
    old.back()
    expect(old.onActivity).toBe(false)
    expect(old.url).toBe("/dashboard")

    // The fixed behaviour, same reader, same single press of Back.
    const fixed = new SimulatedBrowser()
    navigateForFilterChange(fixed, withListFilter(EMPTY_FILTERS, "source", "lane2"))
    fixed.back()
    expect(fixed.onActivity).toBe(true)
  })

  it("clearing the filters is also a history stop", () => {
    const browser = new SimulatedBrowser()
    navigateForFilterChange(browser, withListFilter(EMPTY_FILTERS, "source", "lane2"))
    navigateForFilterChange(browser, EMPTY_FILTERS)

    expect(browser.url).toBe(ACTIVITY_PATH)
    browser.back()
    // The filters the reader cleared are recoverable, which is the point of
    // offering a Clear button rather than making them retype it.
    expect(browser.filters.source).toEqual(["lane2"])
  })
})

describe("a pagination update is NOT a history stop", () => {
  it("overwrites the current entry instead of adding one", () => {
    const browser = new SimulatedBrowser()
    navigateForFilterChange(browser, withListFilter(EMPTY_FILTERS, "source", "lane2"))
    const afterFilter = browser.depth

    navigateForPaginationUpdate(browser, withScalarFilter(browser.filters, "pageSize", "50"))
    navigateForPaginationUpdate(browser, withScalarFilter(browser.filters, "pageSize", "100"))

    // Two rewrites, no new entries: leaving the page is still one Back away
    // from where the reader's last real decision was.
    expect(browser.depth).toBe(afterFilter)
    expect(browser.filters.pageSize).toBe("100")

    browser.back()
    expect(browser.filters).toEqual(EMPTY_FILTERS)
  })

  it("states the rule directly", () => {
    expect(navigationKindFor("filter_change")).toBe("push")
    expect(navigationKindFor("pagination")).toBe("replace")
  })
})

describe("the address a filter set is shown at", () => {
  it("is the bare path when nothing is filtered", () => {
    expect(activityHref(EMPTY_FILTERS)).toBe(ACTIVITY_PATH)
  })

  it("round-trips through the address bar unchanged", () => {
    const filters = withScalarFilter(
      withListFilter(EMPTY_FILTERS, "source", "lane2"),
      "pageSize",
      "50",
    )
    const href = activityHref(filters)
    const parsed = filtersFromParams(new URLSearchParams(href.split("?")[1] ?? ""))
    expect(parsed).toEqual(filters)
  })
})
