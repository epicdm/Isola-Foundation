/**
 * activity.query@1 — the ONE parser for the activity feed.
 *
 * The route does not validate slightly differently from the feed, and the
 * adapters do not validate at all. There is one place that turns a URL into an
 * `ActivityQuery`, and it either succeeds or names what was wrong.
 *
 * A silently ignored query parameter is the worst outcome available here: the
 * caller believes they filtered, they did not, and the screen looks correct. So
 * an unknown parameter is an error, not a shrug.
 */

import { createHash } from 'node:crypto'

import {
  DEFAULT_PAGE_SIZE,
  EVENT_TYPES,
  MAX_PAGE_SIZE,
  decodeCursor,
  type ActivityQuery,
} from './feed'

export const ACTIVITY_QUERY_VERSION = 'activity.query@1' as const
export const CURSOR_VERSION = 'activity.cursor@1' as const

/** Exactly the parameters this endpoint implements. */
export const SCALAR_PARAMS = [
  'company',
  'customer',
  'contact',
  'service',
  'device',
  'pbx',
  'issue',
  'task',
  'opportunity',
  'actor',
  'occurredFrom',
  'occurredTo',
  'cursor',
  'pageSize',
] as const

/** May legitimately repeat; each occurrence widens the filter. */
export const LIST_PARAMS = ['source', 'eventFamily', 'status', 'ownershipState'] as const

export const SUPPORTED_PARAMS = [...SCALAR_PARAMS, ...LIST_PARAMS] as const

export const OWNERSHIP_STATES = ['ai', 'human', 'unknown'] as const

export type QueryRejection =
  | 'unknown_parameter'
  | 'duplicate_parameter'
  | 'blank_value'
  | 'malformed_identifier'
  | 'invalid_date'
  | 'reversed_date_range'
  | 'invalid_source'
  | 'invalid_event_family'
  | 'invalid_ownership_state'
  | 'invalid_page_size'
  | 'malformed_cursor'

export type ParseResult =
  | { ok: true; query: ActivityQuery; fingerprint: string }
  | { ok: false; rejection: QueryRejection; parameter: string; detail: string }

const ID = /^[A-Za-z0-9_.:@-]{1,128}$/

const reject = (
  rejection: QueryRejection,
  parameter: string,
  detail: string,
): ParseResult => ({ ok: false, rejection, parameter, detail })

/**
 * A hash of everything that changes WHICH rows exist — ownership filter
 * included, because it narrows the candidate set like any other filter. Page
 * size is excluded on purpose: changing how many rows you ask for does not
 * change where you are.
 */
export function filterFingerprint(query: ActivityQuery): string {
  const material = JSON.stringify([
    query.companyId,
    query.customerId ?? null,
    query.contactId ?? null,
    query.serviceId ?? null,
    query.deviceId ?? null,
    query.pbxId ?? null,
    query.issueId ?? null,
    query.taskId ?? null,
    query.opportunityId ?? null,
    query.actorRef ?? null,
    [...(query.sourceSystems ?? [])].sort(),
    [...(query.eventTypes ?? [])].sort(),
    [...(query.statuses ?? [])].sort(),
    [...(query.ownershipStates ?? [])].sort(),
    query.from ?? null,
    query.to ?? null,
  ])
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

interface CursorEnvelope {
  v: typeof CURSOR_VERSION
  f: string
  c: string
}

/** Wraps the feed's own cursor so it cannot be moved to a different query. */
export function encodeActivityCursor(feedCursor: string, fingerprint: string): string {
  const envelope: CursorEnvelope = { v: CURSOR_VERSION, f: fingerprint, c: feedCursor }
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
}

export type CursorCheck =
  | { ok: true; feedCursor: string }
  | { ok: false; reason: 'malformed' | 'unsupported_version' | 'filter_mismatch' }

export function decodeActivityCursor(raw: string, fingerprint: string): CursorCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'malformed' }

  const envelope = parsed as Partial<CursorEnvelope>
  if (envelope.v !== CURSOR_VERSION) return { ok: false, reason: 'unsupported_version' }
  if (typeof envelope.c !== 'string' || !decodeCursor(envelope.c)) {
    return { ok: false, reason: 'malformed' }
  }
  // Replaying a cursor against a different filter set would return a page from
  // somebody else's question. Refuse rather than answer the wrong one.
  if (envelope.f !== fingerprint) return { ok: false, reason: 'filter_mismatch' }

  return { ok: true, feedCursor: envelope.c }
}

function scalar(params: URLSearchParams, name: string): ParseResult | string | null {
  const all = params.getAll(name)
  if (all.length === 0) return null
  if (all.length > 1) {
    return reject('duplicate_parameter', name, `${name} was given more than once`)
  }
  const value = all[0].trim()
  if (!value) return reject('blank_value', name, `${name} was given with no value`)
  return value
}

function identifier(params: URLSearchParams, name: string): ParseResult | string | null {
  const v = scalar(params, name)
  if (v === null || typeof v !== 'string') return v
  if (!ID.test(v)) return reject('malformed_identifier', name, `${name} is not a valid identifier`)
  return v
}

function isFailure(v: unknown): v is ParseResult {
  return !!v && typeof v === 'object' && 'ok' in (v as ParseResult)
}

/**
 * @param params the request's query string
 * @param scope  the company the SESSION is scoped to. A `company` parameter may
 *               narrow to it but never widen past it; the feed refuses anything
 *               outside the permitted set anyway, and it refuses identically for
 *               a company that does not exist.
 */
export function parseActivityQuery(
  params: URLSearchParams,
  scope: { companyId: string; knownSources: readonly string[] },
): ParseResult {
  for (const key of params.keys()) {
    if (!(SUPPORTED_PARAMS as readonly string[]).includes(key)) {
      return reject('unknown_parameter', key, `${key} is not a filter this endpoint implements`)
    }
  }

  const ids: Record<string, string | null> = {}
  for (const name of [
    'company',
    'customer',
    'contact',
    'service',
    'device',
    'pbx',
    'issue',
    'task',
    'opportunity',
    'actor',
  ] as const) {
    const v = identifier(params, name)
    if (isFailure(v)) return v
    ids[name] = v
  }

  const dates: Record<string, string | null> = {}
  for (const name of ['occurredFrom', 'occurredTo'] as const) {
    const v = scalar(params, name)
    if (isFailure(v)) return v
    if (v !== null && Number.isNaN(new Date(v).getTime())) {
      return reject('invalid_date', name, `${name} is not a date`)
    }
    dates[name] = v
  }
  if (
    dates.occurredFrom &&
    dates.occurredTo &&
    new Date(dates.occurredTo).getTime() < new Date(dates.occurredFrom).getTime()
  ) {
    return reject('reversed_date_range', 'occurredTo', 'the range ends before it begins')
  }

  const sources = params.getAll('source').map((s) => s.trim()).filter(Boolean)
  for (const s of sources) {
    if (!scope.knownSources.includes(s)) {
      return reject('invalid_source', 'source', `${s} is not a source this endpoint reads`)
    }
  }

  const families = params.getAll('eventFamily').map((s) => s.trim()).filter(Boolean)
  for (const f of families) {
    if (!(EVENT_TYPES as readonly string[]).includes(f)) {
      return reject('invalid_event_family', 'eventFamily', `${f} is not an event family`)
    }
  }

  const ownership = params.getAll('ownershipState').map((s) => s.trim()).filter(Boolean)
  for (const o of ownership) {
    if (!(OWNERSHIP_STATES as readonly string[]).includes(o)) {
      return reject('invalid_ownership_state', 'ownershipState', `${o} is not an ownership state`)
    }
  }

  const statuses = params.getAll('status').map((s) => s.trim()).filter(Boolean)

  const rawPageSize = scalar(params, 'pageSize')
  if (isFailure(rawPageSize)) return rawPageSize
  let pageSize = DEFAULT_PAGE_SIZE
  if (rawPageSize !== null) {
    if (!/^\d+$/.test(rawPageSize)) {
      return reject('invalid_page_size', 'pageSize', 'pageSize must be a whole number')
    }
    const n = Number(rawPageSize)
    // Explicit contract: zero and oversized are ERRORS, not silent corrections.
    // A caller who asked for 5000 rows should learn they cannot have them.
    if (n < 1) return reject('invalid_page_size', 'pageSize', 'pageSize must be at least 1')
    if (n > MAX_PAGE_SIZE) {
      return reject('invalid_page_size', 'pageSize', `pageSize may not exceed ${MAX_PAGE_SIZE}`)
    }
    pageSize = n
  }

  const query: ActivityQuery = {
    companyId: ids.company ?? scope.companyId,
    customerId: ids.customer,
    contactId: ids.contact,
    serviceId: ids.service,
    deviceId: ids.device,
    pbxId: ids.pbx,
    issueId: ids.issue,
    taskId: ids.task,
    opportunityId: ids.opportunity,
    actorRef: ids.actor,
    eventTypes: families.length ? families : null,
    sourceSystems: sources.length ? sources : null,
    statuses: statuses.length ? statuses : null,
    // Narrows the candidate set inside the feed, BEFORE ordering and slicing.
    // Filtering a page after it is cut gives short pages, counts that disagree
    // with what is shown, and rows that turn up again later.
    ownershipStates: ownership.length ? ownership : null,
    from: dates.occurredFrom,
    to: dates.occurredTo,
    cursor: null,
    pageSize,
  }

  const fingerprint = filterFingerprint(query)

  const rawCursor = scalar(params, 'cursor')
  if (isFailure(rawCursor)) return rawCursor
  if (rawCursor !== null) {
    const check = decodeActivityCursor(rawCursor, fingerprint)
    if (!check.ok) {
      return reject(
        'malformed_cursor',
        'cursor',
        check.reason === 'filter_mismatch'
          ? 'this cursor belongs to a different set of filters'
          : check.reason === 'unsupported_version'
            ? 'this cursor was issued by an older version of the API'
            : 'the cursor is not valid',
      )
    }
    query.cursor = check.feedCursor
  }

  return { ok: true, query, fingerprint }
}
