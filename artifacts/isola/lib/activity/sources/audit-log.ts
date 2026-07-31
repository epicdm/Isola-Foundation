/**
 * AuditLog → activity.
 *
 * The audit trail is where the governed-action lifecycle is already written, so
 * this adapter is a projection rather than a second source of truth.
 *
 * What it will NOT project: raw authorised arguments, failure stack traces,
 * secrets, or object identifiers the caller could not otherwise see. `meta` is
 * read through a WHITELIST — a column or key added next year is excluded by
 * default instead of leaking by default.
 */

import type { ActivityItem, EventType, ResolvedQuery } from '../feed'
import {
  actorKindOf,
  buildSource,
  iso,
  pickSafe,
  summarise,
  type SourceDeps,
} from './shared'

export const AUDIT_LOG_SOURCE = 'audit_log'

/** Exactly the columns this projection reads. */
export interface AuditLogRow {
  id: string
  tenant_id: string | null
  actor_id: string
  action: string
  entity: string | null
  entity_id: string | null
  request_id: string | null
  meta: unknown
  created_at: Date
}

/** The only `meta` keys allowed onto a screen. */
const META_ALLOWED = [
  'outcome',
  'actionType',
  'riskLevel',
  'correlationId',
  'auditRef',
  'approvalId',
  'objectType',
  'objectId',
  'dependency',
] as const

/**
 * The governed pipeline's outcomes, mapped to what an operator is looking at.
 * Failures stay failures: nothing here turns READBACK_FAILED into a completion.
 */
const OUTCOME_EVENT: Readonly<Record<string, EventType>> = {
  EXECUTED: 'governed.action.completed',
  IDEMPOTENT_REPLAY: 'governed.action.completed',
  VALIDATION_FAILED: 'governed.action.failed',
  PERMISSION_DENIED: 'governed.action.failed',
  EXECUTOR_UNAVAILABLE: 'governed.action.failed',
  EXECUTION_FAILED: 'governed.action.failed',
  DEPENDENCY_UNAVAILABLE: 'governed.action.failed',
  READBACK_FAILED: 'governed.action.failed',
  APPROVAL_REQUIRED: 'approval.requested',
  APPROVAL_REJECTED: 'approval.rejected',
}

const OUTCOME_TITLE: Readonly<Record<string, string>> = {
  EXECUTED: 'Action completed and verified',
  IDEMPOTENT_REPLAY: 'Action already done — replayed, not repeated',
  VALIDATION_FAILED: 'Action refused — the request was not valid',
  PERMISSION_DENIED: 'Action refused — not permitted',
  EXECUTOR_UNAVAILABLE: 'Action not performed — nothing is wired up to do it',
  EXECUTION_FAILED: 'Action failed — the system of record refused it',
  DEPENDENCY_UNAVAILABLE: 'Action not performed — the system of record was unreachable',
  READBACK_FAILED: 'Written, but NOT verified — do not treat this as done',
  APPROVAL_REQUIRED: 'Waiting for a human decision',
  APPROVAL_REJECTED: 'A human said no',
}

export function projectAuditLog(row: AuditLogRow): ActivityItem | null {
  if (!row.tenant_id) return null

  const meta = pickSafe(row.meta, META_ALLOWED)
  const outcome = meta.outcome ?? ''
  const eventType: EventType = OUTCOME_EVENT[outcome] ?? 'audit.event'
  const actionType = meta.actionType || row.action

  const title = OUTCOME_TITLE[outcome] ?? summarise(row.action, 80) || 'Recorded event'
  const summary = outcome
    ? summarise(`${actionType}${meta.dependency ? ` — ${meta.dependency} unavailable` : ''}`)
    : summarise(`${row.action}${row.entity ? ` on ${row.entity}` : ''}`)

  const occurredAt = iso(row.created_at)

  return {
    activityId: `audit:${row.id}`,
    eventType,
    title,
    summary,
    sourceSystem: AUDIT_LOG_SOURCE,
    provenance: {
      source: AUDIT_LOG_SOURCE,
      fetchedAt: occurredAt,
      trust: 'authoritative',
      upstreamRef: meta.correlationId ?? row.request_id ?? null,
    },
    actor: { ref: row.actor_id, label: row.actor_id, kind: actorKindOf(row.actor_id) },
    companyId: row.tenant_id,
    customerId: null,
    customerLabel: null,
    relatedObjectType: meta.objectType ?? row.entity ?? null,
    relatedObjectId: meta.objectId ?? row.entity_id ?? null,
    occurredAt,
    // The audit row IS the record of the moment; there is no separate arrival.
    receivedAt: occurredAt,
    status: outcome || 'recorded',
    ownershipState: null,
    availableActions: [],
    nativeLinks: [],
    dataMode: 'production',
  }
}

export function createAuditLogSource(deps: SourceDeps<AuditLogRow>) {
  return buildSource(AUDIT_LOG_SOURCE, deps, (row: AuditLogRow, _q: ResolvedQuery) =>
    projectAuditLog(row),
  )
}
