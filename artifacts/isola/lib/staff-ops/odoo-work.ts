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
 * Plus the READS manager verification needs in order to resolve authoritative
 * ids instead of guessing them: `ir.model`, `ir.model.data`,
 * `mail.activity.type` and `res.users`. All `search_read`, all filtered, none
 * of them a write.
 * Nothing else. Every write is preceded by an assignment check against the
 * acting Odoo user, mirroring the guarantee the legacy bridge made.
 */

import { json2Call, type OdooConfig } from '@/engines/odoo'
import type { WorkRef, WorkRefModel } from './work-ref'
import { classifyStage, type StageConcept } from './stage-classifier'
import {
  isVerificationTargetModel,
  splitXmlId,
  type VerificationTargetModel,
} from './manager-verification'

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
 * ── Manager-verification: resolve, create, prove ─────────────────────────────
 *
 * Everything in this section exists because of
 * `def-spine-manager-verification-activity-never-created-2026-07-29`. The code
 * it replaces created a `mail.activity` by writing the STRING `res_model`,
 * which on this Odoo is `readonly` and merely `related` to `res_model_id`. The
 * record link never formed, Odoo refused every create with "Activities have to
 * be linked to records with a not null res_id", and the manager loop had
 * therefore never once worked.
 *
 * The fix is not "add a field". Every id the record needs is resolved from Odoo
 * at runtime, the target and the assignee are proven to exist before the write,
 * and the created record is read back and compared against what was asked for.
 * `dec-foundation-native-manager-verification-activity-2026-07-29` keeps all of
 * that in Foundation; nothing here calls BFF-v2.
 */

/**
 * Resolution caches, keyed per (url, db) because ids are per-database.
 *
 * The key deliberately excludes the API key: a key rotation must not silently
 * create a second cache entry, and no secret belongs in a map key.
 */
const odooModelIdCache = new Map<string, number>()
const odooActivityTypeCache = new Map<string, ResolvedActivityType>()

/** Test hook — the caches are process-global, so tests must be able to clear them. */
export function __resetOdooResolutionCaches(): void {
  odooModelIdCache.clear()
  odooActivityTypeCache.clear()
}

function resolutionCacheKey(config: OdooConfig, suffix: string): string {
  return `${config.url}|${config.db}|${suffix}`
}

/**
 * Resolve `res_model_id`, the authoritative link column on `mail.activity`.
 *
 * The allowlist is checked BEFORE Odoo is touched, so an unexpected model never
 * reaches `ir.model` at all. A caller-supplied model *id* is never accepted
 * anywhere — this function is the only way an id enters the create.
 */
export async function resolveVerificationModelId(
  config: OdooConfig,
  model: string,
): Promise<number | null> {
  if (!isVerificationTargetModel(model)) return null

  const key = resolutionCacheKey(config, `ir.model:${model}`)
  const cached = odooModelIdCache.get(key)
  if (cached) return cached

  const rows = (await json2Call(
    config,
    'ir.model',
    'search_read',
    { domain: [['model', '=', model]], fields: ['id', 'model'], limit: 1 },
    15000,
  ).catch(() => [])) as Record<string, unknown>[]

  const row = rows?.[0]
  if (!row || String(row.model ?? '') !== model) return null
  const id = Number(row.id)
  if (!Number.isInteger(id) || id <= 0) return null

  odooModelIdCache.set(key, id)
  return id
}

/** The target record, read authoritatively, with everything needed to validate it. */
export interface OdooTaskContext {
  taskId: number
  name: string
  projectId: number | null
  projectName: string | null
  stageName: string | null
  assigneeUserIds: number[]
}

/**
 * Existence check that actually checks existence.
 *
 * DO NOT replace this with `read({ ids: [id], fields: ['id'] })`. Proven
 * against this Odoo on 2026-07-29: `project.task.read` for id `99999999`
 * returns `[{"id": 99999999}]` — the id is echoed straight back, so a by-id
 * read selecting only `id` reports that every record exists. `search_read`
 * with an `id =` domain returns `[]` for the same input. A regression test
 * pins both halves of that so this cannot be reintroduced.
 */
export async function findTaskForVerification(
  config: OdooConfig,
  taskId: number,
): Promise<OdooTaskContext | null> {
  if (!Number.isInteger(taskId) || taskId <= 0) return null

  const rows = (await json2Call(
    config,
    'project.task',
    'search_read',
    {
      domain: [['id', '=', taskId]],
      fields: ['id', 'name', 'project_id', 'stage_id', 'user_ids'],
      limit: 1,
    },
    15000,
  ).catch(() => [])) as Record<string, unknown>[]

  const row = rows?.[0]
  if (!row) return null
  const id = Number(row.id)
  if (id !== taskId) return null

  return {
    taskId: id,
    name: String(row.name ?? ''),
    projectId: idOf(row.project_id),
    projectName: displayNameOf(row.project_id),
    stageName: displayNameOf(row.stage_id),
    assigneeUserIds: Array.isArray(row.user_ids)
      ? (row.user_ids as unknown[]).filter((n): n is number => typeof n === 'number')
      : [],
  }
}

export interface OdooUserRow {
  userId: number
  name: string
  login: string
}

/**
 * The manager, as Odoo currently holds them.
 *
 * `active = true` is part of the domain rather than a field to inspect
 * afterwards: an archived user can still be referenced by id, and assigning
 * verification work to someone who has left is a silent dead end.
 */
export async function findActiveOdooUser(
  config: OdooConfig,
  odooResUserId: number,
): Promise<OdooUserRow | null> {
  if (!Number.isInteger(odooResUserId) || odooResUserId <= 0) return null

  const rows = (await json2Call(
    config,
    'res.users',
    'search_read',
    {
      domain: [
        ['id', '=', odooResUserId],
        ['active', '=', true],
      ],
      fields: ['id', 'name', 'login'],
      limit: 1,
    },
    15000,
  ).catch(() => [])) as Record<string, unknown>[]

  const row = rows?.[0]
  if (!row) return null
  const id = Number(row.id)
  if (id !== odooResUserId) return null
  return { userId: id, name: String(row.name ?? ''), login: String(row.login ?? '') }
}

export interface ResolvedActivityType {
  activityTypeId: number
  name: string
  /** How it was resolved, so an operator can see which source won. */
  via: 'xml_id' | 'configured_id' | 'name'
}

/**
 * Read one `mail.activity.type` and confirm it is usable on our target model.
 *
 * A type carrying its own `res_model` is scoped to that model — `Time Off
 * Approval` exists on this database and belongs to `hr.leave`. Using one on a
 * `project.task` would be a nonsense record, so a scoped type is only accepted
 * when its scope is a model we actually target.
 */
async function readUsableActivityType(
  config: OdooConfig,
  activityTypeId: number,
): Promise<{ activityTypeId: number; name: string } | null> {
  if (!Number.isInteger(activityTypeId) || activityTypeId <= 0) return null

  const rows = (await json2Call(
    config,
    'mail.activity.type',
    'search_read',
    { domain: [['id', '=', activityTypeId]], fields: ['id', 'name', 'res_model'], limit: 1 },
    15000,
  ).catch(() => [])) as Record<string, unknown>[]

  const row = rows?.[0]
  if (!row) return null
  const id = Number(row.id)
  if (id !== activityTypeId) return null

  const scope = row.res_model
  if (typeof scope === 'string' && scope.length > 0 && !isVerificationTargetModel(scope)) return null

  return { activityTypeId: id, name: String(row.name ?? '') }
}

/**
 * Resolve `activity_type_id` at runtime, in this order:
 *   1. the configured (or default) XML id, via `ir.model.data`;
 *   2. an explicitly configured numeric id — still verified to exist;
 *   3. an allowlisted type name.
 *
 * A database id is never assumed. The code this replaces returned the literal
 * `4`, which is correct on this tenant and would be silently wrong on the next
 * one. When nothing resolves the answer is null, and the caller must refuse —
 * creating an activity with a bogus type is worse than not creating one.
 */
export async function resolveVerificationActivityType(
  config: OdooConfig,
  opts: {
    xmlId?: string | null
    configuredId?: number | null
    names?: readonly string[]
  } = {},
): Promise<ResolvedActivityType | null> {
  const xmlId = (opts.xmlId ?? '').trim()
  const names = opts.names ?? []
  const key = resolutionCacheKey(
    config,
    `activity_type:${xmlId}|${opts.configuredId ?? ''}|${names.join(',')}`,
  )
  const cached = odooActivityTypeCache.get(key)
  if (cached) return cached

  const remember = (r: ResolvedActivityType): ResolvedActivityType => {
    odooActivityTypeCache.set(key, r)
    return r
  }

  // 1. XML id — the stable, database-independent handle.
  const parts = xmlId ? splitXmlId(xmlId) : null
  if (parts) {
    const dataRows = (await json2Call(
      config,
      'ir.model.data',
      'search_read',
      {
        domain: [
          ['module', '=', parts.module],
          ['name', '=', parts.name],
          ['model', '=', 'mail.activity.type'],
        ],
        fields: ['id', 'res_id'],
        limit: 1,
      },
      15000,
    ).catch(() => [])) as Record<string, unknown>[]

    const resId = Number(dataRows?.[0]?.res_id ?? 0)
    if (Number.isInteger(resId) && resId > 0) {
      const usable = await readUsableActivityType(config, resId)
      if (usable) return remember({ ...usable, via: 'xml_id' })
    }
  }

  // 2. Explicitly configured id — verified, never trusted on sight.
  if (opts.configuredId) {
    const usable = await readUsableActivityType(config, opts.configuredId)
    if (usable) return remember({ ...usable, via: 'configured_id' })
  }

  // 3. Allowlisted name.
  if (names.length > 0) {
    const rows = (await json2Call(
      config,
      'mail.activity.type',
      'search_read',
      { domain: [['name', 'in', [...names]]], fields: ['id', 'name', 'res_model'], limit: 10 },
      15000,
    ).catch(() => [])) as Record<string, unknown>[]

    for (const row of rows ?? []) {
      const scope = row.res_model
      if (typeof scope === 'string' && scope.length > 0 && !isVerificationTargetModel(scope)) continue
      const id = Number(row.id)
      if (Number.isInteger(id) && id > 0) {
        return remember({ activityTypeId: id, name: String(row.name ?? ''), via: 'name' })
      }
    }
  }

  return null
}

export interface CreateVerificationActivityInput {
  resModel: VerificationTargetModel
  resModelId: number
  resId: number
  activityTypeId: number
  managerOdooResUserId: number
  summary: string
  note: string
  /** `date_deadline` is REQUIRED on mail.activity — always supplied, never defaulted server-side. */
  dateDeadline: string
}

export type CreateVerificationActivityResult =
  | { ok: true; activity: OdooVerificationActivity }
  | { ok: false; reason: string; activityId?: number }

/**
 * Create the manager-verification activity, then read it back.
 *
 * `res_model` is NOT written. It is readonly and related to `res_model_id` on
 * this Odoo, and writing it is the entire defect. Only resolved ids go in.
 *
 * The readback is not decoration: a create that reports an id but stored
 * something else is the same class of untruth as a stage move that claims to
 * have happened. On a readback failure the id we did get is returned alongside
 * the refusal, so an activity that exists but could not be proven is traceable
 * rather than lost.
 */
export async function createManagerVerificationActivity(
  config: OdooConfig,
  input: CreateVerificationActivityInput,
): Promise<CreateVerificationActivityResult> {
  if (!isVerificationTargetModel(input.resModel)) return { ok: false, reason: 'model_not_allowlisted' }
  if (!Number.isInteger(input.resModelId) || input.resModelId <= 0) return { ok: false, reason: 'res_model_id_unresolved' }
  if (!Number.isInteger(input.resId) || input.resId <= 0) return { ok: false, reason: 'res_id_invalid' }
  if (!Number.isInteger(input.activityTypeId) || input.activityTypeId <= 0) return { ok: false, reason: 'activity_type_unresolved' }
  if (!Number.isInteger(input.managerOdooResUserId) || input.managerOdooResUserId <= 0) return { ok: false, reason: 'user_id_invalid' }

  let activityId: number
  try {
    const created = (await json2Call(
      config,
      'mail.activity',
      'create',
      {
        vals_list: [
          {
            res_model_id: input.resModelId,
            res_id: input.resId,
            activity_type_id: input.activityTypeId,
            user_id: input.managerOdooResUserId,
            summary: input.summary,
            note: input.note,
            date_deadline: input.dateDeadline,
          },
        ],
      },
      20000,
    )) as number[] | number

    const id = Array.isArray(created) ? created[0] : created
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return { ok: false, reason: 'mail.activity create returned no id' }
    }
    activityId = id
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'mail.activity create failed' }
  }

  const activity = await readVerificationActivity(config, activityId)
  if (!activity) return { ok: false, reason: 'activity_readback_failed', activityId }
  return { ok: true, activity }
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
 * A verification activity, read back from Odoo as the authority on who owns it
 * and what it hangs on.
 *
 * `readWorkRecord` already handles `mail.activity`, but it flattens the row
 * into an `OdooWorkRecord` and DISCARDS `res_model` / `res_id` — there is no
 * field on that shape to carry them. That loss matters: without the parent
 * reference there is no way to prove a tapped activity actually belongs to the
 * task a verdict is about to move, so a manager could be shown one task and
 * silently act on another. This read exists to close that gap.
 */
export interface OdooVerificationActivity {
  activityId: number
  /** The model the activity hangs on. Only `project.task` is actionable here. */
  resModel: string
  /** `res_model_id` - the AUTHORITATIVE link column. `res_model` only mirrors it. */
  resModelId: number | null
  /** The record the activity hangs on. */
  resId: number
  /** The Odoo user the activity is assigned to — the ONLY person who may resolve it. */
  userId: number | null
  summary: string | null
  /** The activity type Odoo actually stored, so a readback can be compared. */
  activityTypeId: number | null
}

/**
 * Read an open verification activity.
 *
 * Returns null when the activity does not exist OR is no longer open. Odoo's
 * `action_feedback` removes a completed `mail.activity` (it becomes a
 * `mail.message`), so "already resolved" and "never existed" are genuinely
 * indistinguishable at this layer — and both must refuse. Callers must say
 * "already resolved or no longer open" rather than guessing which one it was.
 */
export async function readVerificationActivity(
  config: OdooConfig,
  activityId: number,
): Promise<OdooVerificationActivity | null> {
  if (!Number.isInteger(activityId) || activityId <= 0) return null
  const rows = (await json2Call(
    config,
    'mail.activity',
    'search_read',
    {
      domain: [['id', '=', activityId]],
      fields: ['id', 'summary', 'user_id', 'res_model', 'res_model_id', 'res_id', 'activity_type_id'],
      limit: 1,
    },
    15000,
  ).catch(() => [])) as Record<string, unknown>[]
  const row = rows?.[0]
  if (!row) return null
  return {
    activityId: Number(row.id),
    resModel: String(row.res_model ?? ''),
    resModelId: idOf(row.res_model_id),
    resId: Number(row.res_id ?? 0),
    userId: idOf(row.user_id),
    summary: typeof row.summary === 'string' ? row.summary : null,
    activityTypeId: idOf(row.activity_type_id),
  }
}

/**
 * Derive the staff actions that are valid for a record right now, based only on
 * what Odoo says about its current state. Used to give an informative reply when
 * a START/RESUME is refused — the caller never needs to consult Foundation-side
 * state; the record fields from Odoo are sufficient.
 *
 * Returns `string[]` (not a typed union) to avoid a dependency on staff-action.ts,
 * which is a pure parser module with no knowledge of Odoo records.
 */
export function deriveValidNextActions(record: OdooWorkRecord): string[] {
  // mail.activity carries no project stage and does not support blocking.
  if (record.odooModel === 'mail.activity') {
    return ['ack', 'update', 'done', 'correct']
  }
  // project.task / helpdesk.ticket: all standard write actions apply.
  return ['ack', 'start', 'update', 'blocked', 'done', 'correct']
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
    return { ok: true, detail: { stageId, stageName } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'stage write failed' }
  }
}

/**
 * Move a task to whichever stage in ITS OWN project means `concept`.
 *
 * `moveTaskToStage` above matches an exact name, which cannot work across
 * boards: Odoo stage names are per-project free text, so a single global
 * `In-Progress` finds nothing on a board whose stages are `In Development` and
 * `Under Investigation` — and the move then fails silently while the staff
 * member is told it succeeded
 * (`def-spine-start-reports-started-without-odoo-stage-move-2026-07-29`).
 *
 * This reads the project's real stage list and classifies each name, so the
 * board's own vocabulary decides. When nothing classifies, the reason carries
 * the stage names that WERE found — an operator should never have to guess why
 * a move did not happen.
 */
export async function moveTaskToConceptStage(
  config: OdooConfig,
  task: OdooWorkRecord,
  concept: StageConcept,
): Promise<OdooWriteOutcome> {
  if (task.odooModel !== 'project.task') return { ok: false, reason: 'stage_move_only_on_project_task' }
  if (!task.projectId) return { ok: false, reason: 'task_has_no_project' }

  if (classifyStage(task.stageName) === concept) {
    return { ok: true, detail: { noop: true, reason: 'already_in_concept', stageName: task.stageName } }
  }

  try {
    const stages = (await json2Call(
      config,
      'project.task.type',
      'search_read',
      {
        domain: [['project_ids', 'in', [task.projectId]]],
        fields: ['id', 'name', 'sequence'],
        order: 'sequence asc',
        limit: 60,
      },
      15000,
    )) as { id: number; name: string }[]

    const match = (stages ?? []).find((s) => classifyStage(s.name) === concept)
    if (!match) {
      const seen = (stages ?? []).map((s) => s.name).join(' | ')
      return {
        ok: false,
        reason: `no ${concept} stage in project ${task.projectId} (stages: ${seen || 'none'})`,
      }
    }

    await json2Call(config, 'project.task', 'write', { ids: [task.odooId], vals: { stage_id: match.id } }, 20000)
    return { ok: true, detail: { stageId: match.id, stageName: match.name } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'stage write failed' }
  }
}
