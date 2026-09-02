/**
 * Defect 3, at the controller: a cursor the address bar carried, and the 400.
 *
 * This is the scenario as reported. `?cursor=garbage` makes the API answer
 *
 *   {"error":"invalid_query","parameter":"cursor","code":"malformed_cursor",
 *    "detail":"the cursor is not valid"}
 *
 * The page used to strip the cursor before the request, so the server was never
 * asked and the reader got a perfectly ordinary page one -- a request refused
 * and reported as a success. The cursor is now sent, the refusal is real, the
 * recovery to page one is kept, and the state carries the evidence that it
 * happened so the view can say so.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import { initialFeedState, runLoad, type FeedState } from "./feed-controller"
import { EMPTY_FILTERS } from "./filters"

const NOW = new Date("2026-07-31T22:05:00.000Z")

const MALFORMED_CURSOR = {
  error: "invalid_query",
  parameter: "cursor",
  code: "malformed_cursor",
  detail: "the cursor is not valid",
}

function page(items: { activityId: string }[], nextCursor: string | null = null) {
  return {
    version: 1,
    dataState: "available_with_records",
    containsFixture: false,
    generatedAt: "2026-07-31T22:00:00.000Z",
    items: items.map((item) => ({ ...item })),
    nextCursor,
    sources: [{ source: "lane2", state: "ok" }],
  }
}

function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a cursor from the address bar", () => {
  it("is sent on the first load, exactly as it arrived", async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return json(200, page([{ activityId: "a-1" }]))
    }) as unknown as typeof fetch

    await runLoad(
      initialFeedState(),
      { mode: "initial", filters: EMPTY_FILTERS, initialCursor: "SERVER-CURSOR" },
      { fetchImpl, now: () => NOW },
    )

    expect(urls).toEqual(["/api/v1/activity?cursor=SERVER-CURSOR"])
  })

  it("REGRESSION: a refused cursor is not reported as a successful page one", async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      // The first call carries the bad cursor and is refused; the retry does not.
      return url.includes("cursor=")
        ? json(400, MALFORMED_CURSOR)
        : json(200, page([{ activityId: "a-1" }, { activityId: "a-2" }]))
    }) as unknown as typeof fetch

    const state: FeedState = await runLoad(
      initialFeedState(),
      { mode: "initial", filters: EMPTY_FILTERS, initialCursor: "garbage" },
      { fetchImpl, now: () => NOW },
    )

    // The server was actually asked, and actually refused.
    expect(urls[0]).toBe("/api/v1/activity?cursor=garbage")
    // The recovery is right and is kept: page one, fetched without the cursor.
    expect(urls[1]).toBe("/api/v1/activity")
    expect(urls).toHaveLength(2)
    expect(state.items.map((item) => item.activityId)).toEqual(["a-1", "a-2"])

    // AND the state still remembers that the request was refused. Without this
    // flag the view has no way to tell this apart from an ordinary first load,
    // which is exactly how it came to claim "Complete".
    expect(state.cursorWasReset).toBe(true)
  })

  it("retries once and only once: a second failure is reported, not looped", async () => {
    const fetchImpl = vi.fn(async () => json(400, MALFORMED_CURSOR)) as unknown as typeof fetch

    const state = await runLoad(
      initialFeedState(),
      { mode: "initial", filters: EMPTY_FILTERS, initialCursor: "garbage" },
      { fetchImpl, now: () => NOW },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(state.problem).toEqual({ kind: "invalid_cursor", detail: "the cursor is not valid" })
    expect(state.cursorWasReset).toBe(true)
    expect(state.phase).toBe("failed")
  })

  it("is not resent by Refresh: Refresh means the newest records", async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return json(200, page([{ activityId: "a-1" }]))
    }) as unknown as typeof fetch

    await runLoad(
      initialFeedState(),
      { mode: "refresh", filters: EMPTY_FILTERS, initialCursor: "garbage" },
      { fetchImpl, now: () => NOW },
    )

    expect(urls).toEqual(["/api/v1/activity"])
  })

  it("is not resent by Load more: that has the server's own cursor", async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return json(200, page([{ activityId: "a-2" }]))
    }) as unknown as typeof fetch

    await runLoad(
      { ...initialFeedState(), nextCursor: "FROM-SERVER" },
      { mode: "more", filters: EMPTY_FILTERS, initialCursor: "garbage" },
      { fetchImpl, now: () => NOW },
    )

    expect(urls).toEqual(["/api/v1/activity?cursor=FROM-SERVER"])
  })

  it("no cursor in the address behaves exactly as before", async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return json(200, page([{ activityId: "a-1" }]))
    }) as unknown as typeof fetch

    const state = await runLoad(
      initialFeedState(),
      { mode: "initial", filters: EMPTY_FILTERS },
      { fetchImpl, now: () => NOW },
    )

    expect(urls).toEqual(["/api/v1/activity"])
    expect(state.cursorWasReset).toBe(false)
  })
})
