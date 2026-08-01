/**
 * Recent Work, rendered.
 *
 * WHAT THIS IS AND WHAT IT IS NOT
 * ------------------------------
 * This workspace has no jsdom, no @testing-library and no axe, and adding them
 * is out of scope, so these are not browser tests and nothing here proves a
 * computed style, a real focus ring or an actual 320px viewport. What it does
 * prove is the MARKUP the reader is sent: the landmark and heading structure,
 * the live regions, the label-to-control wiring, the presence of a real focusable
 * button rather than scroll-only pagination, and every honesty rule that can be
 * expressed as "this string is present" or "this string is absent".
 *
 * The view is a pure function of its props precisely so this is possible.
 * renderToStaticMarkup gives the real HTML with no DOM at all.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { RecentWorkLoading, RecentWorkShell, RecentWorkView } from "./recent-work-view"
import { initialFeedState, type FeedProblem, type FeedState } from "./feed-controller"
import { EMPTY_FILTERS, type ActivityFilters } from "./filters"
import { ACTIVITY_SOURCE_ORDER, type ActivityFeedItem, type ActivitySourceReport } from "./types"

const T0 = "2026-07-31T22:00:00.000Z"
const NOW = new Date("2026-07-31T22:05:00.000Z")

const noop = () => {}

function item(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    activityId: "a-1",
    eventType: "staff.note",
    title: "Note added",
    summary: "Rang the customer back",
    sourceSystem: "odoo",
    provenance: { source: "staff_work_action", fetchedAt: T0, trust: "authoritative", upstreamRef: null },
    actor: { ref: "staff:7", label: "Maria", kind: "staff" },
    companyId: "tenant-1",
    customerId: null,
    customerLabel: null,
    relatedObjectType: null,
    relatedObjectId: null,
    occurredAt: T0,
    receivedAt: T0,
    status: "recorded",
    ownershipState: null,
    availableActions: [],
    nativeLinks: [],
    dataMode: "production",
    freshness: { ageSeconds: 10, stale: false },
    ...overrides,
  }
}

const allOk = (): ActivitySourceReport[] =>
  ACTIVITY_SOURCE_ORDER.map((source) => ({
    source,
    state: "ok" as const,
    fetchedAt: T0,
    mode: "production" as const,
  }))

function state(overrides: Partial<FeedState> = {}): FeedState {
  return {
    ...initialFeedState(),
    phase: "ready",
    items: [item()],
    sources: allOk(),
    dataState: "available_with_records",
    generatedAt: T0,
    lastLoadedAt: T0,
    ...overrides,
  }
}

/**
 * The page as a reader receives it: the stable shell -- landmark, id and h1 --
 * around whatever the feed is showing. RecentWorkShell is rendered by the route
 * ABOVE the Suspense boundary, so the heading exists at every stage of the
 * stream and exists exactly once.
 */
function render(feedState: FeedState, filters: ActivityFilters = EMPTY_FILTERS): string {
  return renderToStaticMarkup(
    <RecentWorkShell>
      <RecentWorkView
        state={feedState}
        filters={filters}
        now={NOW}
        onRefresh={noop}
        onLoadMore={noop}
        onFiltersChange={noop}
        onClearFilters={noop}
      />
    </RecentWorkShell>,
  )
}

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length

// ── the eleven states ──

describe("LOADING", () => {
  it("says it is busy and does not pretend the list is empty", () => {
    const html = render(state({ phase: "loading", items: [], sources: [], dataState: null }))
    expect(html).toContain("aria-busy=\"true\"")
    expect(html).toContain("Not loaded yet")
    // The empty message must NOT appear while we are still asking.
    expect(html).not.toContain("Nothing to show</p>")
    // Skeletons never animate for a reader who asked for less motion.
    expect(html).toContain("motion-reduce:animate-none")
  })

  it("the Suspense fallback is honest too", () => {
    const html = renderToStaticMarkup(<RecentWorkLoading />)
    expect(html).toContain("aria-busy=\"true\"")
    expect(html).toContain("motion-reduce:animate-none")
  })
})

describe("POPULATED", () => {
  it("shows the row, the record count and every source", () => {
    const html = render(state())
    expect(html).toContain("Note added")
    expect(html).toContain("Rang the customer back")
    expect(html).toContain("1 record shown")
    expect(html).toContain("Security and audit trail")
    expect(html).toContain("Live channel and assistant events")
    expect(html).toContain("Prepared 2026-07-31 22:00:00 UTC")
    expect(html).toContain("Last successful refresh")
  })
})

describe("EMPTY", () => {
  it("says every system answered and had nothing, not that something failed", () => {
    const html = render(state({ items: [], dataState: "available_empty" }))
    expect(html).toContain("Nothing to show")
    expect(html).toContain("Every system answered and none of them had anything to report yet.")
    expect(html).not.toContain("Try again")
    expect(html).not.toContain("Load more")
  })

  it("offers to clear the filters when filters are what emptied it", () => {
    const html = render(
      state({ items: [], dataState: "available_empty" }),
      { ...EMPTY_FILTERS, source: ["lane2"] },
    )
    expect(html).toContain("No records match these filters")
    expect(html).toContain("Clear all filters")
  })
})

describe("PARTIAL", () => {
  it("keeps the rows and names the source that is missing", () => {
    const sources: ActivitySourceReport[] = [
      ...allOk().slice(0, 4),
      { source: "lane2", state: "unavailable", detail: "no Lane-2 event store is configured" },
    ]
    const html = render(state({ dataState: "partial", sources }))

    // The rows survive. This is the rule the whole screen turns on.
    expect(html).toContain("Note added")
    expect(html).toContain("1 record shown")
    expect(html).toContain("This list is incomplete")
    expect(html).toContain("Live channel and assistant events")
    expect(html).toContain("we could not reach this system")
    // Not a full-page error.
    expect(html).not.toContain("Recent work could not be loaded")
  })
})

describe("ALL_SOURCES_UNAVAILABLE", () => {
  it("is an unavailable screen with a retry and no raw error", () => {
    const html = render(
      state({ phase: "failed", items: [], sources: [], dataState: null, problem: { kind: "unavailable" } }),
    )
    expect(html).toContain("Recent work is unavailable right now")
    expect(html).toContain("Try again")
    expect(html).toContain("we could not find out what happened")
    expect(html).not.toContain("activity_unavailable")
    expect(html).not.toContain("503")
  })
})

describe("FORBIDDEN_SOURCE", () => {
  it("says not permitted, and shows no count and no timestamp for it", () => {
    const sources: ActivitySourceReport[] = [
      { source: "audit_log", state: "forbidden" },
      ...allOk().slice(1),
    ]
    const html = render(state({ dataState: "partial", sources }))

    expect(html).toContain("Not permitted")
    expect(html).toContain("These records are not available to this account.")
    // Four sources report a count, the forbidden one does not.
    expect(count(html, /records on this page/g) + count(html, /1 record on this page/g)).toBe(4)
    // Four timestamps, not five.
    expect(count(html, /Read 2026-07-31 22:00:00 UTC/g)).toBe(4)
  })
})

describe("STALE", () => {
  it("reads as older information, never as current", () => {
    const sources: ActivitySourceReport[] = [
      ...allOk().slice(0, 4),
      { source: "lane2", state: "stale", fetchedAt: T0, detail: "cache" },
    ]
    const html = render(
      state({
        dataState: "stale",
        sources,
        items: [item({ freshness: { ageSeconds: 9000, stale: true } })],
      }),
    )
    expect(html).toContain("Some of this is older than the rest")
    expect(html).toContain("Older information")
    expect(html).toContain("From an older read")
    expect(html).toContain("answered with information from an earlier read")
  })
})

describe("RETRYING", () => {
  it("disables both the refresh and the load-more control while in flight", () => {
    const html = render(state({ phase: "loading_more", nextCursor: "C1" }))
    expect(html).toContain("Loading more")
    expect(html).toContain("Refreshing")
    // Two disabled controls: nothing can be double-submitted from the markup.
    expect(count(html, /disabled=""/g)).toBeGreaterThanOrEqual(2)
  })
})

describe("AUTHENTICATION_EXPIRED", () => {
  it("offers a sign-in link, removes Load more and never loops", () => {
    const html = render(
      state({ items: [], sources: [], phase: "failed", nextCursor: null, problem: { kind: "auth_expired" } }),
    )
    expect(html).toContain("You have been signed out")
    expect(html).toContain("Sign in again")
    expect(html).toContain("/auth/login?returnTo=%2Factivity")
    // No pagination control at all, so nothing to hammer.
    expect(html).not.toContain("Load more")
    expect(html).not.toContain("Try again")
  })
})

describe("INVALID_FILTER", () => {
  it("names the parameter, shows the sanitized detail and offers to clear", () => {
    const problem: FeedProblem = {
      kind: "invalid_filter",
      parameter: "pageSize",
      detail: "pageSize may not exceed 100",
    }
    const html = render(state({ phase: "failed", items: [], problem }))
    expect(html).toContain("That filter cannot be used")
    // The page's own label for it, not the API's parameter name (defect 11).
    expect(html).toContain("Records per page")
    // ...and the API's own sentence goes through the SAME table, so the raw
    // parameter name does not come back out on the end of it (defect 11, part 2).
    expect(html).toContain("Records per page may not exceed 100")
    expect(html).toContain("Clear all filters")
  })
})

describe("INVALID_CURSOR", () => {
  it("explains that the list restarted rather than dead-ending", () => {
    const html = render(
      state({ cursorWasReset: true, problem: { kind: "invalid_cursor", detail: "the cursor is not valid" } }),
    )
    expect(html).toContain("Back to the first page")
    expect(html).toContain("Nothing was skipped")
    // The rows from page one are on screen behind the notice.
    expect(html).toContain("Note added")
  })
})

// ── row honesty ──

describe("a row never invents anything", () => {
  it("renders no link at all when the API supplied none", () => {
    const html = render(state({ items: [item({ nativeLinks: [] })] }))
    // The only anchors on this screen would be ones we invented.
    expect(html).not.toContain("target=\"_blank\"")
  })

  it("renders the link the API supplied, exactly as supplied", () => {
    const html = render(
      state({
        items: [
          item({
            nativeLinks: [
              { system: "odoo", label: "Open in Odoo", href: "https://odoo.example/web#id=42" },
            ],
          }),
        ],
      }),
    )
    expect(html).toContain("href=\"https://odoo.example/web#id=42\"")
    expect(html).toContain("Open in Odoo")
    expect(html).toContain("rel=\"noreferrer noopener\"")
    expect(html).toContain("opens in a new tab")
  })

  it("drops a link that is not an absolute http address", () => {
    const html = render(
      state({
        items: [
          item({ nativeLinks: [{ system: "x", label: "Open", href: "javascript:alert(1)" }] }),
        ],
      }),
    )
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("target=\"_blank\"")
  })

  it("an unknown actor stays Unknown", () => {
    const html = render(
      state({ items: [item({ actor: { ref: "staff:99", label: "", kind: "staff" } })] }),
    )
    expect(html).toContain("Unknown")
    // The internal reference is never shown in its place.
    expect(html).not.toContain("staff:99")
  })

  it("omits a field the API did not send rather than filling it in", () => {
    const html = render(state({ items: [item({ customerLabel: null, ownershipState: null })] }))
    expect(html).not.toContain("Customer</dt>")
    expect(html).not.toContain("Ownership</dt>")
  })

  it("shows ownership when the API did send it, including its own unknown", () => {
    const html = render(state({ items: [item({ ownershipState: "unknown" })] }))
    expect(html).toContain("Ownership")
    expect(html).toContain("Not known")
  })

  it("a failed readback can never read as a success", () => {
    const html = render(state({ items: [item({ status: "readback_failed" })] }))
    expect(html).toContain("Not confirmed")
    expect(html).toContain("could not be read back")
    expect(html).not.toContain("Succeeded")
    expect(html).not.toContain("Completed")
  })

  it("marks fixture rows as sample data, individually and at the top", () => {
    const html = render(
      state({ containsFixture: true, items: [item({ dataMode: "fixture" })] }),
    )
    expect(html).toContain("Sample data, not a real record")
    expect(html).toContain("Some rows below are sample data, not real records.")
  })

  it("shows available actions as labels, not as controls", () => {
    const html = render(state({ items: [item({ availableActions: ["note.create"] })] }))
    expect(html).toContain("Add a note")
    expect(html).toContain("not available from this screen yet")
    // No control was rendered for it.
    expect(html).not.toContain(">Add a note</button>")
  })

  it("gives both a relative and an exact time", () => {
    const html = render(state())
    expect(html).toContain("5 minutes ago")
    expect(html).toContain("title=\"2026-07-31 22:00:00 UTC\"")
    // React serialises the JSX prop name here; a browser lowercases it while
    // parsing, so this is matched case-insensitively rather than pinned to
    // whichever casing this React version happens to emit.
    expect(html).toMatch(/datetime="2026-07-31T22:00:00\.000Z"/i)
  })
})

// ── pagination ──

describe("pagination is a real, focusable control", () => {
  it("renders a Load more button when the server gave a cursor", () => {
    const html = render(state({ nextCursor: "SERVER-CURSOR" }))
    expect(html).toMatch(/<button[^>]*>Load more<\/button>/)
    // The cursor itself is never put in the markup.
    expect(html).not.toContain("SERVER-CURSOR")
  })

  it("says the list has ended rather than leaving a dead button", () => {
    const html = render(state({ nextCursor: null }))
    expect(html).not.toContain("Load more")
    expect(html).toContain("That is the end of the list.")
  })
})

// ── accessibility structure ──

describe("accessibility structure", () => {
  const html = render(state({ nextCursor: "C1" }))

  it("has exactly one h1 and no second main landmark", () => {
    expect(count(html, /<h1[\s>]/g)).toBe(1)
    expect(html).toContain("Recent Work</h1>")
    // SidebarInset already renders the pages main element.
    expect(html).not.toContain("<main")
  })

  it("uses labelled sections and ordered headings", () => {
    expect(html).toContain("aria-labelledby=\"recent-work-title\"")
    expect(html).toContain("aria-labelledby=\"activity-filters-title\"")
    expect(html).toContain("aria-labelledby=\"activity-sources-title\"")
    expect(html).toContain("aria-labelledby=\"activity-records-title\"")
    // h1 then h2s then h3s. No level is skipped.
    const levels = (html.match(/<h([1-6])[\s>]/g) ?? []).map((tag) => Number(tag[2]))
    expect(levels[0]).toBe(1)
    expect(new Set(levels)).toEqual(new Set([1, 2, 3]))
    for (let i = 1; i < levels.length; i += 1) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1)
  })

  it("announces status politely and never assertively", () => {
    expect(count(html, /aria-live="polite"/g)).toBeGreaterThanOrEqual(3)
    expect(html).not.toContain("aria-live=\"assertive\"")
    expect(html).not.toContain("role=\"alert\"")
  })

  it("uses list semantics for the feed and the source panel", () => {
    expect(html).toContain("<ol role=\"list\"")
    expect(html).toContain("<ul role=\"list\"")
    expect(count(html, /<li[\s>]/g)).toBeGreaterThanOrEqual(6)
  })

  it("labels every single control", () => {
    const controlIds = [...html.matchAll(/<(?:select|input)[^>]*\sid="([^"]+)"/g)].map((m) => m[1])
    expect(controlIds.length).toBeGreaterThanOrEqual(9)
    for (const id of controlIds) {
      expect(html).toContain("for=\"" + id + "\"")
    }
  })

  it("uses only real, keyboard-operable controls", () => {
    // Every button is a real button that will not submit a form by accident.
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0])
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    for (const button of buttons) expect(button).toContain("type=\"button\"")
    // Nothing is removed from the tab order, and nothing fakes a control with a
    // div and a click handler.
    expect(html).not.toContain("tabindex=\"-1\"")
    expect(html).not.toMatch(/role="button"/)
  })

  it("keeps a visible focus ring on everything focusable", () => {
    const focusable = [...html.matchAll(/<(?:button|select|input|a)[^>]*>/g)].map((m) => m[0])
    for (const element of focusable) {
      if (element.startsWith("<a") && !element.includes("href")) continue
      expect(element).toMatch(/focus-visible:/)
    }
  })

  it("respects a request for reduced motion", () => {
    const busy = render(state({ phase: "refreshing" }))
    expect(busy).toContain("animate-spin motion-reduce:animate-none")
  })
})

// ── mobile ──

describe("mobile layout", () => {
  const html = render(
    state({
      nextCursor: "C1",
      items: [
        item({
          title: "A very long title that would otherwise force a horizontal scrollbar on a narrow phone",
          customerLabel: "Averylongunbrokencustomeridentifierwithnospacesatall",
          availableActions: ["note.create", "followup.schedule"],
        }),
      ],
    }),
  )

  it("wraps rather than forcing the page wider", () => {
    // Nothing declares a fixed pixel width, which is the only way this markup
    // could exceed a 320px viewport.
    expect(html).not.toMatch(/\bw-\[\d/)
    expect(html).not.toMatch(/\bmin-w-\[\d/)
    expect(html).toContain("min-w-0")
    expect(html).toContain("flex-wrap")
    expect(html).toContain("break-words")
  })

  it("stacks the filters on one column before the first breakpoint", () => {
    // The grid is single-column by default and only splits at sm and above.
    expect(html).toContain("grid gap-3 sm:grid-cols-2 xl:grid-cols-4")
    // An UNPREFIXED multi-column grid is the thing that would break a 320px
    // screen. sm:grid-cols-2 is fine and must not trip this, so the boundary is
    // the start of a class name rather than \b, which a colon already satisfies.
    expect(html).not.toMatch(/["\s]grid-cols-[2-9]/)
  })

  it("gives every touch target at least 44px of height", () => {
    const targets = [...html.matchAll(/<(?:button|select|input)[^>]*>/g)].map((m) => m[0])
    // Two buttons, five selects, four inputs. Every control on the screen.
    expect(targets.length).toBe(11)
    for (const target of targets) expect(target).toContain("min-h-11")
  })

  it("makes the pagination control full width on a phone", () => {
    expect(html).toContain("min-h-11 w-full")
  })
})
