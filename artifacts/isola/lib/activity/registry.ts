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
 */

import { createPrismaProjectionStore } from '@/lib/events/projection-store'
import { prisma } from '@/lib/prisma'

import type { ActivitySource } from './feed'
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

/** How many rows one source may contribute to a single feed read. */
export const SOURCE_ROW_LIMIT = 500

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

function reader<Row>(delegate: ActivityDelegate, tenantId: string): () => Promise<Row[]> {
  return async () => (await delegate.findMany(tenantScopedFindManyArgs(tenantId))) as Row[]
}

export function buildActivitySources(
  config: ActivityRegistryConfig,
  deps: ActivityRegistryDeps = defaultActivityRegistryDeps(),
): readonly ActivitySource[] {
  const now = () => config.now()
  const { tenantId } = config

  // Not a ternary over the RESULT of a read — a ternary over whether the read
  // happens at all. The delegate is unreachable when the gate is closed.
  const auditList: () => Promise<AuditLogRow[]> = config.canViewAudit
    ? reader<AuditLogRow>(deps.auditLog, tenantId)
    : async () => {
        throw new SourceForbidden('audit records are not available to this session')
      }

  return [
    createAuditLogSource({ list: auditList, now }),
    createApprovalRequestSource({
      list: reader<ApprovalRequestRow>(deps.approvalRequest, tenantId),
      now,
    }),
    createStaffWorkActionSource({
      list: reader<StaffWorkActionRow>(deps.staffWorkAction, tenantId),
      now,
      odooBaseUrl: config.odooBaseUrl,
    }),
    createOwnershipSource({
      list: reader<OwnershipTransitionRow>(deps.conversationOwnership, tenantId),
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
