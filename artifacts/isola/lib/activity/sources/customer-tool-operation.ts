/**
 * CustomerToolOperation → activity. The sixth source.
 *
 * WHY THIS SOURCE EXISTS
 * ---------------------
 * Recent Work was built so that a row's customer opens Customer 360. In
 * production every row carried `customerId: null`, because none of the five
 * sources holds an authoritative customer id — audit rows key on generic
 * entities, approvals on a voice line, ownership on a conversation that stores
 * a phone number rather than a partner id, and staff work on a project.task
 * that has no proven customer relation at all. The door was real and nothing
 * stood in it.
 *
 * This source is the exception, and it is authoritative BY CONSTRUCTION rather
 * than by inference: `POST /api/v1/customers/:customerId/actions` reads the
 * customer from the tenant's own Odoo and refuses unless it exists, and only
 * then writes the operation with `objectType: 'customer'` and `objectId` set to
 * that partner id. Nothing here parses a name, a phone number or free text.
 *
 * ONE INTERPRETATION OF THE TABLE, NOT TWO
 * ---------------------------------------
 * The rows are mapped with the ledger's own `rowToLedgerRecord`, and the
 * outcome with `lifecycleOfRecord` — the same function Customer 360's
 * `recentActions` section uses. Recent Work and the workspace therefore cannot
 * disagree about what an operation did, which they certainly would if this file
 * re-derived "did it work" from `state` and `failure_code` by hand.
 *
 * The titles come from `LIFECYCLE_PRESENTATION`, so "Rejected before sending"
 * and "Written but not confirmed" read here exactly as they do in the
 * workbench. A completed row whose envelope holds no readback is
 * `readback_failed`, not success — the ledger says a null readback means
 * success was never proven, and that rule survives the trip to this screen.
 */

import { LIFECYCLE_PRESENTATION, type ActionLifecycleState } from '@/lib/customer-workspace/contract'
import { lifecycleOfRecord } from '@/lib/context/recent-actions'
import { rowToLedgerRecord, type OperationEnvelope } from '@/lib/operations/ledger'

import type { ActivityItem, EventType, ResolvedQuery } from '../feed'
import { actorKindOf, buildSource, iso, summarise, type SourceDeps } from './shared'

export const CUSTOMER_TOOL_OPERATION_SOURCE = 'customer_tool_operation'

/**
 * The activity-id namespace. Deliberately NOT `staffwork`, which already
 * belongs to the StaffWorkAction adapter — two sources sharing a prefix would
 * share a cursor namespace, and the feed would page one of them wrongly.
 */
export const CUSTOMER_TOOL_OPERATION_PREFIX = 'customerop'

/** The columns this adapter reads. Shaped like the Prisma row, not the ledger. */
export interface CustomerToolOperationRow {
  id: string
  tenant_id: string
  operation_id: string
  tool_name: string
  request_hash: string
  conversation_id: string
  correlation_id: string
  agent_session_id: string | null
  state: string
  result_model: string | null
  result_id: number | null
  result: unknown
  claimed_at: Date
  completed_at: Date | null
  failure_code: string | null
  failure_detail: string | null
}

/**
 * The SAME shape the context route accepts for a customer reference.
 *
 * Inlined rather than imported so this module does not drag the Odoo transport
 * into the activity read path; `customer-tool-operation.test.ts` asserts the two
 * agree on a spread of inputs, so they cannot drift apart silently.
 */
const PARTNER_ID = /^[1-9]\d{0,17}$/

/**
 * A customer id, or null. There is no third option and no guessing.
 *
 * Null is returned for an envelope that is absent, an object type that is not a
 * customer, or an id that is not shaped like an Odoo partner id. Each of those
 * is a row that genuinely cannot be attributed, and a row with no customer must
 * offer no customer link — an "Open customer" control that lands on a refusal
 * is worse than no control.
 */
export function customerIdFromEnvelope(envelope: OperationEnvelope | null): string | null {
  if (!envelope) return null
  if (envelope.objectType !== 'customer') return null
  const id = typeof envelope.objectId === 'string' ? envelope.objectId.trim() : ''
  return PARTNER_ID.test(id) ? id : null
}

/**
 * The lifecycle decides the KIND of event; `status` carries the exact outcome.
 * Total over the fourteen states, so a new lifecycle state fails the build here
 * rather than landing on a default.
 */
const EVENT_FOR: Readonly<Record<ActionLifecycleState, EventType>> = {
  draft: 'governed.action.started',
  executing: 'governed.action.started',
  idempotent_replay: 'governed.action.started',
  completed_verified: 'governed.action.completed',
  readback_failed: 'governed.readback',
  approval_required: 'approval.requested',
  approval_pending: 'approval.requested',
  approval_rejected: 'approval.rejected',
  validation_failed: 'governed.action.failed',
  permission_denied: 'governed.action.failed',
  dependency_unavailable: 'governed.action.failed',
  execution_failed: 'governed.action.failed',
  executor_unavailable: 'governed.action.failed',
  argument_conflict: 'governed.action.failed',
}

export interface CustomerToolOperationDeps extends SourceDeps<CustomerToolOperationRow> {}

export function projectCustomerToolOperation(row: CustomerToolOperationRow): ActivityItem | null {
  // The ledger's own mapper. Re-reading these columns by hand here is how the
  // two views start disagreeing about the same operation.
  const record = rowToLedgerRecord(row as unknown as Record<string, unknown>)
  const envelope = record.envelope
  const lifecycle = lifecycleOfRecord(record)
  const presentation = LIFECYCLE_PRESENTATION[lifecycle]

  const customerId = customerIdFromEnvelope(envelope)
  const actionType = envelope?.actionType ?? row.tool_name
  const actorRef = envelope?.actorRef ?? row.agent_session_id ?? 'system'
  const occurredAt = iso(row.claimed_at)

  return {
    activityId: `${CUSTOMER_TOOL_OPERATION_PREFIX}:${row.operation_id}`,
    eventType: EVENT_FOR[lifecycle],
    // The contract's wording, unchanged. This is what keeps "Rejected before
    // sending" from becoming "failed" on the way to a different screen.
    title: presentation.label,
    summary: summarise(
      [presentation.sentence, actionType ? `Action: ${actionType}` : null]
        .filter(Boolean)
        .join(' '),
    ),
    sourceSystem: CUSTOMER_TOOL_OPERATION_SOURCE,
    provenance: {
      source: CUSTOMER_TOOL_OPERATION_SOURCE,
      fetchedAt: occurredAt,
      trust: 'authoritative',
      // The shared ledger reference. One operation, one id, in both views.
      upstreamRef: record.operationId,
    },
    actor: {
      ref: actorRef,
      label: actorRef,
      kind: actorKindOf(actorRef),
    },
    companyId: record.tenantId,
    customerId,
    // Never a name looked up from anywhere. The workspace shows the customer's
    // identity; this row only needs to be able to open it.
    customerLabel: null,
    relatedObjectType: envelope?.objectType ?? null,
    relatedObjectId: envelope?.objectId ?? null,
    occurredAt,
    receivedAt: iso(row.completed_at ?? row.claimed_at),
    // The exact lifecycle, not a success/failure collapse.
    status: lifecycle,
    ownershipState: null,
    availableActions: [],
    // No native link: a governed operation is an internal record. The
    // authoritative Odoo record it produced is reachable from the customer
    // workspace, which is where a link would actually resolve.
    nativeLinks: [],
    dataMode: 'production',
  }
}

export function createCustomerToolOperationSource(deps: CustomerToolOperationDeps) {
  return buildSource(
    CUSTOMER_TOOL_OPERATION_SOURCE,
    deps,
    (row: CustomerToolOperationRow, _q: ResolvedQuery) => projectCustomerToolOperation(row),
  )
}
