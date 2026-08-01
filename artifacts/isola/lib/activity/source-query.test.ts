/**
 * The bounded read, proved against the thing it has to stay equal to.
 *
 * Two claims are being made by lib/activity/source-query.ts, and neither is
 * safe to assert by describing it:
 *
 *   1. `cursorPredicate` selects EXACTLY the rows `isAfterCursor` selects. Those
 *      two are the same rule written twice, once in SQL and once in TypeScript,
 *      and a feed whose WHERE clause disagrees with its comparator hands the
 *      caller page one for ever while every page looks correct in isolation.
 *   2. Asking each source for `pageSize + 1` rows instead of 500 produces the
 *      SAME page and the SAME nextCursor. That is asserted by running the real
 *      `getActivityFeed` twice over the same data — once with sources that
 *      return everything they hold, once with sources that return only their own
 *      bounded slice — and comparing.
 */

import { describe, expect, it } from 'vitest'

import {
  compareItems,
  getActivityFeed,
  isAfterCursor,
  type ActivityItem,
  type ActivityPermissions,
  type ActivitySource,
  type Cursor,
  type ResolvedQuery,
} from './feed'
import {
  SOURCE_ROW_LIMIT,
  cursorPredicate,
  needsWideScan,
  pagedFindManyArgs,
  sourceTake,
  type SourceColumns,
} from './source-query'

const TENANT = 'tenant-1'
const COLUMNS: Record<string, SourceColumns> = {
  audit_log: { time: 'created_at', id: 'id', idPrefix: 'audit' },
  approval_request: { time: 'created_at', id: 'id', idPrefix: 'approval' },
  staff_work_action: { time: 'created_at', id: 'id', idPrefix: 'staffwork' },
  conversation_ownership: { time: 'created_at', id: 'id', idPrefix: 'ownership' },
  lane2: { time: 'occurred_at', id: 'event_id', idPrefix: 'lane2' },
}

const baseQuery: ResolvedQuery = {
  companyId: TENANT,
  pageSize: 25,
  cursor: null,
  permittedCompanies: [TENANT],
}

const query = (over: Partial<ResolvedQuery> = {}): ResolvedQuery => ({ ...baseQuery, ...over })

// ── a tiny evaluator for the Prisma clauses this module emits ──

type Clause = Record<string, unknown>

/** Evaluates the exact clause shapes `cursorPredicate` can produce. */
function matches(clause: Clause, row: { time: Date; id: string }, columns: SourceColumns): boolean {
  if (Array.isArray(clause.OR)) {
    return (clause.OR as Clause[]).some((c) => matches(c, row, columns))
  }
  if (Array.isArray(clause.AND)) {
    return (clause.AND as Clause[]).every((c) => matches(c, row, columns))
  }

  const [key, condition] = Object.entries(clause)[0] as [string, unknown]
  const value = key === columns.time ? row.time : row.id

  if (condition instanceof Date) return (value as Date).getTime() === condition.getTime()
  if (typeof condition === 'string') return value === condition

  const ops = condition as { lt?: Date; lte?: Date; gt?: string }
  if (ops.lt) return (value as Date).getTime() < ops.lt.getTime()
  if (ops.lte) return (value as Date).getTime() <= ops.lte.getTime()
  if (ops.gt !== undefined) return (value as string) > ops.gt
  throw new Error('unhandled clause: ' + JSON.stringify(clause))
}

// ── a deterministic corpus spread across the five sources ──

const SOURCES = ['audit_log', 'approval_request', 'staff_work_action', 'conversation_ownership', 'lane2']

function itemFor(source: string, ordinal: number, minute: number): ActivityItem {
  const prefix = COLUMNS[source].idPrefix
  const occurredAt = new Date(Date.UTC(2026, 6, 31, 12, minute, 0)).toISOString()
  return {
    activityId: `${prefix}:${String(ordinal).padStart(3, '0')}`,
    eventType: 'audit.event',
    title: 'Recorded event',
    summary: 'something happened',
    sourceSystem: source,
    provenance: { source, fetchedAt: occurredAt, trust: 'authoritative', upstreamRef: null },
    actor: { ref: 'system', label: 'system', kind: 'system' },
    companyId: TENANT,
    customerId: null,
    customerLabel: null,
    relatedObjectType: null,
    relatedObjectId: null,
    occurredAt,
    receivedAt: occurredAt,
    status: 'recorded',
    ownershipState: null,
    availableActions: [],
    nativeLinks: [],
    dataMode: 'production',
  }
}

/**
 * 200 rows over 40 distinct minutes, so every minute holds five rows from five
 * different sources. That is the case the id tiebreak exists for, and the case
 * a bounded per-source read is most likely to get wrong.
 */
function corpus(): Record<string, ActivityItem[]> {
  const out: Record<string, ActivityItem[]> = {}
  for (const source of SOURCES) out[source] = []
  for (let minute = 0; minute < 40; minute += 1) {
    for (const [index, source] of SOURCES.entries()) {
      out[source].push(itemFor(source, minute * 5 + index, minute))
    }
  }
  return out
}

const permissions: ActivityPermissions = {
  actorIsActive: async () => true,
  permittedCompanies: async () => [TENANT],
  mayViewCustomer: async () => true,
  mayViewObject: async () => true,
}

/** The old behaviour: hand the feed everything and let it sort and cut. */
function wideSource(name: string, items: ActivityItem[]): ActivitySource {
  return {
    name,
    async read() {
      return { status: 'ok', items: [...items], fetchedAt: '2026-07-31T12:40:00.000Z' }
    },
  }
}

/** The new behaviour: order, cut on the cursor, and take pageSize + 1. */
function boundedSource(name: string, items: ActivityItem[]): ActivitySource {
  return {
    name,
    async read(q: ResolvedQuery) {
      const columns = COLUMNS[name]
      const rows = [...items]
        .map((item) => ({
          item,
          row: {
            time: new Date(item.occurredAt),
            id: item.activityId.slice(columns.idPrefix.length + 1),
          },
        }))
        .filter(({ row }) => (q.cursor ? matches(cursorPredicate(columns, q.cursor), row, columns) : true))
        .map(({ item }) => item)
        .sort(compareItems)
        .slice(0, sourceTake(q))
      return { status: 'ok', items: rows, fetchedAt: '2026-07-31T12:40:00.000Z' }
    },
  }
}

// ──────────────────────────────────────────────────────────

describe('the cursor predicate is the same rule as isAfterCursor', () => {
  const rows = corpus()

  for (const source of SOURCES) {
    it(`agrees with isAfterCursor for every cursor, on ${source}`, () => {
      const columns = COLUMNS[source]
      const all = Object.values(rows).flat()

      for (const anchor of all) {
        const cursor: Cursor = { occurredAt: anchor.occurredAt, activityId: anchor.activityId }
        const clause = cursorPredicate(columns, cursor)

        for (const item of rows[source]) {
          const row = {
            time: new Date(item.occurredAt),
            id: item.activityId.slice(columns.idPrefix.length + 1),
          }
          expect(matches(clause, row, columns)).toBe(isAfterCursor(item, cursor))
        }
      }
    })
  }
})

describe('how many rows a source is asked for', () => {
  it('is pageSize + 1 for a query with nothing derived in it', () => {
    expect(sourceTake(query({ pageSize: 25 }))).toBe(26)
    expect(sourceTake(query({ pageSize: 1 }))).toBe(2)
    expect(sourceTake(query({ pageSize: 100 }))).toBe(101)
  })

  it('falls back to the bounded read for anything decided after projection', () => {
    for (const over of [
      { eventTypes: ['audit.event'] },
      { statuses: ['recorded'] },
      { ownershipStates: ['ai'] },
      { actorRef: 'staff:1' },
      { customerId: 'c-1' },
      { contactId: 'c-1' },
      { serviceId: 's-1' },
      { deviceId: 'd-1' },
      { pbxId: 'p-1' },
      { issueId: 'i-1' },
      { taskId: 't-1' },
      { opportunityId: 'o-1' },
    ] as Partial<ResolvedQuery>[]) {
      expect(needsWideScan(query(over))).toBe(true)
      expect(sourceTake(query(over))).toBe(SOURCE_ROW_LIMIT)
    }
  })

  it('a date range alone does NOT force a wide scan, because it is in the query', () => {
    const q = query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:00.000Z' })
    expect(needsWideScan(q)).toBe(false)
    const args = pagedFindManyArgs(TENANT, q, COLUMNS.audit_log)
    expect(args.take).toBe(26)
    expect(args.where).toEqual({
      tenant_id: TENANT,
      AND: [
        {
          created_at: {
            gte: new Date('2026-07-01T00:00:00.000Z'),
            lte: new Date('2026-07-31T23:59:00.000Z'),
          },
        },
      ],
    })
  })

  it('orders on the pair the cursor is cut on', () => {
    expect(pagedFindManyArgs(TENANT, query(), COLUMNS.lane2, 'tenant_id').orderBy).toEqual([
      { occurred_at: 'desc' },
      { event_id: 'asc' },
    ])
  })
})

describe('cross-source ordering is unchanged', () => {
  const rows = corpus()
  const wide = SOURCES.map((name) => wideSource(name, rows[name]))
  const bounded = SOURCES.map((name) => boundedSource(name, rows[name]))
  const ports = (sources: ActivitySource[]) => ({
    sources,
    permissions,
    now: () => new Date('2026-07-31T12:40:00.000Z'),
  })

  it('page one is identical whether the sources read 200 rows or 26', async () => {
    const before = await getActivityFeed({ companyId: TENANT, pageSize: 25 }, ports(wide))
    const after = await getActivityFeed({ companyId: TENANT, pageSize: 25 }, ports(bounded))

    expect(before.ok && after.ok).toBe(true)
    if (!before.ok || !after.ok) return

    expect(after.items.map((i) => i.activityId)).toEqual(before.items.map((i) => i.activityId))
    expect(after.items).toHaveLength(25)
    expect(after.nextCursor).toBe(before.nextCursor)
    expect(after.nextCursor).not.toBeNull()
  })

  it('walks the WHOLE list in the same order, page after page', async () => {
    const walk = async (sources: ActivitySource[]): Promise<string[]> => {
      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 20; page += 1) {
        const result = await getActivityFeed(
          { companyId: TENANT, pageSize: 25, cursor },
          ports(sources),
        )
        if (!result.ok) throw new Error('refused: ' + result.refusal)
        seen.push(...result.items.map((i) => i.activityId))
        cursor = result.nextCursor
        if (!cursor) break
      }
      return seen
    }

    const before = await walk(wide)
    const after = await walk(bounded)

    expect(after).toEqual(before)
    // Every row, exactly once, and in newest-first order.
    expect(after).toHaveLength(200)
    expect(new Set(after).size).toBe(200)
  })

  it('the last page still ends, rather than offering a cursor to nothing', async () => {
    let cursor: string | null = null
    let last: { nextCursor: string | null; count: number } = { nextCursor: null, count: 0 }
    for (let page = 0; page < 20; page += 1) {
      const result = await getActivityFeed(
        { companyId: TENANT, pageSize: 25, cursor },
        ports(bounded),
      )
      if (!result.ok) throw new Error('refused')
      last = { nextCursor: result.nextCursor, count: result.items.length }
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(last.nextCursor).toBeNull()
    expect(last.count).toBe(25)
  })
})
