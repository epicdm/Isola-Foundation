/**
 * The five activity sources this deployment reads, assembled per request.
 *
 * ALL FIVE ARE REGISTERED EVERY TIME, IN THE SAME ORDER.
 * A source the caller may not read is registered and reports `forbidden`; a
 * source with nowhere to read from is registered and reports `unavailable`.
 * Dropping either from the list would turn a permission boundary and a missing
 * store into the same thing on screen: silence.
 *
 * THE AUDIT GATE
 * --------------
 * `canViewAudit` decides whether the audit source can READ, not whether it is
 * listed. When it is false the source's `list` throws `SourceForbidden` before
 * touching the delegate — so no audit query is issued, no audit row is
 * projected and then discarded, and the report says `forbidden` rather than
 * pretending the trail was empty. `registry.test.ts` asserts the delegate call
 * count is zero, because "we fetched it and then hid it" is not the same
 * promise as "we never asked".
 *
 * Every read is tenant-scoped at the delegate. The tenant id comes from the
 * SESSION, never from the query string.
 *
 * HOW MANY ROWS EACH SOURCE IS ASKED FOR
 * --------------------------------------
 * `lib/activity/source-query.ts` holds the rules and the reasoning: ordering,
 * cursor and date range go into the query, and a source is asked for
 * `pageSize + 1` rows instead of a flat 500 — except when the query carries a
 * filter that is only decidable after projection, where the read stays wide so
 * a page cannot come back short.
 *
 * ORDERING BY `created_at` IS ONLY VALID WHERE `created_at` IS `occurredAt`.
 * It is, for the audit trail, staff work and ownership transitions. It is NOT
 * for approvals: `projectApprovalRequest` reports the DECISION time
 * (`decided_at ?? consumed_at`) for anything already decided, so a request
 * created last month and approved a minute ago belongs at the top of the feed
 * and is nowhere near the top by `created_at`. Taking `pageSize + 1` newest-by-
 * created_at rows would silently drop it, and Prisma cannot order by that
 * coalesce without raw SQL. The approvals read is therefore deliberately left
 * exactly as it was — the one source still reading a bounded 500 — and says so
 * here rather than being quietly wrong.
 */

import { createPrismaProjectionStore } from '@/lib/events/projection-store'
import { prisma } from '@/lib/prisma'

import type { ActivitySource, ResolvedQuery } from './feed'
import { pagedFindManyArgs, SOURCE_ROW_LIMIT, type SourceColumns } from './source-query'
import { createApprovalRequestSource, type ApprovalRequestRow } from './sources/approval-request'
import { createAuditLogSource, type AuditLogRow } from './sources/audit-log'
import {
  createOwnershipSource,
  type OwnershipTransitionRow,
} from './sources/conversation-ownership'
import { createLane2Source, nullLane2Store, type Lane2ProjectionStore } from './sources/lane2-events'
import { SourceForbidden } from './sources/shared'
import { createStaffWorkActionSource, type StaffWorkActionRow } from './sources/staff-work-action'

/** In registration order. `?source=` is validated against exactly this list. */
export const ACTIVITY_SOURCE_NAMES = [
  'audit_log',
  'approval_request',
  'staff_work_action',
  'conversation_ownership',
  'lane2',
] as const
export type ActivitySourceName = (typeof ACTIVITY_SOURCE_NAMES)[number]

/** Re-exported so callers keep one name for the bounded-read ceiling. */
export { SOURCE_ROW_LIMIT }

/**
 * The `activityId` prefix each adapter stamps onto its primary key. The cursor
 * is `{ occurredAt, activityId }`, so translating it into a WHERE clause means
 * knowing which part of it belongs to this source.
 */
export const SOURCE_ID_PREFIX: Readonly<Record<string, string>> = {
  audit_log: 'audit',
  approval_request: 'approval',
  staff_work_action: 'staffwork',
  conversation_ownership: 'ownership',
  lane2: 'lane2',
}

/**
 * The narrow slice of a Prisma model delegate this module uses. Narrow on
 * purpose: a test can satisfy it with a spy, and nothing here can reach for a
 * write method that is not in the type.
 */
export interface ActivityDelegate {
  findMany(args: unknown): Promise<unknown[]>
}

export interface ActivityRegistryConfig {
  tenantId: string
  canViewAudit: boolean
  now(): Date
  odooBaseUrl?: string | null
  chatwootBaseUrl?: string | null
  clawithBaseUrl?: string | null
}

export interface ActivityRegistryDeps {
  auditLog: ActivityDelegate
  approvalRequest: ActivityDelegate
  staffWorkAction: ActivityDelegate
  conversationOwnership: ActivityDelegate
  /**
   * Lane 2 now HAS a store — `projected_activity`, written by
   * `IngestPorts.project`. Inject `nullLane2Store` to state deliberately that
   * this deployment is not configured for it; leaving it undefined must not be
   * the way a real deployment ends up reporting `unavailable` for ever.
   */
  lane2Store?: Lane2ProjectionStore
}

/**
 * The real delegates. Built lazily — only when no deps were injected — so a
 * caller that supplies its own ports never depends on a database being there.
 */
export function defaultActivityRegistryDeps(): ActivityRegistryDeps {
  return {
    auditLog: prisma.auditLog as unknown as ActivityDelegate,
    approvalRequest: prisma.approvalRequest as unknown as ActivityDelegate,
    staffWorkAction: prisma.staffWorkAction as unknown as ActivityDelegate,
    conversationOwnership: prisma.conversationOwnershipTransition as unknown as ActivityDelegate,
    // The real table, not the null store. Production reporting `unavailable`
    // when the rows are actually there is the failure this default prevents.
    lane2Store: createPrismaProjectionStore(),
  }
}

/** Newest first, tenant-scoped, bounded. The feed does the rest of the work. */
export function tenantScopedFindManyArgs(tenantId: string) {
  return {
    where: { tenant_id: tenantId },
    orderBy: { created_at: 'desc' as const },
    take: SOURCE_ROW_LIMIT,
  }
}

/** These three sources project `created_at` as `occurredAt` and `id` as the id. */
function columnsFor(name: string): SourceColumns {
  return { time: 'created_at', id: 'id', idPrefix: SOURCE_ID_PREFIX[name] ?? name }
}

/**
 * A source excluded by `?source=` can contribute nothing, so it is not asked.
 * Every adapter here stamps its own name as the row's `sourceSystem`, which is
 * what `matchesQuery` compares against — this is the whole-source question,
 * answered before a query is issued rather than after 500 rows come back.
 */
export function excludedBySourceFilter(query: ResolvedQuery, name: string): boolean {
  return Boolean(query.sourceSystems?.length && !query.sourceSystems.includes(name))
}

function reader<Row>(
  delegate: ActivityDelegate,
  tenantId: string,
  name: string,
): (query: ResolvedQuery) => Promise<Row[]> {
  const columns = columnsFor(name)
  return async (query: ResolvedQuery) => {
    if (excludedBySourceFilter(query, name)) return []
    return (await delegate.findMany(pagedFindManyArgs(tenantId, query, columns))) as Row[]
  }
}

/**
 * The approvals read, which cannot be ordered or cut in SQL. See the note at
 * the top of the file: `occurredAt` for an approval is the decision time, and
 * `created_at` is not it.
 */
function wideReader<Row>(
  delegate: ActivityDelegate,
  tenantId: string,
  name: string,
): (query: ResolvedQuery) => Promise<Row[]> {
  return async (query: ResolvedQuery) => {
    if (excludedBySourceFilter(query, name)) return []
    return (await delegate.findMany(tenantScopedFindManyArgs(tenantId))) as Row[]
  }
}

export function buildActivitySources(
  config: ActivityRegistryConfig,
  deps: ActivityRegistryDeps = defaultActivityRegistryDeps(),
): readonly ActivitySource[] {
  const now = () => config.now()
  const { tenantId } = config

  // Not a ternary over the RESULT of a read — a ternary over whether the read
  // happens at all. The delegate is unreachable when the gate is closed.
  const auditList: (query: ResolvedQuery) => Promise<AuditLogRow[]> = config.canViewAudit
    ? reader<AuditLogRow>(deps.auditLog, tenantId, 'audit_log')
    : async () => {
        throw new SourceForbidden('audit records are not available to this session')
      }

  return [
    createAuditLogSource({ list: auditList, now }),
    createApprovalRequestSource({
      list: wideReader<ApprovalRequestRow>(deps.approvalRequest, tenantId, 'approval_request'),
      now,
    }),
    createStaffWorkActionSource({
      list: reader<StaffWorkActionRow>(deps.staffWorkAction, tenantId, 'staff_work_action'),
      now,
      odooBaseUrl: config.odooBaseUrl,
    }),
    createOwnershipSource({
      list: reader<OwnershipTransitionRow>(
        deps.conversationOwnership,
        tenantId,
        'conversation_ownership',
      ),
      now,
      chatwootBaseUrl: config.chatwootBaseUrl,
    }),
    createLane2Source({
      store: deps.lane2Store ?? nullLane2Store,
      now,
      chatwootBaseUrl: config.chatwootBaseUrl,
      clawithBaseUrl: config.clawithBaseUrl,
    }),
  ]
}
