/**
 * HOW MANY ROWS A SOURCE IS ASKED FOR, AND WHERE THE PAGE BOUNDARY GOES.
 *
 * Every activity source used to read 500 rows on every request whatever the
 * page size was: five sources, 2,500 rows fetched, deserialised and merged in
 * memory to render 25 of them, with the ordering and the cursor cut applied
 * afterwards. The ordering, the cursor predicate and the date range belong in
 * the query, and a source only needs `pageSize + 1` rows.
 *
 * This module is shared by `registry.ts` (the Prisma-delegate sources) and
 * `lib/events/projection-store.ts` (the Lane-2 store). It imports TYPES from
 * `./feed` and nothing else, so neither of those has to duplicate the rules and
 * neither creates an import cycle.
 *
 * WHY `pageSize + 1` IS ENOUGH
 * ----------------------------
 * A merged newest-first page of N rows can contain at most N rows from any one
 * source, so the top N of the merge is always inside the union of each source's
 * own top N. The extra row is what tells the feed a next page exists. Three
 * things could make it too few, and here is why they do not:
 *
 *   - DEDUPE. `dedupe()` collapses rows sharing an activityId. Every adapter
 *     stamps its own prefix (`audit:`, `approval:`, `staffwork:`, `ownership:`,
 *     `lane2:`) onto a primary key, so a collision is only possible inside one
 *     source, where the key is unique. Nothing is dropped, so nothing has to be
 *     fetched to replace it.
 *   - FILTERS RE-APPLIED IN MEMORY. `matchesQuery` re-checks every filter after
 *     the read. Event family, status, ownership, actor, customer and related
 *     object are all derived during projection and cannot be expressed against
 *     these columns, so each of them could throw rows away after the page had
 *     been cut and leave it short. When the query carries one, `sourceTake`
 *     falls back to the old bounded read. Correctness first; the win is on the
 *     unfiltered and date-filtered reads, which is what the defect was about.
 *   - PERMISSION FILTERING. `getActivityFeed` drops rows the actor may not see
 *     BEFORE paging. `app/api/v1/activity/route.ts` grants every row inside the
 *     tenant today (`mayViewCustomer`/`mayViewObject` return true), so nothing
 *     is dropped there. Per-object grants WOULD be able to shorten a page; when
 *     they land, the thing to change is where that filtering happens, not this
 *     number.
 */

import type { Cursor, ResolvedQuery } from './feed'

/**
 * The ceiling on one source's contribution, used when the query carries a
 * filter the adapter cannot express in SQL.
 */
export const SOURCE_ROW_LIMIT = 500

/** Filters the feed re-applies in memory that no column here can answer. */
export function needsWideScan(query: ResolvedQuery): boolean {
  return Boolean(
    query.eventTypes?.length ||
      query.statuses?.length ||
      query.ownershipStates?.length ||
      query.customerId ||
      query.actorRef ||
      query.contactId ||
      query.serviceId ||
      query.deviceId ||
      query.pbxId ||
      query.issueId ||
      query.taskId ||
      query.opportunityId,
  )
}

/** How many rows one source is asked for. See the note at the top of the file. */
export function sourceTake(query: ResolvedQuery): number {
  if (needsWideScan(query)) return SOURCE_ROW_LIMIT
  const size = Number.isFinite(query.pageSize) ? Math.floor(query.pageSize) : 1
  return Math.max(1, size) + 1
}

/** Which columns hold this source's `occurredAt` and its tie-breaking id. */
export interface SourceColumns {
  /** The column that IS the row's `occurredAt` after projection. */
  time: string
  /** The column the adapter turns into the second half of `activityId`. */
  id: string
  /** The prefix the adapter stamps onto that id, e.g. `audit` in `audit:42`. */
  idPrefix: string
}

/**
 * The cursor, as a WHERE clause.
 *
 * The feed's ordering is `occurredAt DESC, activityId ASC`, so "after the
 * cursor" means OLDER, and a tie on the timestamp is broken by the id. Getting
 * that backwards hands the caller page one for ever, and every page still looks
 * correct in isolation — which is why this is tested against `isAfterCursor`
 * itself rather than against a description of it.
 *
 * ONLY VALID WHERE `columns.time` REALLY IS `occurredAt`. It is for the audit
 * trail, staff work, ownership transitions and the Lane-2 projection. It is NOT
 * for approvals, whose occurredAt is the DECISION time — see registry.ts.
 */
export function cursorPredicate(columns: SourceColumns, cursor: Cursor): Record<string, unknown> {
  const at = new Date(cursor.occurredAt)
  const marker = columns.idPrefix + ':'

  if (cursor.activityId.startsWith(marker)) {
    const id = cursor.activityId.slice(marker.length)
    return {
      OR: [
        { [columns.time]: { lt: at } },
        { AND: [{ [columns.time]: at }, { [columns.id]: { gt: id } }] },
      ],
    }
  }

  // The cursor was minted by a DIFFERENT source. Every id this source can
  // produce begins with its own prefix, and no prefix is a prefix of another,
  // so the whole tie is decided once by comparing the prefixes.
  return marker > cursor.activityId
    ? { [columns.time]: { lte: at } }
    : { [columns.time]: { lt: at } }
}

/**
 * Tenant scope, the date range, the cursor and the ordering — all in the query.
 * The id is the second ordering key for the same reason the feed uses
 * activityId: two rows in the same instant must come back in the same order
 * every time, or the cursor cannot promise a page boundary.
 */
export function pagedFindManyArgs(
  tenantId: string,
  query: ResolvedQuery,
  columns: SourceColumns,
  tenantColumn = 'tenant_id',
) {
  const range: { gte?: Date; lte?: Date } = {}
  const from = query.from ? new Date(query.from) : null
  const to = query.to ? new Date(query.to) : null
  if (from && !Number.isNaN(from.getTime())) range.gte = from
  if (to && !Number.isNaN(to.getTime())) range.lte = to

  const clauses: Record<string, unknown>[] = []
  if (range.gte || range.lte) clauses.push({ [columns.time]: range })
  if (query.cursor) clauses.push(cursorPredicate(columns, query.cursor))

  return {
    where: {
      [tenantColumn]: tenantId,
      ...(clauses.length > 0 ? { AND: clauses } : {}),
    },
    orderBy: [{ [columns.time]: 'desc' as const }, { [columns.id]: 'asc' as const }],
    take: sourceTake(query),
  }
}
