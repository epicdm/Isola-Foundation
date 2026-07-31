/**
 * StaffWorkAction → activity.
 *
 * The table already draws the distinction that matters: `applied_at` is null
 * until Odoo has actually accepted the write, and a row with `applied_at` null
 * is a request we did NOT complete. This adapter keeps four outcomes apart:
 *
 *   completed_verified      Odoo accepted it and the record came back
 *   readback_failed         we wrote something and cannot prove what
 *   dependency_unavailable  Odoo was unreachable; retrying is sensible
 *   execution_failed        Odoo refused it; retrying the same thing will not help
 *
 * Collapsing those into done/failed is how a staff member is told their task was
 * created when no task exists.
 */

import type { ActivityItem, EventType, ResolvedQuery } from '../feed'
import { actorKindOf, buildSource, deepLink, iso, summarise, type SourceDeps } from './shared'

export const STAFF_WORK_SOURCE = 'staff_work_action'

export interface StaffWorkActionRow {
  id: string
  tenant_id: string
  staff_binding_id: string
  work_ref_model: string
  work_ref_id: number
  correlation_id: string
  action: string
  note: string | null
  source: string
  applied_at: Date | null
  odoo_result: unknown
  failure_reason: string | null
  created_at: Date
}

export const WORK_OUTCOMES = [
  'completed_verified',
  'readback_failed',
  'dependency_unavailable',
  'execution_failed',
  'in_progress',
] as const
export type WorkOutcome = (typeof WORK_OUTCOMES)[number]

/**
 * Which of the four it was. Order matters: "unreachable" is checked before
 * "failed", because a timeout message often contains both words and only one of
 * them tells the operator whether a retry is worth anything.
 */
export function classifyWorkOutcome(row: {
  applied_at: Date | null
  failure_reason: string | null
}): WorkOutcome {
  if (row.applied_at) return 'completed_verified'

  const reason = row.failure_reason ?? ''
  if (!reason) return 'in_progress'

  if (/readback|read.?back|could not verify|unverified|mismatch/i.test(reason)) {
    return 'readback_failed'
  }
  if (/unavailable|unreachable|timeout|timed out|ECONN|ENOTFOUND|5\d\d|offline|down/i.test(reason)) {
    return 'dependency_unavailable'
  }
  return 'execution_failed'
}

const OUTCOME_TITLE: Readonly<Record<WorkOutcome, string>> = {
  completed_verified: 'Done and confirmed',
  readback_failed: 'Written, but NOT confirmed — do not treat this as done',
  dependency_unavailable: 'Not done — the system of record was unreachable',
  execution_failed: 'Not done — the system of record refused it',
  in_progress: 'In progress — not confirmed yet',
}

/** Which Odoo model the work sits on decides what kind of event it is. */
const MODEL_EVENT: Readonly<Record<string, EventType>> = {
  'project.task': 'task.updated',
  'mail.activity': 'activity.scheduled',
  'helpdesk.ticket': 'task.updated',
  'crm.lead': 'lead.updated',
}

/** The staff verb, kept in plain words. */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  ack: 'acknowledged',
  update: 'updated',
  blocked: 'reported blocked',
  done: 'marked done',
  help: 'asked for help',
  correct: 'corrected',
}

export interface StaffWorkDeps extends SourceDeps<StaffWorkActionRow> {
  /** Omitted when we have no Odoo base URL; a fabricated link is worse than none. */
  odooBaseUrl?: string | null
}

export function projectStaffWorkAction(
  row: StaffWorkActionRow,
  odooBaseUrl?: string | null,
): ActivityItem {
  const outcome = classifyWorkOutcome(row)
  const eventType = MODEL_EVENT[row.work_ref_model] ?? 'task.updated'
  const verb = ACTION_LABEL[row.action] ?? row.action
  const occurredAt = iso(row.created_at)

  return {
    activityId: `staffwork:${row.id}`,
    eventType,
    title: OUTCOME_TITLE[outcome],
    summary: summarise(
      [`Staff ${verb} ${row.work_ref_model} #${row.work_ref_id}`, row.note].filter(Boolean).join(' — '),
    ),
    sourceSystem: STAFF_WORK_SOURCE,
    provenance: {
      source: STAFF_WORK_SOURCE,
      fetchedAt: occurredAt,
      trust: 'authoritative',
      upstreamRef: row.correlation_id,
    },
    actor: {
      // The staff binding, never the handset number it maps to.
      ref: `staff:${row.staff_binding_id}`,
      label: `staff:${row.staff_binding_id}`,
      kind: actorKindOf(`staff:${row.staff_binding_id}`),
    },
    companyId: row.tenant_id,
    customerId: null,
    customerLabel: null,
    relatedObjectType: row.work_ref_model,
    relatedObjectId: String(row.work_ref_id),
    occurredAt,
    // The staff member acted when they acted; Odoo confirming later does not
    // move the event, it only changes its outcome.
    receivedAt: iso(row.applied_at ?? row.created_at),
    status: outcome,
    ownershipState: null,
    availableActions: [],
    nativeLinks: deepLink(
      'odoo',
      `Open ${row.work_ref_model}`,
      odooBaseUrl,
      `/odoo/${encodeURIComponent(row.work_ref_model)}/${row.work_ref_id}`,
    ),
    dataMode: 'production',
  }
}

export function createStaffWorkActionSource(deps: StaffWorkDeps) {
  return buildSource(STAFF_WORK_SOURCE, deps, (row: StaffWorkActionRow, _q: ResolvedQuery) =>
    projectStaffWorkAction(row, deps.odooBaseUrl),
  )
}
