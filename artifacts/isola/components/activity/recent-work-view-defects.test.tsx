/**
 * The twelve logged defects, as the markup a reader is actually sent.
 *
 * Kept apart from recent-work-view.test.tsx, which describes the eleven STATES
 * this screen can be in. These are regressions: each one names the defect it
 * pins and asserts the specific wrong thing that used to be on screen is gone
 * and the specific right thing is there. Same technique -- renderToStaticMarkup,
 * no jsdom, no testing-library -- and the same limits: this proves the HTML,
 * not a computed style or a real focus ring.
 *
 * Defects 1 and 10 also have unit coverage in navigation.test.ts and
 * filters-params.test.ts; 3 has controller coverage in
 * feed-controller-cursor.test.ts; 2, 4 and 5 have structural coverage in
 * tests/activity-page-shell-contract.test.ts.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { SidebarInset } from "@/components/ui/sidebar"

import { RecentWorkLoading, RecentWorkView } from "./recent-work-view"
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

function render(feedState: FeedState, filters: ActivityFilters = EMPTY_FILTERS): string {
  return renderToStaticMarkup(
    <RecentWorkView
      state={feedState}
      filters={filters}
      now={NOW}
      onRefresh={noop}
      onLoadMore={noop}
      onFiltersChange={noop}
      onClearFilters={noop}
    />,
  )
}

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length

// ── the twelve defects, as markup ──

describe("defect 2: the shell is never blank while loading", () => {
  it("the very first paint already has the whole page in outline", () => {
    const html = renderToStaticMarkup(<RecentWorkLoading />)
    // Not three grey bars. The reader can see where the list will be.
    expect(html).toContain("aria-busy=\"true\"")
    expect(html).toContain("Recent Work</h1>")
    expect(html).toContain("Records</div>")
    expect(html).toContain("Loading your recent work")
    // The records area is present and full of row skeletons, not absent.
    expect(count(html, /<li[\s>]/g)).toBeGreaterThanOrEqual(5)
    expect(html).toContain("motion-reduce:animate-none")
  })

  it("the skeleton is a real subtree, not something hidden", () => {
    const html = renderToStaticMarkup(<RecentWorkLoading />)
    // The section that was reported as display:none / absent is neither.
    expect(html).toContain("data-activity-feed=\"loading\"")
    expect(html).not.toContain("display:none")
    expect(html).not.toContain("hidden=\"\"")
    expect(html).not.toMatch(/class="[^"]*\bhidden\b/)
  })

  it("the idle state shows skeletons rather than an empty list", () => {
    // Before the first request even leaves, and while it is in flight.
    for (const phase of ["idle", "loading"] as const) {
      const html = render(state({ phase, items: [], sources: [], dataState: null }))
      expect(html).toContain("aria-busy=\"true\"")
      expect(html).toContain("Records")
      expect(html).not.toContain("Nothing to show</p>")
      expect(html).not.toContain("That is the end of the list.")
    }
  })

  it("the skeleton stays until data OR an error arrives, and not past either", () => {
    const withRows = render(state())
    expect(withRows).not.toContain("aria-busy=\"true\"")

    const failed = render(
      state({ phase: "failed", items: [], sources: [], dataState: null, problem: { kind: "unavailable" } }),
    )
    expect(failed).not.toContain("aria-busy=\"true\"")
    expect(failed).toContain("Recent work is unavailable right now")
  })
})

describe("defect 3: a 400 never renders as Complete", () => {
  // The state after the recovery SUCCEEDS: the problem is gone, the rows are
  // real, and cursorWasReset is the only evidence the server refused anything.
  const recovered = state({ cursorWasReset: true, problem: null })

  it("REGRESSION: the freshness banner does not claim success", () => {
    const html = render(recovered)
    expect(html).not.toContain("Complete")
    expect(html).not.toContain("Every system answered.")
    expect(html).toContain("Restarted at the first page")
  })

  it("says the cursor was not valid, that we are on page one, and that nothing was skipped", () => {
    const html = render(recovered)
    expect(html).toContain("Back to the first page")
    expect(html).toContain("not valid")
    expect(html).toContain("refused")
    expect(html).toContain("first page")
    expect(html).toContain("Nothing was skipped")
  })

  it("keeps the recovered rows on screen", () => {
    expect(render(recovered)).toContain("Note added")
  })

  it("does not announce the same refusal twice", () => {
    // While the problem is still live, ProblemNotice owns the message.
    const html = render(
      state({ cursorWasReset: true, problem: { kind: "invalid_cursor", detail: "the cursor is not valid" } }),
    )
    expect(count(html, /Back to the first page/g)).toBe(1)
  })

  it("an ordinary successful load is still allowed to say Complete", () => {
    const html = render(state())
    expect(html).toContain("Complete")
    expect(html).not.toContain("Restarted at the first page")
  })
})

describe("defect 4: exactly one h1 in the page tree", () => {
  it("the loaded page has one", () => {
    expect(count(render(state()), /<h1[\s>]/g)).toBe(1)
    expect(render(state())).toContain("Recent Work</h1>")
  })

  it("the loading page has one, and it is the same title", () => {
    const html = renderToStaticMarkup(<RecentWorkLoading />)
    expect(count(html, /<h1[\s>]/g)).toBe(1)
    expect(html).toContain("Recent Work</h1>")
  })

  it("every state renders exactly one, so no state can grow a second", () => {
    const states: FeedState[] = [
      state(),
      state({ phase: "loading", items: [], sources: [], dataState: null }),
      state({ phase: "failed", items: [], problem: { kind: "unavailable" } }),
      state({ phase: "failed", items: [], problem: { kind: "auth_expired" } }),
      state({ items: [], dataState: "available_empty" }),
      state({ cursorWasReset: true }),
    ]
    for (const feedState of states) {
      expect(count(render(feedState), /<h1[\s>]/g)).toBe(1)
    }
  })

  it("the page title is not the chrome label the topbar used to duplicate", () => {
    expect(render(state())).not.toContain("Activity &amp; Reports")
  })
})

describe("defect 5: the feed renders inside the page's one main", () => {
  it("renders no main of its own, so there is exactly one to be inside of", () => {
    expect(render(state())).not.toContain("<main")
    expect(renderToStaticMarkup(<RecentWorkLoading />)).not.toContain("<main")
  })

  it("is nested within SidebarInset's main, not placed beside it", () => {
    // SidebarInset is the element the (owner) layout wraps this route in, and
    // it is what renders the page's <main>. Composing them here proves the
    // ancestry the reported defect was about: closest("main") must resolve.
    const html = renderToStaticMarkup(
      <SidebarInset>
        <div className="p-4">
          <RecentWorkView
            state={state()}
            filters={EMPTY_FILTERS}
            now={NOW}
            onRefresh={noop}
            onLoadMore={noop}
            onFiltersChange={noop}
            onClearFilters={noop}
          />
        </div>
      </SidebarInset>,
    )

    const mainOpen = html.indexOf("<main")
    const mainClose = html.lastIndexOf("</main>")
    const feed = html.indexOf("data-activity-feed=\"ready\"")
    const rows = html.indexOf("Note added")

    expect(mainOpen).toBeGreaterThanOrEqual(0)
    expect(feed).toBeGreaterThan(mainOpen)
    expect(feed).toBeLessThan(mainClose)
    // The records themselves, not just the wrapper, are under the landmark.
    expect(rows).toBeGreaterThan(mainOpen)
    expect(rows).toBeLessThan(mainClose)
    // Still exactly one main.
    expect(count(html, /<main[\s>]/g)).toBe(1)
  })

  it("the loading state is inside main too, so a skip link never lands on nothing", () => {
    const html = renderToStaticMarkup(
      <SidebarInset>
        <RecentWorkLoading />
      </SidebarInset>,
    )
    const mainOpen = html.indexOf("<main")
    const feed = html.indexOf("data-activity-feed=\"loading\"")
    expect(feed).toBeGreaterThan(mainOpen)
    expect(feed).toBeLessThan(html.lastIndexOf("</main>"))
  })

  it("offers a stable target for a skip link", () => {
    expect(render(state())).toContain("id=\"recent-work\"")
    expect(renderToStaticMarkup(<RecentWorkLoading />)).toContain("id=\"recent-work\"")
  })
})

describe("defect 6: pageSize is reflected in its own control", () => {
  it("REGRESSION: ?pageSize=5 no longer reads as 25 (default)", () => {
    const html = render(state(), { ...EMPTY_FILTERS, pageSize: "5" })
    const select = html.match(/<select[^>]*id="activity-filter-page-size"[\s\S]*?<\/select>/)?.[0]
    expect(select).toBeDefined()
    // The value the URL asked for is present as an option AND selected.
    expect(select).toContain("value=\"5\"")
    expect(select).toMatch(/<option[^>]*selected[^>]*value="5"|value="5"[^>]*selected/)
    // The placeholder is not the selected one.
    expect(select).not.toMatch(/<option[^>]*selected[^>]*value=""/)
  })

  it("a value the list already offers is selected without being duplicated", () => {
    const html = render(state(), { ...EMPTY_FILTERS, pageSize: "50" })
    const select = html.match(/<select[^>]*id="activity-filter-page-size"[\s\S]*?<\/select>/)?.[0] ?? ""
    expect((select.match(/value="50"/g) ?? []).length).toBe(1)
    expect(select).not.toContain("from the address")
  })

  it("no pageSize in the URL still reads as the default", () => {
    const html = render(state())
    const select = html.match(/<select[^>]*id="activity-filter-page-size"[\s\S]*?<\/select>/)?.[0] ?? ""
    expect(select).toContain("25 (default)")
    expect(select).not.toContain("from the address")
  })

  it("the same hole is closed for every other select on the screen", () => {
    // A source the API knows about but this build does not still shows.
    const html = render(state(), { ...EMPTY_FILTERS, source: ["some_new_source"] })
    const select = html.match(/<select[^>]*id="activity-filter-source"[\s\S]*?<\/select>/)?.[0] ?? ""
    expect(select).toContain("some_new_source")
  })
})

describe("defect 7: no contradictory dual state", () => {
  it("REGRESSION: a rejected filter does not also claim to be unloaded", () => {
    const html = render(
      state({
        phase: "failed",
        items: [],
        sources: [],
        dataState: null,
        problem: { kind: "invalid_filter", parameter: "pageSize", detail: "pageSize may not exceed 100" },
      }),
    )

    // The complaint is shown...
    expect(html).toContain("That filter cannot be used")
    // ...and the banner no longer says the opposite thing beside it.
    expect(html).not.toContain("Not loaded yet")
    expect(html).not.toContain("This list has not been loaded yet.")
    // Nor does it claim a loading state.
    expect(html).not.toContain("aria-busy=\"true\"")
  })

  it("no failure state describes itself as complete or as loading", () => {
    const problems: FeedProblem[] = [
      { kind: "unavailable" },
      { kind: "auth_expired" },
      { kind: "not_permitted" },
      { kind: "unexpected" },
      { kind: "invalid_filter", parameter: "source", detail: "no" },
      { kind: "invalid_cursor", detail: "no" },
    ]
    for (const problem of problems) {
      const html = render(state({ phase: "failed", items: [], sources: [], dataState: null, problem }))
      expect(html).not.toContain("Not loaded yet")
      expect(html).not.toContain("Complete")
      expect(html).not.toContain("Every system answered.")
    }
  })

  it("a genuinely unloaded list still says so", () => {
    // Idle with no problem is the one state where "not loaded yet" is true.
    const html = render(state({ phase: "idle", items: [], sources: [], dataState: null, problem: null }))
    expect(html).toContain("Not loaded yet")
  })
})

describe("defect 8: rows are distinguishable", () => {
  const rows = [
    item({ activityId: "cmrewcr5e0001s617dpr2qm3e", occurredAt: "2026-07-31T22:00:03.000Z" }),
    item({ activityId: "cmrewdo5b0005s61765xj85i4", occurredAt: "2026-07-31T22:00:41.000Z" }),
  ]

  it("REGRESSION: two rows in the same minute render differently", () => {
    const html = render(state({ items: rows }))
    expect(html).toContain("2026-07-31 22:00:03 UTC")
    expect(html).toContain("2026-07-31 22:00:41 UTC")
  })

  it("each row also carries its own short reference", () => {
    const html = render(state({ items: rows }))
    expect(html).toContain("…2qm3e")
    expect(html).toContain("…j85i4")
    expect(count(html, /Record<\/dt>/g)).toBe(2)
  })

  it("the full id is available on the reference, not thrown away", () => {
    const html = render(state({ items: [rows[0]] }))
    expect(html).toContain("title=\"cmrewcr5e0001s617dpr2qm3e\"")
  })
})

describe("defect 9: no raw cuids on screen", () => {
  it("REGRESSION: an actor whose label is an identifier reads as a kind plus a suffix", () => {
    const html = render(
      state({
        items: [
          item({
            actor: { ref: "agent:cmrewcr5e0001s617dpr2qm3e", label: "agent:cmrewcr5e0001s617dpr2qm3e", kind: "agent" },
          }),
        ],
      }),
    )
    expect(html).toContain("Assistant · …2qm3e")
    // The identifier is not printed as if it were a name.
    expect(html).not.toContain(">agent:cmrewcr5e0001s617dpr2qm3e<")
    // But it is not withheld either.
    expect(html).toContain("title=\"agent:cmrewcr5e0001s617dpr2qm3e\"")
  })

  it("REGRESSION: a related conversation reads as a kind plus a suffix", () => {
    const html = render(
      state({
        items: [
          item({ relatedObjectType: "conversation", relatedObjectId: "cmrewdo5b0005s61765xj85i4" }),
        ],
      }),
    )
    expect(html).toContain("Conversation …j85i4")
    expect(html).not.toContain(">Conversation cmrewdo5b0005s61765xj85i4<")
    expect(html).toContain("title=\"Conversation cmrewdo5b0005s61765xj85i4\"")
  })

  it("no name is ever invented in place of an identifier", () => {
    const html = render(
      state({
        items: [
          item({
            actor: { ref: "agent:cmrewcr5e0001s617dpr2qm3e", label: "agent:cmrewcr5e0001s617dpr2qm3e", kind: "agent" },
            customerLabel: null,
          }),
        ],
      }),
    )
    // Nothing plausible-but-fabricated appears where the customer would be.
    expect(html).not.toContain("Customer</dt>")
    // "Assistant" is a kind the API supplied, not a name.
    expect(html).toContain("Assistant ·")
  })

  it("a real name is still printed in full", () => {
    expect(render(state())).toContain("Maria (team member)")
  })
})

describe("defect 10: an ignored parameter is acknowledged", () => {
  it("REGRESSION: ?nonsense=1 is reported instead of silently discarded", () => {
    const html = renderToStaticMarkup(
      <RecentWorkView
        state={state()}
        filters={EMPTY_FILTERS}
        now={NOW}
        onRefresh={noop}
        onLoadMore={noop}
        onFiltersChange={noop}
        onClearFilters={noop}
        unknownParams={["nonsense"]}
        onClearUnknownParams={noop}
      />,
    )
    expect(html).toContain("Part of this address was ignored")
    expect(html).toContain("nonsense")
    // And offers to clear it.
    expect(html).toContain("Remove it from the address")
  })

  it("names every ignored parameter, and reads correctly for more than one", () => {
    const html = renderToStaticMarkup(
      <RecentWorkView
        state={state()}
        filters={EMPTY_FILTERS}
        now={NOW}
        onRefresh={noop}
        onLoadMore={noop}
        onFiltersChange={noop}
        onClearFilters={noop}
        unknownParams={["nonsense", "alsoBad"]}
        onClearUnknownParams={noop}
      />,
    )
    expect(html).toContain("does not use the parameters")
    expect(html).toContain("nonsense, alsoBad")
  })

  it("says nothing at all when the address is clean", () => {
    expect(render(state())).not.toContain("Part of this address was ignored")
  })
})

describe("defect 12: the focus ring is 2px", () => {
  it("REGRESSION: no control on this screen relies on a 1px ring", () => {
    const html = render(state({ nextCursor: "C1" }))
    const focusable = [...html.matchAll(/<(?:button|select|input|a)[^>]*>/g)].map((m) => m[0])
    expect(focusable.length).toBeGreaterThanOrEqual(11)
    for (const element of focusable) {
      if (element.startsWith("<a") && !element.includes("href")) continue
      // Every focusable element removes the outline, so the ring is the whole
      // focus indicator and has to carry the thickness on its own.
      expect(element).not.toMatch(/focus-visible:ring-1(?![\d.])/)
      expect(element).toMatch(/focus-visible:ring-2/)
    }
  })

  it("covers the controls in the failure states too", () => {
    const html = render(
      state({ phase: "failed", items: [], problem: { kind: "unavailable" } }),
    )
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0])
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    for (const button of buttons) expect(button).toMatch(/focus-visible:ring-2/)
  })
})
