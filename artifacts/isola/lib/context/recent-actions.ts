/**
 * recent-actions@1 — the governed actions already taken against one customer.
 *
 * THIS IS NOT A SECOND LEDGER.
 *
 * `lib/operations/ledger.ts` owns the write path, the identity derivation and
 * the row shape. This module is a READ over the same table, through the same
 * `rowToLedgerRecord` mapper, so a change to the storage mapping cannot leave a
 * second interpretation of the same rows behind in this file.
 *
 * TWO THINGS IT REFUSES TO DO
 * ---------------------------
 * 1. It does not report a completed operation as a success unless the envelope
 *    actually carries a readback. The ledger's own words: "The authoritative
 *    readback. Null means success was never proven." A row that completed with
 *    a null readback is `readback_failed` here — written, unconfirmed — and the
 *    workspace contract renders that with its own wording and no tick.
 *
 * 2. It does not put payloads on a screen. The envelope holds the caller's
 *    result and the verified readback; both can carry business content, and
 *    neither is needed in order to say WHAT was attempted and HOW IT ENDED.
 *    What comes back is the operation's identity, its lifecycle and its
 *    authoritative record reference. Nothing else.
 */

import { prisma } from '@/lib/prisma'
import {
  isOperationEnvelope,
  rowToLedgerRecord,
  type CallerClass,
  type LedgerRecord,
} from '@/lib/operations/ledger'
import type { ActionLifecycleState } from '@/lib/customer-workspace/contract'

import type { BundleAdapter, Provenance } from './context-bundle'

export const RECENT_ACTIONS_VERSION = 'recent-actions@1' as const

/** Hard ceiling, independent of what the caller asks for. */
export const MAX_RECENT_ACTIONS = 50

/** Who may see the action history at all. Mirrors the workspace manager gate. */
const CONTEXT_ROLES = ['manager', 'owner', 'service_account'] as const

/**
 * The failure classes `writeAudit` records on the row. They are the
 * `ActionOutcome` names verbatim, so this map is total over the ones that can
 * reach a failed row — and anything unrecognised lands on `execution_failed`
 * rather than on a success.
 */
const FAILURE_CLASS_TO_LIFECYCLE: Readonly<Record<string, ActionLifecycleState>> = {
  VALIDATION_FAILED: 'validation_failed',
  PERMISSION_DENIED: 'permission_denied',
  APPROVAL_REQUIRED: 'approval_required',
  APPROVAL_REJECTED: 'approval_rejected',
  EXECUTOR_UNAVAILABLE: 'executor_unavailable',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  EXECUTION_FAILED: 'execution_failed',
  READBACK_FAILED: 'readback_failed',
}

/**
 * A stored row's lifecycle, decided by what the row can PROVE.
 *
 * The `completed` branch is the important one. `state = completed` is a
 * statement that the operation stopped running, not that it worked. Only a
 * present readback is evidence, and this is the boundary where that rule either
 * survives or is quietly lost.
 */
export function lifecycleOfRecord(record: LedgerRecord): ActionLifecycleState {
  if (record.state === 'claimed') return 'executing'
  if (record.state === 'failed') {
    const cls = record.failureClass ?? ''
    return FAILURE_CLASS_TO_LIFECYCLE[cls] ?? 'execution_failed'
  }
  // completed
  return record.envelope?.readback ? 'completed_verified' : 'readback_failed'
}

export interface RecentActionRecord {
  operationId: string
  /** foundation_staff or customer_agent. Two different callers share this table. */
  callerClass: CallerClass | null
  actionType: string | null
  objectType: string | null
  objectId: string | null
  /** Who acted. An opaque reference, never an email or a phone number. */
  actorRef: string | null
  lifecycle: ActionLifecycleState
  /**
   * Whether an authoritative readback exists. The readback ITSELF is not
   * returned — this is the one bit a reader needs in order to know whether the
   * outcome on screen is evidence or a claim.
   */
  readbackProven: boolean
  /** The authoritative record this operation produced, when there is one. */
  resultModel: string | null
  resultId: number | null
  auditRef: string | null
  correlationId: string
  startedAt: string
  endedAt: string | null
}

export function toRecentAction(record: LedgerRecord): RecentActionRecord {
  const env = record.envelope
  return {
    operationId: record.operationId,
    callerClass: env?.callerClass ?? null,
    actionType: env?.actionType ?? null,
    objectType: env?.objectType ?? null,
    objectId: env?.objectId ?? null,
    actorRef: env?.actorRef ?? null,
    lifecycle: lifecycleOfRecord(record),
    readbackProven: !!env?.readback,
    resultModel: record.resultModel,
    resultId: record.resultId,
    auditRef: env?.auditRef ?? null,
    correlationId: record.correlationId,
    startedAt: record.claimedAt.toISOString(),
    endedAt: record.completedAt ? record.completedAt.toISOString() : null,
  }
}

/* ── storage port ───────────────────────────────────────────────────────────*/

export interface RecentActionsQuery {
  tenantId: string
  objectType: string
  objectId: string
  limit: number
}

export interface RecentActionsStore {
  list(query: RecentActionsQuery): Promise<LedgerRecord[]>
}

function clamp(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_RECENT_ACTIONS)
}

/**
 * The tenant scope is a REAL COLUMN and is applied in the database. The object
 * scope lives in the envelope JSON and is applied there too, so a customer's
 * history is filtered by the store rather than by taking a wide slice and
 * discarding most of it — a wide read that comes back full is a page that
 * silently lost rows.
 *
 * Rows written before the envelope existed carry no object identity at all and
 * are therefore not attributable to a customer. They do not match, and that is
 * correct: attributing them by guesswork would put one customer's history under
 * another customer's name.
 *
 * Ordering is `claimed_at desc, id desc`. The second key is not decoration —
 * two operations claimed in the same millisecond would otherwise come back in
 * an order the database was free to change between reads.
 */
export const prismaRecentActionsStore: RecentActionsStore = {
  async list({ tenantId, objectType, objectId, limit }) {
    const rows = (await prisma.customerToolOperation.findMany({
      where: {
        tenant_id: tenantId,
        AND: [
          { result: { path: ['objectId'], equals: objectId } },
          { result: { path: ['objectType'], equals: objectType } },
        ],
      },
      orderBy: [{ claimed_at: 'desc' }, { id: 'desc' }],
      take: clamp(limit),
    })) as Record<string, unknown>[]
    return rows.map(rowToLedgerRecord)
  },
}

/* ── adapter ────────────────────────────────────────────────────────────────*/

export interface RecentActionsAdapterDeps {
  store: RecentActionsStore
  /** From the SESSION. Never from a query string or a payload field. */
  tenantId: string
  now(): Date
}

/**
 * The `recentActions` BundleAdapter.
 *
 * It does not catch its own failures. `buildContextBundle` turns a throw into
 * `{ status: 'unavailable', reason }` and an empty array into `empty`, and those
 * mean opposite things — a caught error returned as `[]` would tell a manager
 * that nothing has ever been done to this customer.
 */
export function recentActionsAdapter(deps: RecentActionsAdapterDeps): BundleAdapter {
  return {
    section: 'recentActions',
    allowedRoles: [...CONTEXT_ROLES],
    async load({ objectType, objectId, limit }) {
      let records: LedgerRecord[]
      try {
        records = await deps.store.list({
          tenantId: deps.tenantId,
          objectType,
          objectId,
          limit,
        })
      } catch {
        // Sanitised. buildContextBundle puts this message straight into the
        // section's reason, so a driver string here would reach a screen.
        throw new Error('the action history could not be read')
      }
      const provenance: Provenance = {
        source: 'ledger:CustomerToolOperation',
        fetchedAt: deps.now(),
        stale: false,
      }
      return { data: records.map(toRecentAction), provenance }
    },
  }
}

/** Exported for the test that asserts a legacy row is not attributed to anyone. */
export function hasAttributableEnvelope(record: LedgerRecord): boolean {
  return isOperationEnvelope(record.rawResult)
}
