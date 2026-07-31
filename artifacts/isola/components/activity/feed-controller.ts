/**
 * Everything Recent Work DECIDES, with no React in it.
 *
 * The hook in use-activity-feed.ts is a twenty-line wrapper around these
 * functions. That split is the whole reason this screen can be tested at all:
 * there is no jsdom and no testing-library in this workspace, so logic that
 * lived inside a component would be logic nobody could exercise. Here, every
 * state the reader can reach is reproducible by calling runLoad with a stubbed
 * fetch, in node, deterministically.
 *
 * THE FOUR RULES
 * --------------
 * 1. ROWS ALREADY ON SCREEN SURVIVE A FAILURE. A refresh that fails leaves the
 *    records we already fetched exactly where they were and adds a warning. The
 *    alternative -- blanking a working list because one later request fell over
 *    -- destroys information the reader already had.
 * 2. A 401 STOPS PAGING. nextCursor is cleared, so there is no Load more to
 *    press and nothing that could turn an expired session into a retry loop.
 * 3. A REFUSED CURSOR RESTARTS AT PAGE ONE, ONCE. Dead-ending in the middle of
 *    a list is worse than starting again, and the reader is told it happened.
 *    Once, never in a loop: if page one also fails, that failure is reported.
 * 4. NOTHING FROM AN EXCEPTION REACHES THE SCREEN. Network errors carry
 *    hostnames and ports. They are turned into a kind and discarded here.
 */

import { activityQueryString, type ActivityFilters } from "./filters"
import type {
  ActivityFeedItem,
  ActivityFeedResponse,
  ActivitySourceReport,
  DataState,
} from "./types"

export const ACTIVITY_ENDPOINT = "/api/v1/activity"

export type LoadMode = "initial" | "refresh" | "more"

/**
 * What went wrong, as a kind rather than a message.
 *
 * Only invalid_filter and invalid_cursor carry text, and that text is the
 * sanitised "detail" the API itself produced for the reader ("pageSize may not
 * exceed 100"). Everything else is a kind, and the sentence shown for it is
 * written in the view where a person can read it in context.
 */
export type FeedProblem =
  | { kind: "unavailable" }
  | { kind: "auth_expired" }
  | { kind: "not_permitted" }
  | { kind: "invalid_filter"; parameter: string; detail: string }
  | { kind: "invalid_cursor"; detail: string }
  | { kind: "unexpected" }

export type FeedPhase = "idle" | "loading" | "refreshing" | "loading_more" | "ready" | "failed"

export interface FeedState {
  phase: FeedPhase
  items: ActivityFeedItem[]
  sources: ActivitySourceReport[]
  dataState: DataState | null
  containsFixture: boolean
  /** When the API says it built this answer. */
  generatedAt: string | null
  nextCursor: string | null
  /** When WE last got a good answer. Different question, both worth showing. */
  lastLoadedAt: string | null
  problem: FeedProblem | null
  /** True when a refused cursor was thrown away and page one fetched instead. */
  cursorWasReset: boolean
  /**
   * Rows a later page tried to add that were already on screen. Kept in state
   * rather than dropped silently so a test can assert it is zero across a
   * two-page walk, and so a duplicate would be visible rather than merely absent.
   */
  duplicatesDropped: number
}

export function initialFeedState(): FeedState {
  return {
    phase: "idle",
    items: [],
    sources: [],
    dataState: null,
    containsFixture: false,
    generatedAt: null,
    nextCursor: null,
    lastLoadedAt: null,
    problem: null,
    cursorWasReset: false,
    duplicatesDropped: 0,
  }
}

export function isBusy(state: FeedState): boolean {
  return state.phase === "loading" || state.phase === "refreshing" || state.phase === "loading_more"
}

/**
 * Load more is offered only when the SERVER gave us a cursor, nothing is in
 * flight, and the session is still good. No cursor is ever constructed here and
 * no offset is ever emulated: the server owns where page two begins.
 */
export function canLoadMore(state: FeedState): boolean {
  if (!state.nextCursor) return false
  if (isBusy(state)) return false
  return state.problem?.kind !== "auth_expired"
}

/** Rows on the current page, counted per source, for the source panel. */
export function rowsPerSource(items: readonly ActivityFeedItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const source = item.provenance?.source
    if (!source) continue
    counts.set(source, (counts.get(source) ?? 0) + 1)
  }
  return counts
}

// ── the HTTP boundary ─────────────────────────────────────────────

export type FetchOutcome =
  | { ok: true; body: ActivityFeedResponse }
  | { ok: false; problem: FeedProblem }

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json()
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * A 200 body is checked before it is trusted. A deploy that put something else
 * behind this path -- an HTML error page, a proxy notice -- must land in
 * "unexpected" rather than render as a feed of undefined rows.
 */
function isFeedResponse(body: unknown): body is ActivityFeedResponse {
  if (!body || typeof body !== "object") return false
  const candidate = body as Record<string, unknown>
  return (
    Array.isArray(candidate.items) &&
    Array.isArray(candidate.sources) &&
    typeof candidate.generatedAt === "string"
  )
}

export interface FetchPageInput {
  filters: ActivityFilters
  cursor: string | null
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export async function fetchActivityPage(input: FetchPageInput): Promise<FetchOutcome> {
  // Resolved at CALL time, not at module load, so a test that replaces the
  // global fetch after import is actually the one that answers.
  const doFetch = input.fetchImpl ?? globalThis.fetch
  const url = ACTIVITY_ENDPOINT + activityQueryString(input.filters, input.cursor)

  let response: Response
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: input.signal,
    })
  } catch {
    // The exception here can name a host, a port or a certificate. None of that
    // is the readers business, and none of it survives this line.
    return { ok: false, problem: { kind: "unexpected" } }
  }

  if (response.status === 401) return { ok: false, problem: { kind: "auth_expired" } }
  if (response.status === 403) return { ok: false, problem: { kind: "not_permitted" } }
  if (response.status === 503) return { ok: false, problem: { kind: "unavailable" } }

  if (response.status === 400) {
    const body = await readJson(response)
    const parameter = typeof body?.parameter === "string" ? body.parameter : "filter"
    const code = typeof body?.code === "string" ? body.code : ""
    const rawDetail = typeof body?.detail === "string" ? body.detail.trim() : ""
    // The API writes this sentence for a person and sanitises it there. Showing
    // it is the point: a reader who filtered wrongly has to be told WHICH filter
    // or they will believe the empty screen.
    const detail = rawDetail || "That filter is not one this list can use."

    if (parameter === "cursor" || code === "malformed_cursor") {
      return { ok: false, problem: { kind: "invalid_cursor", detail } }
    }
    return { ok: false, problem: { kind: "invalid_filter", parameter, detail } }
  }

  if (!response.ok) return { ok: false, problem: { kind: "unexpected" } }

  const body = await readJson(response)
  if (!isFeedResponse(body)) return { ok: false, problem: { kind: "unexpected" } }
  return { ok: true, body }
}

// ── transitions ──────────────────────────────────────────────────

export function beginLoad(state: FeedState, mode: LoadMode): FeedState {
  return {
    ...state,
    phase: mode === "more" ? "loading_more" : mode === "refresh" ? "refreshing" : "loading",
    // A retry clears the previous complaint. Leaving it up beside a spinner
    // reads as a new failure that has not happened yet.
    problem: null,
    cursorWasReset: false,
    // A refresh keeps the rows visible while it runs. Only a fresh question
    // (a changed filter) empties the list, because those rows answered a
    // question nobody is asking any more.
    items: mode === "initial" ? [] : state.items,
    duplicatesDropped: mode === "more" ? state.duplicatesDropped : 0,
  }
}

export function applySuccess(
  state: FeedState,
  mode: LoadMode,
  body: ActivityFeedResponse,
  at: string,
): FeedState {
  let items: ActivityFeedItem[]
  let duplicatesDropped = state.duplicatesDropped

  if (mode === "more") {
    // The server orders by occurredAt DESC then activityId ASC and cuts the page
    // on that pair, so an overlap should be impossible. It is filtered anyway:
    // a repeated row on page two is the kind of defect that looks like a data
    // problem for weeks, and dropping it costs one Set.
    const seen = new Set(state.items.map((item) => item.activityId))
    const fresh: ActivityFeedItem[] = []
    for (const item of body.items) {
      if (seen.has(item.activityId)) {
        duplicatesDropped += 1
        continue
      }
      seen.add(item.activityId)
      fresh.push(item)
    }
    items = [...state.items, ...fresh]
  } else {
    items = [...body.items]
    duplicatesDropped = 0
  }

  return {
    ...state,
    phase: "ready",
    items,
    sources: body.sources ?? [],
    dataState: body.dataState ?? null,
    // Either the feed said so, or a row on this page says so. Both are reasons
    // to warn that what is on screen is not entirely real.
    containsFixture:
      Boolean(body.containsFixture) || items.some((item) => item.dataMode === "fixture"),
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : null,
    nextCursor: body.nextCursor ?? null,
    lastLoadedAt: at,
    problem: null,
    duplicatesDropped,
  }
}

export function applyFailure(
  state: FeedState,
  _mode: LoadMode,
  problem: FeedProblem,
): FeedState {
  return {
    ...state,
    // Rows already fetched are still true. A failed refresh downgrades to a
    // warning above a list that still works; only a screen with nothing on it
    // becomes a failed screen.
    phase: state.items.length > 0 ? "ready" : "failed",
    problem,
    // An expired session must not leave a Load more button behind. Pressing it
    // would 401 again, and again, for as long as somebody keeps pressing.
    nextCursor: problem.kind === "auth_expired" ? null : state.nextCursor,
  }
}

/** A changed semantic filter is a NEW question. The old cursor cannot answer it. */
export function resetForFilters(state: FeedState): FeedState {
  return { ...initialFeedState(), lastLoadedAt: state.lastLoadedAt }
}

// ── the one entry point ───────────────────────────────────────────

export interface LoadOptions {
  mode: LoadMode
  filters: ActivityFilters
}

export interface LoadDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
  signal?: AbortSignal
}

export async function runLoad(
  state: FeedState,
  options: LoadOptions,
  deps: LoadDeps = {},
): Promise<FeedState> {
  const now = deps.now ?? (() => new Date())

  let mode = options.mode
  let base = beginLoad(state, mode)

  // The cursor comes back from the server untouched and is only ever sent for
  // "more". Refresh and a filter change both start from the beginning.
  const cursor = mode === "more" ? state.nextCursor : null

  let outcome = await fetchActivityPage({
    filters: options.filters,
    cursor,
    fetchImpl: deps.fetchImpl,
    signal: deps.signal,
  })

  let cursorWasReset = false
  if (!outcome.ok && outcome.problem.kind === "invalid_cursor") {
    // Exactly one retry, without the cursor. If page one fails too, that second
    // failure is what gets reported: there is no third attempt and no loop.
    cursorWasReset = true
    mode = "refresh"
    base = { ...base, items: [], nextCursor: null, duplicatesDropped: 0 }
    outcome = await fetchActivityPage({
      filters: options.filters,
      cursor: null,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    })
  }

  const settled = outcome.ok
    ? applySuccess(base, mode, outcome.body, now().toISOString())
    : applyFailure(base, mode, outcome.problem)

  return { ...settled, cursorWasReset }
}
