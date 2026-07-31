/**
 * activity.feed@1 — Foundation's activity query contract.
 *
 * THE THREE THINGS THIS MUST NEVER DO
 * -----------------------------------
 * 1. Report a source failure as an empty feed. "Nothing happened" and "we could
 *    not find out what happened" look identical on screen and mean opposite
 *    things. Every source reports its own state and the feed carries them all.
 * 2. Show a record the actor may not see — including as a redacted placeholder.
 *    A greyed-out row still tells you the record exists, when it exists, how
 *    many there are and which system it came from. Forbidden records are ABSENT.
 * 3. Order by when we heard about something. A Lane-2 event that arrives an hour
 *    late belongs where it HAPPENED, not at the top of the page.
 *
 * This module is query and projection only. It reads. It never sends a message,
 * never changes ownership of a conversation and never writes to a source.
 */

export const ACTIVITY_FEED_VERSION = 'activity.feed@1' as const

/** Every event family the workbench can show. */
export const EVENT_TYPES = [
  'staff.note',
  'business.note',
  'task.created',
  'task.updated',
  'activity.scheduled',
  'lead.created',
  'lead.updated',
  'followup.scheduled',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'governed.action.started',
  'governed.action.completed',
  'governed.action.failed',
  'governed.readback',
  'audit.event',
  'customer.message',
  'clawith.activity',
  'ownership.human_takeover',
  'ownership.human_reply',
  'ownership.handback',
  'channel.health',
  'agent.health',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/**
 * What the caller is actually looking at. Never collapse these: an adapter
 * failure reported as `available_empty` is the bug this whole enum exists for.
 */
export const DATA_STATES = [
  'available_with_records',
  'available_empty',
  'partial',
  'stale',
  'forbidden',
  'unavailable',
  'fixture',
] as const
export type DataState = (typeof DATA_STATES)[number]

export type Trust = 'authoritative' | 'reported' | 'derived'
export type DataMode = 'production' | 'fixture'
export type OwnershipState = 'ai' | 'human' | 'unknown'

export interface ActivityActor {
  ref: string
  label: string
  kind: 'staff' | 'agent' | 'customer' | 'system'
}

export interface NativeLink {
  system: string
  label: string
  href: string
}

export interface Provenance {
  source: string
  fetchedAt: string
  /** How much this source's word is worth. Used to settle duplicates. */
  trust: Trust
  upstreamRef?: string | null
}

export interface ActivityItem {
  activityId: string
  eventType: EventType
  title: string
  summary: string
  sourceSystem: string
  provenance: Provenance
  actor: ActivityActor
  companyId: string
  customerId: string | null
  customerLabel: string | null
  relatedObjectType: string | null
  relatedObjectId: string | null
  occurredAt: string
  receivedAt: string
  status: string
  ownershipState: OwnershipState | null
  availableActions: string[]
  nativeLinks: NativeLink[]
  dataMode: DataMode
}

/** What the caller finally sees, freshness included. */
export interface ActivityFeedItem extends ActivityItem {
  freshness: { ageSeconds: number; stale: boolean }
}

export interface ActivityQuery {
  companyId: string
  customerId?: string | null
  contactId?: string | null
  serviceId?: string | null
  deviceId?: string | null
  pbxId?: string | null
  issueId?: string | null
  taskId?: string | null
  opportunityId?: string | null
  actorRef?: string | null
  eventTypes?: readonly string[] | null
  sourceSystems?: readonly string[] | null
  statuses?: readonly string[] | null
  from?: string | null
  to?: string | null
  cursor?: string | null
  pageSize?: number | null
}

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100
/** A source read older than this is called stale rather than current. */
export const STALE_AFTER_SECONDS = 300

export type SourceResult =
  | { status: 'ok'; items: ActivityItem[]; fetchedAt: string; mode?: DataMode }
  | { status: 'stale'; items: ActivityItem[]; fetchedAt: string; reason: string; mode?: DataMode }
  | { status: 'unavailable'; reason: string }
  | { status: 'forbidden' }

/**
 * An activity source. The method is called `read` and not `fetch` on purpose:
 * this layer reads, and a method named after the network primitive makes the
 * boundary check below unable to tell a port call from an outbound request.
 */
export interface ActivitySource {
  name: string
  read(query: ResolvedQuery): Promise<SourceResult>
}

export interface SourceReport {
  source: string
  state: 'ok' | 'stale' | 'unavailable' | 'forbidden'
  detail?: string
  fetchedAt?: string
  mode?: DataMode
}

export interface ActivityPermissions {
  /** False when the staff principal is unknown or no longer active. */
  actorIsActive(): Promise<boolean>
  /** Companies this actor may see. Empty means none. */
  permittedCompanies(): Promise<readonly string[]>
  mayViewCustomer(customerId: string): Promise<boolean>
  mayViewObject(objectType: string, objectId: string): Promise<boolean>
}

export interface FeedPorts {
  sources: readonly ActivitySource[]
  permissions: ActivityPermissions
  now(): Date
}

export const ACTIVITY_REFUSALS = [
  'unknown_or_inactive_actor',
  'unauthorized_company',
  'invalid_cursor',
  'invalid_filter',
] as const
export type ActivityRefusal = (typeof ACTIVITY_REFUSALS)[number]

export interface ResolvedQuery extends Omit<ActivityQuery, 'cursor' | 'pageSize'> {
  pageSize: number
  cursor: Cursor | null
  permittedCompanies: readonly string[]
}

export type ActivityFeedResult =
  | {
      ok: true
      version: typeof ACTIVITY_FEED_VERSION
      dataState: DataState
      containsFixture: boolean
      items: ActivityFeedItem[]
      nextCursor: string | null
      sources: SourceReport[]
    }
  | {
      ok: false
      version: typeof ACTIVITY_FEED_VERSION
      refusal: ActivityRefusal
      detail: string
    }

// ── cursor ────────────────────────────────────────────────────────

export interface Cursor {
  occurredAt: string
  activityId: string
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const { occurredAt, activityId } = parsed as Partial<Cursor>
    if (typeof occurredAt !== 'string' || typeof activityId !== 'string') return null
    if (Number.isNaN(new Date(occurredAt).getTime())) return null
    return { occurredAt, activityId }
  } catch {
    return null
  }
}

// ── ordering ─────────────────────────────────────────────────────

const ms = (iso: string) => new Date(iso).getTime()

/**
 * occurredAt DESC, then activityId ASC. The second key is not decoration — two
 * events in the same second must come back in the same order every time, or the
 * cursor cannot promise a page boundary.
 */
export function compareItems(a: ActivityItem, b: ActivityItem): number {
  const delta = ms(b.occurredAt) - ms(a.occurredAt)
  if (delta !== 0) return delta
  return a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0
}

/**
 * True when `item` sits strictly after `cursor` in the ordering above.
 *
 * The list runs NEWEST FIRST, so "after" means OLDER. Getting this backwards
 * hands the caller page one for ever, and every page looks correct in isolation.
 */
export function isAfterCursor(item: ActivityItem, cursor: Cursor): boolean {
  const cursorMinusItem = ms(cursor.occurredAt) - ms(item.occurredAt)
  if (cursorMinusItem !== 0) return cursorMinusItem > 0
  return item.activityId > cursor.activityId
}

const TRUST_RANK: Record<Trust, number> = { authoritative: 3, reported: 2, derived: 1 }

/**
 * The same real-world event can reach us from more than one source. Keep the one
 * whose source has the better claim to know; break ties on the earlier arrival,
 * so the result does not change with network timing.
 */
export function dedupe(items: ActivityItem[]): ActivityItem[] {
  const best = new Map<string, ActivityItem>()
  for (const item of items) {
    const held = best.get(item.activityId)
    if (!held) {
      best.set(item.activityId, item)
      continue
    }
    const better =
      TRUST_RANK[item.provenance.trust] - TRUST_RANK[held.provenance.trust] ||
      ms(held.receivedAt) - ms(item.receivedAt)
    if (better > 0) best.set(item.activityId, item)
  }
  return [...best.values()]
}

// ── filters ──────────────────────────────────────────────────────

function matchesQuery(item: ActivityItem, q: ResolvedQuery): boolean {
  if (item.companyId !== q.companyId) return false
  if (q.customerId && item.customerId !== q.customerId) return false
  if (q.actorRef && item.actor.ref !== q.actorRef) return false
  if (q.eventTypes?.length && !q.eventTypes.includes(item.eventType)) return false
  if (q.sourceSystems?.length && !q.sourceSystems.includes(item.sourceSystem)) return false
  if (q.statuses?.length && !q.statuses.includes(item.status)) return false

  const objectFilters: [string | null | undefined, string][] = [
    [q.contactId, 'contact'],
    [q.serviceId, 'service'],
    [q.deviceId, 'device'],
    [q.pbxId, 'pbx'],
    [q.issueId, 'issue'],
    [q.taskId, 'task'],
    [q.opportunityId, 'opportunity'],
  ]
  for (const [value, kind] of objectFilters) {
    if (!value) continue
    if (item.relatedObjectType !== kind || item.relatedObjectId !== value) return false
  }

  if (q.from && ms(item.occurredAt) < ms(q.from)) return false
  if (q.to && ms(item.occurredAt) > ms(q.to)) return false
  return true
}

// ── data state ─────────────────────────────────────────────────

export function deriveDataState(reports: SourceReport[], itemCount: number): DataState {
  const answered = reports.filter((r) => r.state === 'ok' || r.state === 'stale')
  const unavailable = reports.filter((r) => r.state === 'unavailable')
  const forbidden = reports.filter((r) => r.state === 'forbidden')

  if (answered.length === 0) {
    if (unavailable.length > 0) return 'unavailable'
    if (forbidden.length > 0) return 'forbidden'
    return 'available_empty'
  }

  // Some sources answered and some did not. That is a PARTIAL view and saying
  // so is the entire point — the caller must not read it as the whole picture.
  if (unavailable.length > 0 || forbidden.length > 0) return 'partial'

  if (answered.some((r) => r.mode === 'fixture')) return 'fixture'
  if (answered.some((r) => r.state === 'stale')) return 'stale'
  return itemCount === 0 ? 'available_empty' : 'available_with_records'
}

// ── available actions ─────────────────────────────────────────────

/**
 * What a staff member can do FROM this row. Deliberately conservative and
 * deliberately free of anything that would send a message — replying to a
 * customer is not a Foundation action.
 */
export const ACTIONS_BY_EVENT: Readonly<Record<string, readonly string[]>> = {
  'staff.note': ['note.create'],
  'business.note': ['note.create', 'followup.schedule'],
  'task.created': ['note.create', 'activity.schedule'],
  'task.updated': ['note.create', 'activity.schedule'],
  'activity.scheduled': ['note.create'],
  'lead.created': ['lead.update', 'note.create', 'followup.schedule'],
  'lead.updated': ['lead.update', 'note.create', 'followup.schedule'],
  'followup.scheduled': ['note.create'],
  'customer.message': ['note.create', 'task.create', 'followup.schedule'],
  'clawith.activity': ['note.create'],
  'ownership.human_takeover': ['note.create'],
  'ownership.human_reply': ['note.create'],
  'ownership.handback': ['note.create'],
  'governed.action.failed': ['note.create'],
}

export function actionsFor(item: ActivityItem): string[] {
  return [...(ACTIONS_BY_EVENT[item.eventType] ?? [])]
}

// ── the feed ───────────────────────────────────────────────────

const refuse = (refusal: ActivityRefusal, detail: string): ActivityFeedResult => ({
  ok: false,
  version: ACTIVITY_FEED_VERSION,
  refusal,
  detail,
})

export async function getActivityFeed(
  query: ActivityQuery,
  ports: FeedPorts,
): Promise<ActivityFeedResult> {
  if (!(await ports.permissions.actorIsActive())) {
    return refuse('unknown_or_inactive_actor', 'this session cannot read activity')
  }

  if (!query.companyId?.trim()) return refuse('invalid_filter', 'companyId is required')

  for (const [label, value] of [
    ['from', query.from],
    ['to', query.to],
  ] as const) {
    if (value && Number.isNaN(new Date(value).getTime())) {
      return refuse('invalid_filter', `${label} is not a valid date`)
    }
  }
  if (query.eventTypes?.some((t) => !(EVENT_TYPES as readonly string[]).includes(t))) {
    return refuse('invalid_filter', 'one or more eventTypes are not recognised')
  }

  const permittedCompanies = await ports.permissions.permittedCompanies()
  if (!permittedCompanies.includes(query.companyId)) {
    // A company the actor may not see and a company that does not exist get the
    // SAME answer. Anything else is a directory of other people's companies.
    return refuse('unauthorized_company', 'that company is not available to this session')
  }

  let cursor: Cursor | null = null
  if (query.cursor) {
    cursor = decodeCursor(query.cursor)
    if (!cursor) return refuse('invalid_cursor', 'the cursor is not valid; start from the beginning')
  }

  const requested = query.pageSize ?? DEFAULT_PAGE_SIZE
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_PAGE_SIZE),
  )

  const resolved: ResolvedQuery = { ...query, cursor, pageSize, permittedCompanies }
  const now = ports.now()

  const settled = await Promise.all(
    ports.sources.map(async (source): Promise<{ report: SourceReport; items: ActivityItem[] }> => {
      try {
        const result = await source.read(resolved)
        if (result.status === 'unavailable') {
          return {
            report: { source: source.name, state: 'unavailable', detail: result.reason },
            items: [],
          }
        }
        if (result.status === 'forbidden') {
          return { report: { source: source.name, state: 'forbidden' }, items: [] }
        }
        const ageSeconds = (now.getTime() - ms(result.fetchedAt)) / 1000
        const stale = result.status === 'stale' || ageSeconds > STALE_AFTER_SECONDS
        return {
          report: {
            source: source.name,
            state: stale ? 'stale' : 'ok',
            fetchedAt: result.fetchedAt,
            mode: result.mode ?? 'production',
            ...(result.status === 'stale' ? { detail: result.reason } : {}),
          },
          items: result.items,
        }
      } catch (err) {
        // A thrown adapter is unavailable, not empty. Swallowing this is exactly
        // how a broken source becomes "nothing happened today".
        return {
          report: {
            source: source.name,
            state: 'unavailable',
            detail: err instanceof Error ? err.message : String(err),
          },
          items: [],
        }
      }
    }),
  )

  const reports = settled.map((s) => s.report)

  // Staleness belongs to the ADAPTER that produced the row, tracked by the row
  // itself. Matching on a name field instead would silently mark stale rows
  // fresh whenever the adapter and the source label differ.
  const staleItems = new WeakMap<ActivityItem, boolean>()
  const gathered: ActivityItem[] = []
  for (const s of settled) {
    const isStale = s.report.state === 'stale'
    for (const row of s.items) {
      staleItems.set(row, isStale)
      gathered.push(row)
    }
  }

  const collected = dedupe(gathered).filter((row) => matchesQuery(row, resolved))

  // Permission filtering happens BEFORE ordering, paging and counting. Filtering
  // after the page is cut would let the number of rows on a page reveal how many
  // forbidden records sit behind it.
  const visible: ActivityItem[] = []
  for (const row of collected) {
    if (!permittedCompanies.includes(row.companyId)) continue
    if (row.customerId && !(await ports.permissions.mayViewCustomer(row.customerId))) continue
    if (
      row.relatedObjectType &&
      row.relatedObjectId &&
      !(await ports.permissions.mayViewObject(row.relatedObjectType, row.relatedObjectId))
    ) {
      continue
    }
    visible.push(row)
  }

  visible.sort(compareItems)
  const afterCursor = cursor ? visible.filter((i) => isAfterCursor(i, cursor)) : visible
  const page = afterCursor.slice(0, pageSize)
  const last = page[page.length - 1]
  const nextCursor =
    afterCursor.length > pageSize && last
      ? encodeCursor({ occurredAt: last.occurredAt, activityId: last.activityId })
      : null

  const items: ActivityFeedItem[] = page.map((row) => ({
    ...row,
    availableActions: actionsFor(row),
    freshness: {
      ageSeconds: Math.max(0, Math.round((now.getTime() - ms(row.occurredAt)) / 1000)),
      stale: staleItems.get(row) ?? false,
    },
  }))

  return {
    ok: true,
    version: ACTIVITY_FEED_VERSION,
    dataState: deriveDataState(reports, visible.length),
    containsFixture: reports.some((r) => r.mode === 'fixture'),
    items,
    nextCursor,
    sources: reports,
  }
}
