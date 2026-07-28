/**
 * odoo-work.ts — the governed Odoo work connector for Wave 1.
 *
 * Odoo is the system of record. This module reads authoritative work and
 * applies staff actions to it; Foundation stores correlation and audit, never
 * competing work truth (`dec-wave1-workref-odoo-only-2026-07-28`).
 *
 * REUSE, NOT REWRITE: transport is the existing portable JSON-2 client in
 * `@/engines/odoo` (`json2Call`), and the per-tenant credential comes from the
 * existing governed `OdooBinding` resolution in `@/lib/engine-bindings`. This
 * module adds only the staff-work verbs; it introduces no second transport, no
 * second credential path and no generic "call any method" capability.
 *
 * SCOPE DISCIPLINE — the writes this module can perform, exhaustively:
 *   - `project.task` / `helpdesk.ticket`: `message_post` (chatter note)
 *   - `project.task`: `write` of `stage_id` only
 *   - `mail.activity`: `create` (request manager verification),
 *     `action_feedback` (manager verifies / returns)
 * Nothing else. Every write is preceded by an assignment check against the
 * acting Odoo user, mirroring the guarantee the legacy bridge made.
 */

import { json2Call, type OdooConfig } from '@/engines/odoo'
import type { WorkRef, WorkRefModel } from './work-ref'

/** Odoo many2one arrives as [id, name] (classic) or {id, display_name} (JSON-2). */
function displayNameOf(value: unknown): string | null {
  if (!value) return null
  if (Array.isArray(value)) return typeof value[1] === 'string' ? value[1] : null
  if (typeof value === 'object' && 'display_name' in (value as Record<string, unknown>)) {
    const v = (value as { display_name?: unknown }).display_name
    return typeof v === 'string' ? v : null
  }
  return null
}

function idOf(value: unknown): number | null {
  if (!value) return null
  if (Array.isArray(value)) return typeof value[0] === 'number' ? value[0] : null
  if (typeof value === 'object' && 'id' in (value as Record<string, unknown>)) {
    const v = (value as { id?: unknown }).id
    return typeof v === 'number' ? v : null
  }
  return typeof value === 'number' ? value : null
}

export interface OdooWorkRecord {
  odooModel: WorkRefModel
  odooId: number
  name: string
  projectId: number | null
  projectName: string | null
  stageId: number | null
  stageName: string | null
  assigneeUserIds: number[]
  dateDeadline: string | null
  writeDate: string | null
}

const TASK_FIELDS = [
  'id',
  'name',
  'project_id',
  'stage_id',
  'user_ids',
  'date_deadline',
  'write_date',
]

/**
 * Open work assigned to one Odoo user. Always scoped by assignee — never "all
 * tasks" — because `project.task` carries no tenant dimension of its own, so an
 * unscoped read is a cross-tenant leak waiting to happen.
 *
 * Returns [] on any transport failure. Odoo is treated as best-effort for
 * READS: a staff member's phone reply must not 500 because Odoo is briefly
 * unreachable. Writes do NOT get this treatment — see postStaffActionNote.
 */
export async function listOpenTasksForUser(
  config: OdooConfig,
  odooResUserId: number,
  limit = 25,
): Promise<OdooWorkRecord[]> {
  const rows = (await json2Call(
    config,
    'project.task',
    'search_read',
    {
      domain: [
        ['user_ids', 'in', [odooResUserId]],
        ['active', '=', true],
        ['stage_id.name', 'not in', ['Done', 'Cancelled', 'Solved']],
      ],
      fields: TASK_FIELDS,
      order: 'write_date desc',
      limit,
    },
    15000,
  ).catch(() => [])) as Record<string, unknown>[]

  return (rows ?? []).map((r) => ({
    odooModel: 'project.task' as const,
    odooId: Number(r.id),
    name: String(r.name ?? ''),
    projectId: idOf(r.project_id),
    projectName: displayNameOf(r.project_id),
    stageId: idOf(r.stage_id),
    stageName: displayNameOf(r.stage_id),
    assigneeUserIds: Array.isArray(r.user_ids) ? (r.user_ids as number[]).filter((n) => typeof n === 'number') : [],
    dateDeadline: typeof r.date_deadline === 'string' ? r.date_deadline : null,
    writeDate: typeof r.write_date === 'string' ? r.write_date : null,
  }))
}

/** Read one work record by WorkRef. Returns null when it does not exist. */
export async function readWorkRecord(
  config: OdooConfig,
  ref: Pick<WorkRef, 'odooModel' | 'odooId'>,
): Promise<OdooWorkRecord | null> {
  if (ref.odooModel === 'mail.activity') {
    const rows = (await json2Call(
      config,
      'mail.activity',
      'search_read',
      { domain: [['id', '=', ref.odooId]], fields: ['id', 'summary', 'user_id', 'res_model', 'res_id', 'date_deadline'], limit: 1 },
      15000,
    ).catch(() => [])) as Record<string, unknown>[]
    const row = rows?.[0]
    if (!row) return null
    return {
      odooModel: 'mail.activity',
      odooId: Number(row.id),
      name: String(row.summary ?? ''),
      projectId: null,
      projectName: null,
      stageId: null,
      stageName: null,
      assigneeUserIds: idOf(row.user_id) != null ? [idOf(row.user_id) as number] : [],
      dateDeadline: typeof row.date_deadline === 'string' ? row.date_deadline : null,
      writeDate: null,
    }
  }

  const rows = (await json2Call(
    config,
    ref.odooModel,
    'search_read',
    { domain: [['id', '=', ref.odooId]], fields: TASK_FIELDS, limit: 1 },
    15000,
  ).catch(() => [])) as Record<string, unknown>[]
  const row = rows?.[0]
  if (!row) return null

  return {
    odooModel: ref.odooModel,
    odooId: Number(row.id),
    name: String(row.name ?? ''),
    projectId: idOf(row.project_id),
    projectName: displayNameOf(row.project_id),
    stageId: idOf(row.stage_id),
    stageName: displayNameOf(row.stage_id),
    assigneeUserIds: Array.isArray(row.user_ids) ? (row.user_ids as number[]).filter((n) => typeof n === 'number') : [],
    dateDeadline: typeof row.date_deadline === 'string' ? row.date_deadline : null,
    writeDate: typeof row.write_date === 'string' ? row.write_date : null,
  }
}

// ── Pure guards (exported so they are tested directly, not through I/O) ──────

export type AssignmentCheck =
  | { allowed: true }
  | { allowed: false; reason: 'record_not_found' | 'not_assigned_to_actor' }

/**
 * A staff member may only act on work Odoo says is theirs. This is the
 * write-side authority check and it is deliberately a pure function of the
 * record Odoo just returned — not of anything Foundation stored earlier, which
 * could be stale.
 */
export function checkActorMayAct(
  record: OdooWorkRecord | null,
  actorOdooResUserId: number,
): AssignmentCheck {
  if (!record) return { allowed: false, reason: 'record_not_found' }
  if (!record.assigneeUserIds.includes(actorOdooResUserId)) {
    return { allowed: false, reason: 'not_assigned_to_actor' }
  }
  return { allowed: true }
}

/**
 * Render the chatter note for a staff action. Kept pure and separate so the
 * exact wording is pinned by tests — chatter is the durable human-readable
 * trail in the system of record, and it is the thing a manager actually reads.
 */
export function renderChatterNote(params: {
  action: string
  actorName: string
  note: string | null
  correlationId: string
  channel: string
}): string {
  const noteLine = params.note ? `<br/>${escapeHtml(params.note)}` : ''
  return (
    `<p><b>${escapeHtml(params.action.toUpperCase())}</b> — ${escapeHtml(params.actorName)} ` +
    `via ${escapeHtml(params.channel)}${noteLine}` +
    `<br/><i>Isola correlation: ${escapeHtml(params.correlationId)}</i></p>`
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Writes ───────────────────────────────────────────────────────────────

export type OdooWriteOutcome =
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; reason: string }

/**
 * Post a chatter note recording a staff action against the authoritative
 * record. This is the ONE durable write every action performs; stage moves and
 * verification requests are additional, action-specific, and optional.
 *
 * Unlike the read helpers, this does NOT swallow errors. A staff member who is
 * told their update was recorded when it was not is exactly the failure mode
 * this whole packet exists to remove.
 */
export async function postStaffActionNote(
  config: OdooConfig,
  ref: Pick<WorkRef, 'odooModel' | 'odooId'>,
  body: string,
): Promise<OdooWriteOutcome> {
  if (ref.odooModel === 'mail.activity') {
    return { ok: false, reason: 'chatter_not_supported_on_mail_activity' }
  }
  try {
    const res = await json2Call(
      config,
      ref.odooModel,
      'message_post',
      { ids: [ref.odooId], body, message_type: 'comment' },
      20000,
    )
    return { ok: true, detail: { messagePost: res ?? null } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'message_post failed' }
  }
}

/**
 * Request manager verification by creating a `mail.activity` on the
 * authoritative record, assigned to the manager.
 *
 * `mail.activity` is Odoo-native, is already in live use on this tenant, and is
 * one of the three models the ratified WorkRef permits — so the verification
 * object is itself addressable as a WorkRef and the manager's reply routes
 * through exactly the same path as any other staff action. No parallel
 * approval model is introduced.
 */
export async function requestManagerVerification(
  config: OdooConfig,
  ref: Pick<WorkRef, 'odooModel' | 'odooId'>,
  params: {
    managerOdooResUserId: number
    summary: string
    note: string
    activityTypeId: number
    dateDeadline?: string
  },
): Promise<OdooWriteOutcome & { activityId?: number }> {
  try {
    const created = (await json2Call(
      config,
      'mail.activity',
      'create',
      {
        vals_list: [
          {
            res_model: ref.odooModel,
            res_id: ref.odooId,
            activity_type_id: params.activityTypeId,
            summary: params.summary,
            note: params.note,
            user_id: params.managerOdooResUserId,
            ...(params.dateDeadline ? { date_deadline: params.dateDeadline } : {}),
          },
        ],
      },
      20000,
    )) as number[] | number

    const activityId = Array.isArray(created) ? created[0] : created
    if (typeof activityId !== 'number') {
      return { ok: false, reason: 'mail.activity create returned no id' }
    }
    return { ok: true, detail: { activityId }, activityId }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'mail.activity create failed' }
  }
}

/**
 * Close a verification activity with the manager's outcome. `feedback` lands in
 * the record's chatter, so a returned task carries the manager's reason in the
 * system of record rather than only in a Foundation row.
 */
export async function completeVerificationActivity(
  config: OdooConfig,
  activityId: number,
  feedback: string,
): Promise<OdooWriteOutcome> {
  try {
    const res = await json2Call(
      config,
      'mail.activity',
      'action_feedback',
      { ids: [activityId], feedback },
      20000,
    )
    return { ok: true, detail: { actionFeedback: res ?? null } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'action_feedback failed' }
  }
}

/**
 * Move a `project.task` to a named stage within its own project. Stages are
 * per-project rows, so the name must be resolved against THIS task's project —
 * a stage id borrowed from another project silently corrupts the board.
 *
 * Idempotent: when the task is already in the target stage, no write is issued.
 */
export async function moveTaskToStage(
  config: OdooConfig,
  task: OdooWorkRecord,
  stageName: string,
): Promise<OdooWriteOutcome> {
  if (task.odooModel !== 'project.task') return { ok: false, reason: 'stage_move_only_on_project_task' }
  if (!task.projectId) return { ok: false, reason: 'task_has_no_project' }
  if (task.stageName && task.stageName.toLowerCase() === stageName.toLowerCase()) {
    return { ok: true, detail: { noop: true, reason: 'already_in_stage' } }
  }

  try {
    const stages = (await json2Call(
      config,
      'project.task.type',
      'search_read',
      {
        domain: [
          ['project_ids', 'in', [task.projectId]],
          ['name', '=', stageName],
        ],
        fields: ['id'],
        limit: 1,
      },
      15000,
    )) as { id: number }[]

    const stageId = stages?.[0]?.id
    if (typeof stageId !== 'number') {
      return { ok: false, reason: `stage "${stageName}" not found in project ${task.projectId}` }
    }

    await json2Call(config, 'project.task', 'write', { ids: [task.odooId], vals: { stage_id: stageId } }, 20000)
    return { ok: true, detail: { stageId } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'stage write failed' }
  }
}
