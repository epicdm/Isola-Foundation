/**
 * manager-verification.ts — the pure core of Foundation-native manager
 * verification.
 *
 * WHY THIS MODULE EXISTS
 *
 * `def-spine-manager-verification-activity-never-created-2026-07-29`. A staff
 * DONE tried to create a `mail.activity` by writing the STRING field
 * `res_model`. Read from this Odoo's own `fields_get` on 2026-07-29:
 *
 *   res_model_id  { type: many2one, relation: ir.model, readonly: false, store: true }
 *   res_model     { type: char,     related: 'res_model_id.model', readonly: TRUE }
 *   res_id        { type: many2one_reference, readonly: false, store: true }
 *   date_deadline { type: date, required: TRUE }
 *
 * `res_model` is readonly and merely mirrors `res_model_id`. Writing the string
 * alone left the link half-formed, so Odoo refused the record with
 * "Activities have to be linked to records with a not null res_id." Nothing was
 * created; no manager was ever asked to verify anything. `date_deadline` being
 * required is why this module always computes one rather than relying on a
 * server-side default.
 *
 * `dec-foundation-native-manager-verification-activity-2026-07-29` puts the
 * permanent capability in Foundation and forbids reaching for the transitional
 * BFF-v2 activity route. Foundation owns operation identity,
 * deduplication, manager resolution, creation, readback and audit.
 *
 * THIS FILE IS PURE — no Prisma, no network, no Odoo. Every decision the
 * capability makes lives here so it is testable without a database, which is
 * the same split the rest of the lane already uses (staff-action.ts,
 * stage-classifier.ts, manager-verdict.ts).
 */

/**
 * The models a manager-verification activity may hang on.
 *
 * Deliberately ONE. `dec-foundation-native-...` asks for a bounded capability,
 * not a generic "create any Odoo activity" API: a broad model parameter reached
 * from an inbound WhatsApp path is an arbitrary-write primitive wearing a
 * verification costume. Widen this list only when a Foundation contract
 * genuinely requires it.
 */
export const VERIFICATION_TARGET_MODELS = ['project.task'] as const
export type VerificationTargetModel = (typeof VERIFICATION_TARGET_MODELS)[number]

export function isVerificationTargetModel(model: unknown): model is VerificationTargetModel {
  return typeof model === 'string' && (VERIFICATION_TARGET_MODELS as readonly string[]).includes(model)
}

/**
 * XML id of the generic To-Do activity type. Resolved through Odoo at runtime
 * rather than hardcoded, because activity-type ids are per-database — the old
 * code's literal `4` happened to be right on this tenant and would be silently
 * wrong on the next one.
 */
export const VERIFICATION_ACTIVITY_TYPE_XML_ID = 'mail.mail_activity_data_todo'

/** Last-resort allowlist, used only when no XML id and no configured id resolve. */
export const VERIFICATION_ACTIVITY_TYPE_NAMES = ['To-Do', 'To Do', 'Todo'] as const

/** The one operation this module names. Part of every operation id. */
export const MANAGER_VERIFICATION_OPERATION = 'manager_verification_request'

/** Default days until the manager's activity is due. */
export const VERIFICATION_DEADLINE_DAYS_DEFAULT = 2

export interface ManagerVerificationOperation {
  tenantId: string
  workRefModel: string
  workRefId: number
  /** The verification episode — the StaffWorkAction row id of the staff DONE. */
  episodeId: string
  managerOdooResUserId: number
}

/**
 * The Foundation-owned operation id for one manager-verification request.
 *
 * Deterministic for retries of the SAME episode and different for a fresh one,
 * because the episode id is the DONE action row that raised it. Derived from
 * authoritative fields only — never from summary text, which is display copy
 * that can change without the operation changing.
 */
export function managerVerificationOperationId(op: ManagerVerificationOperation): string {
  return [
    'mv1',
    op.tenantId,
    `${op.workRefModel}#${op.workRefId}`,
    `ep:${op.episodeId}`,
    `mgr:${op.managerOdooResUserId}`,
    MANAGER_VERIFICATION_OPERATION,
  ].join(':')
}

/**
 * Every way this capability is allowed to refuse. A refusal is a fact that gets
 * recorded and returned as `requested:false`; it never becomes a manager notice
 * and never invents a recipient.
 */
export type VerificationRefusal =
  | 'staff_member_has_no_manager'
  | 'operation_id_conflict'
  | 'verification_in_flight'
  | 'model_not_allowlisted'
  | 'model_not_resolvable_in_odoo'
  | 'task_not_found'
  | 'task_is_not_the_current_work_ref'
  | 'task_not_assigned_to_staff_member'
  | 'manager_not_bound_in_this_tenant'
  | 'manager_not_active_in_odoo'
  | 'activity_type_not_resolvable'
  | 'activity_create_failed'
  | 'activity_readback_failed'
  | 'activity_readback_mismatch'

/** The authoritative facts an operation id is derived from, as claimed. */
export interface ClaimedOperationFacts {
  tenantId: string
  workRefId: number
  managerOdooResUserId: number
  episodeId: string
}

export type OperationConflictField = 'tenant' | 'work_ref' | 'manager' | 'episode'

/**
 * Two requests carrying the same operation id must describe the same operation.
 *
 * The id is derived from these fields, so a mismatch means the stored claim and
 * the incoming request disagree about what is being verified. That is never a
 * retry — it is a corrupted or forged claim, and it must be refused rather than
 * quietly overwritten.
 */
export function operationConflict(
  claimed: Partial<ClaimedOperationFacts> | null | undefined,
  incoming: ClaimedOperationFacts,
): OperationConflictField | null {
  if (!claimed) return null
  if (claimed.tenantId != null && claimed.tenantId !== incoming.tenantId) return 'tenant'
  if (claimed.workRefId != null && claimed.workRefId !== incoming.workRefId) return 'work_ref'
  if (claimed.managerOdooResUserId != null && claimed.managerOdooResUserId !== incoming.managerOdooResUserId) {
    return 'manager'
  }
  if (claimed.episodeId != null && claimed.episodeId !== incoming.episodeId) return 'episode'
  return null
}

/** What Odoo says the created activity actually is, read back after creation. */
export interface VerificationReadback {
  activityId: number
  resModel: string
  resModelId: number | null
  resId: number
  userId: number | null
  activityTypeId: number | null
}

/** What Foundation asked for, and therefore what the readback must show. */
export interface VerificationExpectation {
  resModel: VerificationTargetModel
  resModelId: number
  resId: number
  userId: number
  activityTypeId: number
}

/**
 * Compare what Odoo holds against what was requested. Returns a human-readable
 * reason on the first disagreement, or null when the record is exactly right.
 *
 * `requested:true` is only allowed to be returned after this passes. A create
 * that reports an id but stored something else is the same class of untruth as
 * a stage move that claims to have happened — see
 * `def-spine-start-reports-started-without-odoo-stage-move-2026-07-29`.
 */
export function readbackMismatch(
  expected: VerificationExpectation,
  actual: VerificationReadback | null,
): string | null {
  if (!actual) return 'no readback'
  if (!Number.isInteger(actual.activityId) || actual.activityId <= 0) return `activity id ${actual.activityId}`
  if (actual.resModel !== expected.resModel) return `res_model ${actual.resModel || '(empty)'} != ${expected.resModel}`
  if (actual.resModelId !== expected.resModelId) return `res_model_id ${actual.resModelId} != ${expected.resModelId}`
  if (actual.resId !== expected.resId) return `res_id ${actual.resId} != ${expected.resId}`
  if (actual.userId !== expected.userId) return `user_id ${actual.userId} != ${expected.userId}`
  if (actual.activityTypeId !== expected.activityTypeId) {
    return `activity_type_id ${actual.activityTypeId} != ${expected.activityTypeId}`
  }
  return null
}

/**
 * `date_deadline` is REQUIRED on `mail.activity`, so it is always computed here
 * rather than left to a server default we do not control.
 */
export function verificationDeadline(now: Date, days: number = VERIFICATION_DEADLINE_DAYS_DEFAULT): string {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() + safeDays)
  return d.toISOString().slice(0, 10)
}

/** `mail.mail_activity_data_todo` → { module: 'mail', name: 'mail_activity_data_todo' }. */
export function splitXmlId(xmlId: string): { module: string; name: string } | null {
  const trimmed = (xmlId ?? '').trim()
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1) return null
  return { module: trimmed.slice(0, dot), name: trimmed.slice(dot + 1) }
}

/** Odoo caps `summary` at a char field; keep it short and recognisable. */
export function verificationSummary(taskName: string): string {
  return `Verify completion: ${taskName}`.slice(0, 120)
}

export function verificationNote(params: {
  staffName: string
  source: string
  note?: string | null
  correlationId: string
  operationId: string
}): string {
  const extra = params.note ? ` Note: ${params.note}` : ''
  return (
    `${params.staffName} reported this DONE via ${params.source}.${extra}` +
    ` Isola correlation: ${params.correlationId}. Isola operation: ${params.operationId}`
  )
}
