/**
 * Recent Work, exercised at the HTTP boundary.
 *
 * Every test here stubs global fetch and calls runLoad. Nothing renders, nothing
 * touches a database and nothing depends on a clock: the same input gives the
 * same state every time. This is the layer that decides what a reader is told,
 * so this is the layer with the tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyFailure,
  beginLoad,
  canLoadMore,
  fetchActivityPage,
  initialFeedState,
  isBusy,
  resetForFilters,
  rowsPerSource,
  runLoad,
  type FeedState,
} from "./feed-controller"
import {
  EMPTY_FILTERS,
  SUPPORTED_FILTER_KEYS,
  filtersFromParams,
  filtersToParams,
  isFilterActive,
  semanticKey,
  type ActivityFilters,
} from "./filters"
import {
  actorLabel,
  humanise,
  relativeTime,
  safeHref,
  sourceLabel,
  sourceStatus,
  statusPresentation,
} from "./labels"
import { ACTIVITY_SOURCE_ORDER, type ActivityFeedItem, type ActivityFeedResponse } from "./types"

const T0 = "2026-07-31T22:00:00.000Z"
const NOW = new Date("2026-07-31T22:05:00.000Z")

const SOURCES = [...ACTIVITY_SOURCE_ORDER]

const allOk = () =>
  SOURCES.map((source) => ({ source, state: "ok" as const, fetchedAt: T0, mode: "production" as const }))

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

function feed(overrides: Partial<ActivityFeedResponse> = {}): ActivityFeedResponse {
  return {
    version: "activity.feed@1",
    dataState: "available_with_records",
    containsFixture: false,
    generatedAt: T0,
    items: [item()],
    nextCursor: null,
    sources: allOk(),
    ...overrides,
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Answers each call from the queue in order, and records every URL asked for. */
function stubFetch(responses: (() => Response)[]) {
  const urls: string[] = []
  let call = 0
  const impl = vi.fn(async (url: string | URL) => {
    urls.push(String(url))
    const next = responses[Math.min(call, responses.length - 1)]
    call += 1
    return next()
  })
  vi.stubGlobal("fetch", impl)
  return { urls, impl }
}

const START = initialFeedState()
const load = (state: FeedState, mode: "initial" | "refresh" | "more", filters = EMPTY_FILTERS) =>
  runLoad(state, { mode, filters }, { now: () => NOW })

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── POPULATED ───────────────────────────────────────────────────

describe("POPULATED: five sources answer and rows arrive", () => {
  it("shows the rows, all five source reports and both timestamps", async () => {
    const items = SOURCES.map((source, index) =>
      item({
        activityId: "a-" + index,
        provenance: { source, fetchedAt: T0, trust: "reported", upstreamRef: null },
      }),
    )
    stubFetch([() => json(200, feed({ items }))])

    const state = await load(START, "initial")

    expect(state.phase).toBe("ready")
    expect(state.items).toHaveLength(5)
    expect(state.sources).toHaveLength(5)
    expect(state.sources.map((s) => s.source)).toEqual(SOURCES)
    expect(state.dataState).toBe("available_with_records")
    expect(state.generatedAt).toBe(T0)
    // The API built it, and separately WE got it. Both are shown, so a reader
    // can tell a fresh answer from an old one that simply loaded again.
    expect(state.lastLoadedAt).toBe(NOW.toISOString())
    expect(state.problem).toBeNull()

    const counts = rowsPerSource(state.items)
    for (const source of SOURCES) expect(counts.get(source)).toBe(1)
  })
})

// ── EMPTY ───────────────────────────────────────────────────────

describe("EMPTY: everything answered and there was nothing", () => {
  it("is a ready screen with no rows and no complaint", async () => {
    stubFetch([() => json(200, feed({ items: [], dataState: "available_empty" }))])

    const state = await load(START, "initial")

    expect(state.phase).toBe("ready")
    expect(state.items).toEqual([])
    expect(state.dataState).toBe("available_empty")
    // The distinction this whole contract exists for: empty is NOT a problem.
    expect(state.problem).toBeNull()
  })
})

// ── PARTIAL ─────────────────────────────────────────────────────

describe("PARTIAL: some sources answered and some did not", () => {
  it("keeps every row that did arrive and never becomes a failure", async () => {
    const sources = [
      { source: "audit_log", state: "ok" as const, fetchedAt: T0 },
      { source: "approval_request", state: "ok" as const, fetchedAt: T0 },
      { source: "staff_work_action", state: "ok" as const, fetchedAt: T0 },
      { source: "conversation_ownership", state: "ok" as const, fetchedAt: T0 },
      { source: "lane2", state: "unavailable" as const, detail: "no Lane-2 event store is configured" },
    ]
    stubFetch([() => json(200, feed({ dataState: "partial", sources }))])

    const state = await load(START, "initial")

    expect(state.phase).toBe("ready")
    expect(state.items).toHaveLength(1)
    expect(state.dataState).toBe("partial")
    expect(state.problem).toBeNull()
    // The affected source is nameable, which is what the warning needs.
    const down = state.sources.filter((s) => s.state === "unavailable")
    expect(down.map((s) => s.source)).toEqual(["lane2"])
  })
})

// ── FORBIDDEN SOURCE ────────────────────────────────────────────

describe("FORBIDDEN_SOURCE: the audit trail is not this accounts to read", () => {
  it("is a 200 feed, and the forbidden source shows no count and no timestamp", async () => {
    const sources = [
      { source: "audit_log", state: "forbidden" as const },
      ...allOk().slice(1),
    ]
    stubFetch([() => json(200, feed({ dataState: "partial", sources }))])

    const state = await load(START, "initial")

    expect(state.phase).toBe("ready")
    expect(state.items).toHaveLength(1)

    const audit = state.sources.find((s) => s.source === "audit_log")
    expect(audit?.state).toBe("forbidden")
    // The API sends neither, and the presentation refuses to show either even if
    // a future version started sending them.
    expect(audit).not.toHaveProperty("fetchedAt")

    const presentation = sourceStatus({ source: "audit_log", state: "forbidden" }, 4)
    expect(presentation.label).toBe("Not permitted")
    expect(presentation.showCount).toBe(false)
    expect(presentation.showFetchedAt).toBe(false)
    expect(presentation.explanation).toContain("not available to this account")
  })
})

// ── ALL SOURCES UNAVAILABLE ──────────────────────────────────────

describe("ALL_SOURCES_UNAVAILABLE: a 503", () => {
  it("is an unavailable screen with a retry, and never an empty list", async () => {
    stubFetch([() => json(503, { error: "activity_unavailable" })])

    const state = await load(START, "initial")

    expect(state.phase).toBe("failed")
    expect(state.problem).toEqual({ kind: "unavailable" })
    expect(state.items).toEqual([])
    // The raw error key never becomes the message a person reads.
    expect(JSON.stringify(state.problem)).not.toContain("activity_unavailable")
  })

  it("RETRYING: the retry replaces the failure with the rows", async () => {
    stubFetch([
      () => json(503, { error: "activity_unavailable" }),
      () => json(200, feed()),
    ])

    const failed = await load(START, "initial")
    expect(failed.problem?.kind).toBe("unavailable")

    // Pressing Try again clears the complaint before the request returns.
    const pending = beginLoad(failed, "refresh")
    expect(pending.phase).toBe("refreshing")
    expect(pending.problem).toBeNull()
    expect(isBusy(pending)).toBe(true)

    const recovered = await load(failed, "refresh")
    expect(recovered.phase).toBe("ready")
    expect(recovered.problem).toBeNull()
    expect(recovered.items).toHaveLength(1)
  })
})

// ── AUTHENTICATION EXPIRED ───────────────────────────────────────

describe("AUTHENTICATION_EXPIRED: a 401", () => {
  it("stops paginating and does not retry", async () => {
    const withCursor: FeedState = {
      ...START,
      phase: "ready",
      items: [item()],
      nextCursor: "CURSOR-1",
    }
    const { impl } = stubFetch([() => json(401, { error: "Unauthorized" })])

    const state = await load(withCursor, "more")

    expect(state.problem).toEqual({ kind: "auth_expired" })
    // The cursor is dropped, so there is no Load more left to press and nothing
    // that could turn an expired session into a retry loop.
    expect(state.nextCursor).toBeNull()
    expect(canLoadMore(state)).toBe(false)
    // Exactly one request. No automatic second attempt.
    expect(impl).toHaveBeenCalledTimes(1)
    // Rows already fetched are still true and stay on screen.
    expect(state.items).toHaveLength(1)
    expect(state.phase).toBe("ready")
  })
})

// ── INVALID FILTER ───────────────────────────────────────────────

describe("INVALID_FILTER: a sanitized 400", () => {
  it("names the parameter and shows the detail the API wrote", async () => {
    stubFetch([
      () =>
        json(400, {
          error: "invalid_query",
          parameter: "pageSize",
          code: "invalid_page_size",
          detail: "pageSize may not exceed 100",
        }),
    ])

    const state = await load(START, "initial")

    expect(state.problem).toEqual({
      kind: "invalid_filter",
      parameter: "pageSize",
      detail: "pageSize may not exceed 100",
    })
    expect(state.phase).toBe("failed")
  })

  it("falls back to plain wording when the API sends no detail", async () => {
    stubFetch([() => json(400, { error: "invalid_query", parameter: "actor" })])
    const state = await load(START, "initial")
    expect(state.problem).toMatchObject({ kind: "invalid_filter", parameter: "actor" })
    expect((state.problem as { detail: string }).detail).toBe(
      "That filter is not one this list can use.",
    )
  })
})

// ── INVALID CURSOR ───────────────────────────────────────────────

describe("INVALID_CURSOR: the server refuses the position we held", () => {
  it("restarts at page one instead of dead-ending, exactly once", async () => {
    const onPageTwo: FeedState = {
      ...START,
      phase: "ready",
      items: [item({ activityId: "old-1" })],
      nextCursor: "STALE-CURSOR",
    }
    const { urls, impl } = stubFetch([
      () =>
        json(400, {
          error: "invalid_query",
          parameter: "cursor",
          code: "malformed_cursor",
          detail: "this cursor belongs to a different set of filters",
        }),
      () => json(200, feed({ items: [item({ activityId: "fresh-1" })] })),
    ])

    const state = await load(onPageTwo, "more")

    expect(impl).toHaveBeenCalledTimes(2)
    expect(urls[0]).toContain("cursor=STALE-CURSOR")
    // The second attempt carries no cursor at all: page one, not a guess at
    // where page two might have been.
    expect(urls[1]).not.toContain("cursor")

    expect(state.cursorWasReset).toBe(true)
    expect(state.phase).toBe("ready")
    // The stale rows are gone, replaced by page one, rather than page one being
    // appended underneath them.
    expect(state.items.map((i) => i.activityId)).toEqual(["fresh-1"])
    expect(state.problem).toBeNull()
  })

  it("does not loop when page one fails as well", async () => {
    const onPageTwo: FeedState = { ...START, phase: "ready", nextCursor: "STALE" }
    const { impl } = stubFetch([
      () => json(400, { error: "invalid_query", parameter: "cursor", code: "malformed_cursor", detail: "the cursor is not valid" }),
      () => json(503, { error: "activity_unavailable" }),
    ])

    const state = await load(onPageTwo, "more")

    expect(impl).toHaveBeenCalledTimes(2)
    expect(state.problem).toEqual({ kind: "unavailable" })
  })
})

// ── PAGINATION ──────────────────────────────────────────────────

describe("pagination uses the server cursor verbatim", () => {
  it("first page then second page, with zero duplicates", async () => {
    const page1 = feed({
      items: [item({ activityId: "a-1" }), item({ activityId: "a-2" })],
      nextCursor: "SERVER-CURSOR-1",
    })
    const page2 = feed({
      items: [item({ activityId: "a-3" }), item({ activityId: "a-4" })],
      nextCursor: null,
    })
    const { urls } = stubFetch([() => json(200, page1), () => json(200, page2)])

    const first = await load(START, "initial")
    expect(first.items.map((i) => i.activityId)).toEqual(["a-1", "a-2"])
    expect(first.nextCursor).toBe("SERVER-CURSOR-1")
    expect(canLoadMore(first)).toBe(true)

    const second = await load(first, "more")

    // The cursor is sent back exactly as it arrived. Nothing is built here and
    // no offset is emulated.
    expect(urls[1]).toContain("cursor=SERVER-CURSOR-1")
    expect(urls[0]).not.toContain("cursor")

    const ids = second.items.map((i) => i.activityId)
    expect(ids).toEqual(["a-1", "a-2", "a-3", "a-4"])
    expect(new Set(ids).size).toBe(ids.length)
    expect(second.duplicatesDropped).toBe(0)
    expect(second.nextCursor).toBeNull()
    expect(canLoadMore(second)).toBe(false)
  })

  it("a repeated row from the server still cannot appear twice on screen", async () => {
    const page1 = feed({ items: [item({ activityId: "a-1" })], nextCursor: "C1" })
    const page2 = feed({
      items: [item({ activityId: "a-1" }), item({ activityId: "a-2" })],
      nextCursor: null,
    })
    stubFetch([() => json(200, page1), () => json(200, page2)])

    const second = await load(await load(START, "initial"), "more")

    expect(second.items.map((i) => i.activityId)).toEqual(["a-1", "a-2"])
    expect(second.duplicatesDropped).toBe(1)
  })

  it("Load more is refused while a request is already in flight", () => {
    const busy: FeedState = { ...START, phase: "loading_more", nextCursor: "C1" }
    expect(canLoadMore(busy)).toBe(false)
    expect(isBusy(busy)).toBe(true)
  })
})

// ── FILTERS ─────────────────────────────────────────────────────

describe("filters", () => {
  const filters: ActivityFilters = {
    ...EMPTY_FILTERS,
    source: ["approval_request"],
    ownershipState: ["human"],
    customer: "cust-9",
  }

  it("CHANGED FILTER: a fresh query drops the cursor", async () => {
    const onPageTwo: FeedState = {
      ...START,
      phase: "ready",
      items: [item()],
      nextCursor: "SERVER-CURSOR-1",
    }
    const { urls } = stubFetch([() => json(200, feed())])

    // What the hook does when semanticKey changes.
    const restarted = resetForFilters(onPageTwo)
    expect(restarted.items).toEqual([])
    expect(restarted.nextCursor).toBeNull()

    const state = await load(restarted, "initial", filters)

    expect(urls[0]).not.toContain("cursor")
    expect(urls[0]).toContain("source=approval_request")
    expect(state.items).toHaveLength(1)
  })

  it("REFRESH: the filters are kept and the cursor is not sent", async () => {
    const ready: FeedState = { ...START, phase: "ready", items: [item()], nextCursor: "C1" }
    const { urls } = stubFetch([() => json(200, feed())])

    await load(ready, "refresh", filters)

    expect(urls[0]).toContain("source=approval_request")
    expect(urls[0]).toContain("ownershipState=human")
    expect(urls[0]).toContain("customer=cust-9")
    // A refresh asks the same question from the beginning, not from page two.
    expect(urls[0]).not.toContain("cursor")
  })

  it("round-trips through the URL so refresh and back show the same list", () => {
    const params = filtersToParams(filters)
    expect(filtersFromParams(params)).toEqual(filters)
    expect(isFilterActive(filters)).toBe(true)
    expect(isFilterActive(EMPTY_FILTERS)).toBe(false)
  })

  it("serialises the same filters the same way every time", () => {
    const a = { ...EMPTY_FILTERS, source: ["lane2", "audit_log"] }
    const b = { ...EMPTY_FILTERS, source: ["audit_log", "lane2"] }
    expect(filtersToParams(a).toString()).toBe(filtersToParams(b).toString())
    expect(semanticKey(a)).toBe(semanticKey(b))
  })

  it("page size does not change WHICH rows exist, so it is not part of the key", () => {
    const ten = { ...EMPTY_FILTERS, pageSize: "10" }
    const fifty = { ...EMPTY_FILTERS, pageSize: "50" }
    // The server fingerprint excludes pageSize too. If these disagreed we would
    // throw away cursors the server would have honoured.
    expect(semanticKey(ten)).toBe(semanticKey(fifty))
  })

  it("offers no free-text search parameter, because the API implements none", () => {
    expect(SUPPORTED_FILTER_KEYS).toEqual([
      "source",
      "eventFamily",
      "ownershipState",
      "status",
      "occurredFrom",
      "occurredTo",
      "customer",
      "actor",
      "pageSize",
    ])
    for (const forbidden of ["q", "query", "search", "text"]) {
      expect(SUPPORTED_FILTER_KEYS as readonly string[]).not.toContain(forbidden)
    }
  })
})

// ── the boundary itself ───────────────────────────────────────────

describe("nothing from an exception reaches the caller", () => {
  it("a thrown fetch becomes a kind, not a hostname", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.1.2.3:5432 at postgres.internal")
      }),
    )

    const outcome = await fetchActivityPage({ filters: EMPTY_FILTERS, cursor: null })

    expect(outcome).toEqual({ ok: false, problem: { kind: "unexpected" } })
    const rendered = JSON.stringify(outcome)
    expect(rendered).not.toContain("10.1.2.3")
    expect(rendered).not.toContain("postgres.internal")
    expect(rendered).not.toContain("ECONNREFUSED")
  })

  it("a 200 that is not a feed is unexpected, not a list of undefined rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })),
    )
    const outcome = await fetchActivityPage({ filters: EMPTY_FILTERS, cursor: null })
    expect(outcome).toEqual({ ok: false, problem: { kind: "unexpected" } })
  })

  it("a failed refresh keeps the rows that already arrived", () => {
    const ready: FeedState = { ...START, phase: "ready", items: [item(), item({ activityId: "b" })] }
    const after = applyFailure(ready, "refresh", { kind: "unexpected" })
    expect(after.items).toHaveLength(2)
    expect(after.phase).toBe("ready")
  })
})

// ── presentation rules ────────────────────────────────────────────

describe("presentation rules that a reader depends on", () => {
  it("a failed readback never reads as a success", () => {
    const presentation = statusPresentation("readback_failed")
    expect(presentation.tone).toBe("failure")
    expect(presentation.label).toBe("Not confirmed")
    expect(presentation.note).toContain("not confirmed")
    // Failure is matched BEFORE success, so a compound status cannot flip.
    expect(statusPresentation("completed_readback_failed").tone).toBe("failure")
    expect(statusPresentation("activity_readback_failed").tone).toBe("failure")
  })

  it("an unknown actor stays unknown and is never guessed from the reference", () => {
    expect(actorLabel({ label: null })).toBe("Unknown")
    expect(actorLabel({ label: "   " })).toBe("Unknown")
    expect(actorLabel(null)).toBe("Unknown")
    expect(actorLabel(undefined)).toBe("Unknown")
    expect(actorLabel({ label: "Maria" })).toBe("Maria")
  })

  it("unreachable and not-permitted are worded so they cannot be confused", () => {
    const unreachable = sourceStatus({ source: "lane2", state: "unavailable" }, 0)
    const refused = sourceStatus({ source: "audit_log", state: "forbidden" }, 0)
    expect(unreachable.label).not.toBe(refused.label)
    expect(unreachable.explanation).toContain("could not reach")
    expect(refused.explanation).toContain("not available to this account")
  })

  it("empty is not the same as unavailable", () => {
    expect(sourceStatus({ source: "lane2", state: "ok" }, 0).label).toBe("Nothing to show")
    expect(sourceStatus({ source: "lane2", state: "unavailable" }, 0).label).toBe("Unavailable")
  })

  it("STALE reads as older information rather than as current", () => {
    const stale = sourceStatus({ source: "lane2", state: "stale", fetchedAt: T0 }, 3)
    expect(stale.label).toBe("Older information")
    expect(stale.showFetchedAt).toBe(true)
  })

  it("never prints a bare source key", () => {
    for (const source of SOURCES) expect(sourceLabel(source)).not.toBe(source)
    expect(sourceLabel("some_new_source")).toBe("Some new source")
    expect(humanise("")).toBe("Unknown")
  })

  it("only an absolute http link survives", () => {
    expect(safeHref("https://odoo.example/web#id=4")).toBe("https://odoo.example/web#id=4")
    expect(safeHref("http://a.test/x")).toBe("http://a.test/x")
    expect(safeHref("javascript:alert(1)")).toBeNull()
    expect(safeHref("/relative")).toBeNull()
    expect(safeHref(null)).toBeNull()
    expect(safeHref("")).toBeNull()
  })

  it("a row stamped in the future reads as just now, not as a prediction", () => {
    expect(relativeTime("2026-07-31T23:00:00.000Z", NOW)).toBe("Just now")
    expect(relativeTime("2026-07-31T21:00:00.000Z", NOW)).toBe("1 hour ago")
    expect(relativeTime(null, NOW)).toBe("Unknown time")
    expect(relativeTime("not a date", NOW)).toBe("Unknown time")
  })
})
