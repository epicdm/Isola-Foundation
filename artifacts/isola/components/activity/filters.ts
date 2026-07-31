/**
 * The filter model, and the only place a URL is turned into one or back again.
 *
 * EXACTLY THE PARAMETERS THE API IMPLEMENTS, AND NO OTHERS.
 * parseActivityQuery rejects an unknown parameter with a 400 rather than
 * ignoring it, so anything invented here does not degrade quietly, it breaks the
 * page. That is the right trade and it is also why this list is a constant that
 * a test can compare against the server list.
 *
 * THERE IS NO SEARCH BOX, AND THAT IS DELIBERATE
 * ----------------------------------------------
 * The endpoint implements no free-text parameter. A search box on this screen
 * could therefore only filter the rows already downloaded, while looking to the
 * reader like a search of everything. On a cursor-paged feed that means typing a
 * customer name, seeing two results, and concluding there are two, when the
 * other nine are on pages that were never fetched. A missing feature is
 * recoverable; a search that silently lies is not.
 *
 * The same URL is the address bar and the API query. Reflecting filters in the
 * address bar is not decoration: refresh, back, and a pasted link all have to
 * show the same list, or a reader cannot share what they are looking at.
 */

/** Repeatable in the query string; each value widens the filter. */
export const LIST_FILTER_KEYS = ["source", "eventFamily", "ownershipState", "status"] as const

/** At most one value each. */
export const SCALAR_FILTER_KEYS = [
  "occurredFrom",
  "occurredTo",
  "customer",
  "actor",
  "pageSize",
] as const

export const SUPPORTED_FILTER_KEYS = [...LIST_FILTER_KEYS, ...SCALAR_FILTER_KEYS] as const

export interface ActivityFilters {
  source: string[]
  eventFamily: string[]
  ownershipState: string[]
  status: string[]
  occurredFrom: string
  occurredTo: string
  customer: string
  actor: string
  pageSize: string
}

export const EMPTY_FILTERS: ActivityFilters = {
  source: [],
  eventFamily: [],
  ownershipState: [],
  status: [],
  occurredFrom: "",
  occurredTo: "",
  customer: "",
  actor: "",
  pageSize: "",
}

/** Anything with getAll/get: URLSearchParams, or the Next.js read-only wrapper. */
export interface ReadableParams {
  get(key: string): string | null
  getAll(key: string): string[]
}

export function filtersFromParams(params: ReadableParams): ActivityFilters {
  const list = (key: string) =>
    params
      .getAll(key)
      .map((value) => value.trim())
      .filter(Boolean)

  const scalar = (key: string) => (params.get(key) ?? "").trim()

  return {
    source: list("source"),
    eventFamily: list("eventFamily"),
    ownershipState: list("ownershipState"),
    status: list("status"),
    occurredFrom: scalar("occurredFrom"),
    occurredTo: scalar("occurredTo"),
    customer: scalar("customer"),
    actor: scalar("actor"),
    pageSize: scalar("pageSize"),
  }
}

/**
 * Always in the same order, and empty values are omitted rather than sent blank.
 *
 * Order matters because this string is compared, put in the address bar and used
 * as a React key; a set of filters that serialises two different ways would look
 * like two different questions. Blank values matter because the parser rejects a
 * parameter that is present with no value.
 */
export function filtersToParams(filters: ActivityFilters): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of LIST_FILTER_KEYS) {
    for (const value of [...filters[key]].sort()) {
      if (value) params.append(key, value)
    }
  }
  for (const key of SCALAR_FILTER_KEYS) {
    const value = filters[key]
    if (value) params.set(key, value)
  }
  return params
}

/** The querystring for the API, cursor included when there is one. */
export function activityQueryString(
  filters: ActivityFilters,
  cursor: string | null,
): string {
  const params = filtersToParams(filters)
  if (cursor) params.set("cursor", cursor)
  const query = params.toString()
  return query ? "?" + query : ""
}

/**
 * Everything that changes WHICH rows exist. pageSize is excluded.
 *
 * This mirrors filterFingerprint on the server exactly, and it has to. The
 * server wraps every cursor against its own fingerprint and refuses one issued
 * for a different set of filters, so if this key changed on pageSize while the
 * server fingerprint did not, every page-size change would throw away a cursor
 * the server would happily have honoured; and if it ignored something the server
 * counts, we would keep sending cursors the server is about to reject.
 */
export function semanticKey(filters: ActivityFilters): string {
  return JSON.stringify([
    [...filters.source].sort(),
    [...filters.eventFamily].sort(),
    [...filters.ownershipState].sort(),
    [...filters.status].sort(),
    filters.occurredFrom,
    filters.occurredTo,
    filters.customer,
    filters.actor,
  ])
}

/** True when the reader has narrowed the list in any way at all. */
export function isFilterActive(filters: ActivityFilters): boolean {
  return semanticKey(filters) !== semanticKey(EMPTY_FILTERS)
}

/** A copy with one list filter set to zero or one value. */
export function withListFilter(
  filters: ActivityFilters,
  key: (typeof LIST_FILTER_KEYS)[number],
  value: string,
): ActivityFilters {
  return { ...filters, [key]: value ? [value] : [] }
}

export function withScalarFilter(
  filters: ActivityFilters,
  key: (typeof SCALAR_FILTER_KEYS)[number],
  value: string,
): ActivityFilters {
  return { ...filters, [key]: value.trim() }
}
