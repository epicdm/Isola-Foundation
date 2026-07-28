/**
 * service.ts — the orchestration layer that turns the Wave 1 contracts into
 * real work. This is the only module in the staff-ops lane that touches
 * Prisma, Odoo and the outbox in the same breath; every decision it makes is
 * delegated to a pure core so the decisions stay testable without a database.
 *
 * Odoo is the system of record. Nothing here stores work state — it stores who
 * a person is (StaffBinding), that an action was requested and applied
 * (StaffWorkAction), and that a notification was attempted (NotificationOutbox).
 * If Foundation and Odoo ever disagree about a task, Odoo is right.
 */

import { prisma } from '../prisma'
import { audit } from '../audit'
import { enqueueNotification } from '../notify'
import { resolveOdooConfigForTenant } from '../engine-bindings'
import {
  checkActorMayAct,
  completeVerificationActivity,
  deriveValidNextActions,
  listOpenTasksForUser,
  moveTaskToStage,
  postStaffActionNote,
  readWorkRecord,
  renderChatterNote,
  requestManagerVerification,
  type OdooWorkRecord,
} from './odoo-work'
import {
  decideInboundRoute,
  type InboundRoute,
  type StaffBindingRow,
} from './inbound-routing'
import {
  staffActionIdempotencyKey,
  type OpenWorkRefCandidate,
  type StaffActionKind,
} from './staff-action'
import {
  INTERNAL_TASK_TEMPLATE,
  buildStaffNotification,
  decideDispatchMode,
} from './staff-notification'
import { mintCorrelationId, type WorkRefModel } from './work-ref'

/**
 * Odoo activity type used to request manager verification. 4 is "To-Do" on
 * this tenant. Overridable because activity-type ids are per-database.
 */
function verificationActivityTypeId(): number {
  const raw = Number(process.env.STAFF_VERIFICATION_ACTIVITY_TYPE_ID)
  return Number.isInteger(raw) && raw > 0 ? raw : 4
}

/**
 * A deterministic nonce, so work that has never been dispatched still gets a
 * STABLE correlation id across calls.
 *
 * This matters more than it looks. `openWork` is recomputed on every inbound
 * message; if the correlation id changed each time, the idempotency key for a
 * staff action would change with it, and a Meta webhook retry would apply the
 * action twice. Derived from the binding id and the record, so it is stable for
 * a given (person, task) pair and different for every other pair.
 */
export function stableCorrelationNonce(staffBindingId: string, odooModel: string, odooId: number): string {
  const input = `${staffBindingId}:${odooModel}:${odooId}`
  let h = 2166136261 // FNV-1a 32-bit
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7)
}

function toBindingRow(r: {
  id: string
  tenant_id: string
  odoo_res_user_id: number
  display_name: string
  wa_id: string | null
  role: string
  active: boolean
  manager_odoo_res_user_id: number | null
}): StaffBindingRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    odooResUserId: r.odoo_res_user_id,
    displayName: r.display_name,
    waId: r.wa_id,
    role: r.role,
    active: r.active,
    managerOdooResUserId: r.manager_odoo_res_user_id,
  }
}

const BINDING_SELECT = {
  id: true,
  tenant_id: true,
  odoo_res_user_id: true,
  display_name: true,
  wa_id: true,
  role: true,
  active: true,
  manager_odoo_res_user_id: true,
} as const

/**
 * Every binding matching this WhatsApp identity, across ALL tenants.
 *
 * Deliberately unfiltered by tenant: a number bound in two tenants is a
 * cross-tenant exposure, and `resolveStaffIdentity` can only refuse it if it
 * can see it. Pre-filtering here would hide the very thing that must fail.
 */
export async function findBindingsByWaId(waId: string): Promise<StaffBindingRow[]> {
  const rows = await prisma.staffBinding.findMany({ where: { wa_id: waId }, select: BINDING_SELECT })
  return rows.map(toBindingRow)
}

export async function findBindingByOdooUser(
  tenantId: string,
  odooResUserId: number,
): Promise<StaffBindingRow | null> {
  const row = await prisma.staffBinding.findUnique({
    where: { tenant_id_odoo_res_user_id: { tenant_id: tenantId, odoo_res_user_id: odooResUserId } },
    select: BINDING_SELECT,
  })
  return row ? toBindingRow(row) : null
}

export interface OpenWorkItem extends OpenWorkRefCandidate {
  projectName: string | null
  stageName: string | null
  dueDate: string | null
}

/**
 * The staff member's open work, straight from Odoo, each carrying a stable
 * correlation id.
 *
 * An existing dispatch's correlation id wins, so an ACK lands on the same
 * episode the dispatch created. Work that has never been dispatched still gets
 * a deterministic id, because a staff member is allowed to acknowledge
 * something they saw in Odoo rather than in a message.
 */
export async function listOpenWorkForStaff(binding: StaffBindingRow): Promise<OpenWorkItem[]> {
  const config = await resolveOdooConfigForTenant(binding.tenantId)
  const tasks = await listOpenTasksForUser(config, binding.odooResUserId)
  if (tasks.length === 0) return []

  const dispatched = await prisma.notificationOutbox.findMany({
    where: {
      tenant_id: binding.tenantId,
      work_ref_model: 'project.task',
      work_ref_id: { in: tasks.map((t) => t.odooId) },
      correlation_id: { not: null },
    },
    select: { work_ref_id: true, correlation_id: true },
    orderBy: { created_at: 'desc' },
  })
  const byTask = new Map<number, string>()
  for (const d of dispatched) {
    if (d.work_ref_id != null && d.correlation_id && !byTask.has(d.work_ref_id)) {
      byTask.set(d.work_ref_id, d.correlation_id)
    }
  }

  return tasks.map((t) => ({
    odooModel: t.odooModel,
    odooId: t.odooId,
    correlationId:
      byTask.get(t.odooId) ??
      mintCorrelationId(
        binding.tenantId,
        t.odooModel,
        t.odooId,
        stableCorrelationNonce(binding.id, t.odooModel, t.odooId),
      ),
    label: t.name,
    projectName: t.projectName,
    stageName: t.stageName,
    dueDate: t.dateDeadline,
  }))
}

export interface ResolveInboundInput {
  waId: string
  text: string
  channelTenantId?: string | null
}

export interface ResolveInboundResult {
  route: InboundRoute
  openWork: OpenWorkItem[]
}

/**
 * Work that is actually IN PLAY with this person right now: dispatched to them
 * and not yet reported DONE.
 *
 * FOUND BY THE SHADOW RUN, 2026-07-28. A bare `ACK` from the owner resolved to
 * `needs_disambiguation` across 25 open Odoo tasks, because he genuinely has 25
 * open tasks. Failing closed there is correct — the parser must never guess —
 * but asking a human to choose between 25 items over WhatsApp is not a working
 * loop, it is a broken one that happens to be safe.
 *
 * The fix is not to loosen the parser. It is to notice that "open in Odoo" and
 * "in play in this conversation" are different sets. A bare verb means "the
 * thing we were just talking about", so it resolves against what was actually
 * dispatched. An explicit reference still reaches anything the person holds.
 */
async function filterInPlay(binding: StaffBindingRow, openWork: OpenWorkItem[]): Promise<OpenWorkItem[]> {
  if (openWork.length === 0 || !binding.waId) return []

  const correlationIds = openWork.map((w) => w.correlationId)
  const dispatched = await prisma.notificationOutbox.findMany({
    where: { tenant_id: binding.tenantId, contact: binding.waId, correlation_id: { in: correlationIds } },
    select: { correlation_id: true },
  })
  const dispatchedIds = new Set(dispatched.map((d) => d.correlation_id).filter((c): c is string => !!c))
  if (dispatchedIds.size === 0) return []

  // A completed episode leaves play. ACK and UPDATE do not — a staff member may
  // legitimately send several updates on one task before finishing it.
  const finished = await prisma.staffWorkAction.findMany({
    where: {
      tenant_id: binding.tenantId,
      staff_binding_id: binding.id,
      action: 'done',
      applied_at: { not: null },
      correlation_id: { in: [...dispatchedIds] },
    },
    select: { correlation_id: true },
  })
  const finishedIds = new Set(finished.map((f) => f.correlation_id))

  return openWork.filter((w) => dispatchedIds.has(w.correlationId) && !finishedIds.has(w.correlationId))
}

/**
 * Resolve an inbound staff message to a route. Reads only — applying the action
 * is a separate, explicit call, so a caller can inspect the decision (and a
 * shadow/parity run can compare it) without causing a write.
 */
export async function resolveInboundStaffMessage(input: ResolveInboundInput): Promise<ResolveInboundResult> {
  const candidates = await findBindingsByWaId(input.waId)
  const provisional = decideInboundRoute({
    text: input.text,
    bindingCandidates: candidates,
    channelTenantId: input.channelTenantId,
    openWork: [],
  })

  // Identity failed — no point reading Odoo, and we must not.
  if (provisional.route === 'exception') return { route: provisional, openWork: [] }

  const binding = provisional.binding
  const openWork = await listOpenWorkForStaff(binding)
  const decide = (work: OpenWorkItem[]) =>
    decideInboundRoute({
      text: input.text,
      bindingCandidates: candidates,
      channelTenantId: input.channelTenantId,
      openWork: work,
    })

  // First pass over everything the person holds, so an explicit reference can
  // reach any of their work.
  const route = decide(openWork)

  // Only a bare verb can land here. Narrow to what is actually in play and try
  // once more; if that resolves to exactly one episode, it is what they meant.
  if (route.route === 'staff_disambiguation') {
    const inPlay = await filterInPlay(binding, openWork)
    if (inPlay.length > 0 && inPlay.length < openWork.length) {
      const narrowed = decide(inPlay)
      if (narrowed.route !== 'exception') return { route: narrowed, openWork: inPlay }
    }
  }

  return { route, openWork }
}

export interface ApplyStaffActionInput {
  binding: StaffBindingRow
  action: StaffActionKind
  workRefModel: WorkRefModel
  workRefId: number
  correlationId: string
  note?: string | null
  providerMessageId?: string | null
  source?: string
}

export type ApplyStaffActionResult =
  | { ok: true; deduped: true; actionId: string }
  | { ok: true; deduped: false; actionId: string; odooResult: Record<string, unknown> }
  | {
      ok: false
      reason: string
      actionId?: string
      /**
       * Populated only when a START/RESUME is refused because the actor is not
       * authorised on the record right now. Derived from what Odoo says about
       * the record's current state — never from Foundation-side work state.
       * Used by the WhatsApp reply to tell the sender what they CAN do instead.
       */
      validNextActions?: string[]
    }

/**
 * Apply a staff action to the authoritative Odoo record.
 *
 * Order matters and is defensive at every step:
 *   1. claim the idempotency key FIRST, so a concurrent retry loses the race
 *      rather than double-writing to Odoo;
 *   2. read the record from Odoo and check assignment against what Odoo says
 *      right now, not against anything cached;
 *   3. write chatter — the one durable write every action performs;
 *   4. action-specific extras (stage move, verification request);
 *   5. stamp applied_at only after Odoo accepted.
 *
 * A row with `applied_at` NULL is a request that did NOT complete. It must
 * never be read as done.
 */
export async function applyStaffAction(input: ApplyStaffActionInput): Promise<ApplyStaffActionResult> {
  const idempotencyKey = staffActionIdempotencyKey({
    tenantId: input.binding.tenantId,
    correlationId: input.correlationId,
    action: input.action,
    providerMessageId: input.providerMessageId,
    note: input.note,
  })

  const existing = await prisma.staffWorkAction.findUnique({
    where: { tenant_id_idempotency_key: { tenant_id: input.binding.tenantId, idempotency_key: idempotencyKey } },
    select: { id: true, applied_at: true },
  })
  if (existing?.applied_at) {
    return { ok: true, deduped: true, actionId: existing.id }
  }

  const row =
    existing ??
    (await prisma.staffWorkAction.create({
      data: {
        tenant_id: input.binding.tenantId,
        staff_binding_id: input.binding.id,
        work_ref_model: input.workRefModel,
        work_ref_id: input.workRefId,
        correlation_id: input.correlationId,
        action: input.action,
        note: input.note ?? null,
        source: input.source ?? 'whatsapp',
        actor_wa_id: input.binding.waId,
        idempotency_key: idempotencyKey,
      },
      select: { id: true, applied_at: true },
    }))

  const fail = async (reason: string, validNextActions?: string[]): Promise<ApplyStaffActionResult> => {
    await prisma.staffWorkAction.update({ where: { id: row.id }, data: { failure_reason: reason } })
    await audit({
      tenantId: input.binding.tenantId,
      actorId: `staff:${input.binding.id}`,
      action: 'staff_work_action.failed',
      entity: 'StaffWorkAction',
      entityId: row.id,
      meta: { reason, workRefModel: input.workRefModel, workRefId: input.workRefId, correlationId: input.correlationId },
    })
    return { ok: false, reason, actionId: row.id, ...(validNextActions !== undefined ? { validNextActions } : {}) }
  }

  const config = await resolveOdooConfigForTenant(input.binding.tenantId)
  const record = await readWorkRecord(config, { odooModel: input.workRefModel, odooId: input.workRefId })
  const allowed = checkActorMayAct(record, input.binding.odooResUserId)
  if (!allowed.allowed) {
    // For START/RESUME, include the valid actions Odoo currently allows on this
    // record so the reply can tell the sender what they can actually do.
    const validNextActions = input.action === 'start' && record ? deriveValidNextActions(record) : undefined
    return fail(allowed.reason, validNextActions)
  }

  const chatter = await postStaffActionNote(
    config,
    { odooModel: input.workRefModel, odooId: input.workRefId },
    renderChatterNote({
      action: input.action,
      actorName: input.binding.displayName,
      note: input.note ?? null,
      correlationId: input.correlationId,
      channel: input.source ?? 'whatsapp',
    }),
  )
  if (!chatter.ok) return fail(chatter.reason)

  const odooResult: Record<string, unknown> = { chatter: chatter.detail }

  if (input.action === 'done' && record && record.odooModel === 'project.task') {
    odooResult.verification = await applyDoneVerification(config, record, input)
  }

  if (input.action === 'start' && record && record.odooModel === 'project.task') {
    odooResult.stageMove = await applyStartStageMove(config, record)
  }

  const applied = await prisma.staffWorkAction.update({
    where: { id: row.id },
    data: { applied_at: new Date(), odoo_result: odooResult as never, failure_reason: null },
    select: { id: true },
  })

  await audit({
    tenantId: input.binding.tenantId,
    actorId: `staff:${input.binding.id}`,
    action: `staff_work_action.${input.action}`,
    entity: 'StaffWorkAction',
    entityId: applied.id,
    meta: {
      workRefModel: input.workRefModel,
      workRefId: input.workRefId,
      correlationId: input.correlationId,
      odooResult,
    },
  })

  return { ok: true, deduped: false, actionId: applied.id, odooResult }
}

/**
 * Optionally move the task to the configured start stage.
 *
 * The stage name is read from STAFF_START_STAGE_NAME at runtime.  When the env
 * var is not set, START records its chatter note and does NOT touch the stage;
 * the result carries `moved: false, why: 'STAFF_START_STAGE_NAME_not_configured'`
 * so nobody reads the outcome as more than it was.
 *
 * A failed move does NOT roll back the chatter note: the note is a true fact
 * about what the staff member did, and the failure is reported on `stageMove`
 * rather than escalating to a full action failure.
 */
async function applyStartStageMove(
  config: Awaited<ReturnType<typeof resolveOdooConfigForTenant>>,
  record: OdooWorkRecord,
): Promise<Record<string, unknown>> {
  const stageName = (process.env.STAFF_START_STAGE_NAME ?? '').trim()
  if (!stageName) {
    return { moved: false, why: 'STAFF_START_STAGE_NAME_not_configured' }
  }
  const result = await moveTaskToStage(config, record, stageName)
  return result.ok
    ? { moved: true, ...result.detail }
    : { moved: false, why: result.reason }
}

/**
 * DONE is not automatically final. When the staff member has a manager, a
 * `mail.activity` is created for that manager on the same record, so the
 * verification object is Odoo-native and is itself addressable as a WorkRef.
 * No parallel approval model is introduced.
 */
async function applyDoneVerification(
  config: Awaited<ReturnType<typeof resolveOdooConfigForTenant>>,
  record: OdooWorkRecord,
  input: ApplyStaffActionInput,
): Promise<Record<string, unknown>> {
  if (!input.binding.managerOdooResUserId) {
    return { requested: false, why: 'staff_member_has_no_manager' }
  }
  const activity = await requestManagerVerification(
    config,
    { odooModel: 'project.task', odooId: record.odooId },
    {
      managerOdooResUserId: input.binding.managerOdooResUserId,
      summary: `Verify completion: ${record.name}`.slice(0, 120),
      note: `${input.binding.displayName} reported this DONE via ${input.source ?? 'whatsapp'}.${
        input.note ? ` Note: ${input.note}` : ''
      } Isola correlation: ${input.correlationId}`,
      activityTypeId: verificationActivityTypeId(),
    },
  )
  return activity.ok
    ? { requested: true, activityId: activity.activityId }
    : { requested: false, why: activity.reason }
}

export interface ManagerVerdictInput {
  manager: StaffBindingRow
  activityId: number
  approved: boolean
  feedback?: string | null
  /** The task the activity hangs on, so an approval can also move the stage. */
  taskId?: number | null
  approvedStageName?: string
}

/**
 * Close a verification activity with the manager's outcome. The feedback lands
 * in the record's chatter, so a returned task carries the manager's reason in
 * the system of record rather than only in a Foundation row.
 */
export async function applyManagerVerdict(input: ManagerVerdictInput): Promise<{ ok: boolean; detail: unknown }> {
  const config = await resolveOdooConfigForTenant(input.manager.tenantId)
  const verdict = input.approved ? 'VERIFIED' : 'RETURNED';
  const closed = await completeVerificationActivity(
    config,
    input.activityId,
    `${verdict} by ${input.manager.displayName}.${input.feedback ? ` ${input.feedback}` : ''}`,
  )
  if (!closed.ok) return { ok: false, detail: closed.reason }

  let stage: unknown = { moved: false }
  if (input.approved && input.taskId && input.approvedStageName) {
    const task = await readWorkRecord(config, { odooModel: 'project.task', odooId: input.taskId })
    if (task) stage = await moveTaskToStage(config, task, input.approvedStageName)
  }

  await audit({
    tenantId: input.manager.tenantId,
    actorId: `manager:${input.manager.id}`,
    action: input.approved ? 'staff_verification.approved' : 'staff_verification.returned',
    entity: 'mail.activity',
    entityId: String(input.activityId),
    meta: { taskId: input.taskId ?? null, feedback: input.feedback ?? null, stage },
  })

  return { ok: true, detail: { closed: closed.detail, stage } }
}

export interface DispatchWorkInput {
  binding: StaffBindingRow
  work: OpenWorkItem
  /** Proactive dispatch is always template-first; see staff-notification.ts. */
  proactive?: boolean
  lastInboundAt?: Date | null
  now?: Date
}

/**
 * Enqueue a task dispatch to a staff member through the existing durable
 * outbox. Nothing is sent from here — the drain owns sending, so retries,
 * dedupe and audit are inherited rather than reimplemented.
 */
export async function dispatchWorkToStaff(input: DispatchWorkInput) {
  if (!input.binding.waId) {
    return { enqueued: false as const, reason: 'binding_has_no_whatsapp_identity' }
  }

  const decision = decideDispatchMode({
    proactive: input.proactive !== false,
    window: { lastInboundAt: input.lastInboundAt ?? null, now: input.now ?? new Date() },
  })
  const template = decision.mode === 'template' ? decision.template : INTERNAL_TASK_TEMPLATE

  const envelope = buildStaffNotification({
    tenantId: input.binding.tenantId,
    toWaId: input.binding.waId,
    correlationId: input.work.correlationId,
    workRefModel: input.work.odooModel,
    workRefId: input.work.odooId,
    template,
    templateInput: {
      staffName: input.binding.displayName,
      workTitle: input.work.label ?? '',
      projectName: input.work.projectName,
      dueDate: input.work.dueDate,
    },
    purpose: 'task_dispatch',
  })

  const result = await enqueueNotification({
    tenantId: envelope.tenantId,
    contact: envelope.contact,
    channel: envelope.channel,
    consentBasis: envelope.consentBasis,
    template: envelope.template,
    payload: envelope.payload,
    dedupeKey: envelope.dedupeKey,
  })

  // Stamp the WorkRef correlation onto the outbox row so a wa-status callback
  // can be traced back to the work episode it belongs to.
  if (result.enqueued) {
    await prisma.notificationOutbox.update({
      where: { id: result.id },
      data: {
        work_ref_model: input.work.odooModel,
        work_ref_id: input.work.odooId,
        correlation_id: input.work.correlationId,
      },
    })
  }

  return { ...result, dispatchMode: decision.mode, template }
}

export interface StaffBriefRow {
  staff: string
  odooResUserId: number
  openWork: number
  dispatched: number
  awaitingDelivery: number
  failedDelivery: number
  actionsRecorded: number
}

/**
 * Owner/manager brief projection. Counts only — the detail lives in Odoo and in
 * the audit trail, and duplicating it here would be the first step towards a
 * second task authority.
 */
export async function buildOwnerBrief(tenantId: string): Promise<StaffBriefRow[]> {
  const bindings = await prisma.staffBinding.findMany({
    where: { tenant_id: tenantId, active: true },
    select: BINDING_SELECT,
    orderBy: { odoo_res_user_id: 'asc' },
  })

  const out: StaffBriefRow[] = []
  for (const b of bindings) {
    const binding = toBindingRow(b)
    const [openWork, dispatched, awaiting, failed, actions] = await Promise.all([
      listOpenWorkForStaff(binding).then((w) => w.length).catch(() => 0),
      prisma.notificationOutbox.count({ where: { tenant_id: tenantId, contact: binding.waId ?? '__none__' } }),
      prisma.notificationOutbox.count({
        where: { tenant_id: tenantId, contact: binding.waId ?? '__none__', provider_status: { in: ['accepted', 'sent'] } },
      }),
      prisma.notificationOutbox.count({
        where: { tenant_id: tenantId, contact: binding.waId ?? '__none__', provider_status: 'failed' },
      }),
      prisma.staffWorkAction.count({ where: { tenant_id: tenantId, staff_binding_id: binding.id, applied_at: { not: null } } }),
    ])

    out.push({
      staff: binding.displayName,
      odooResUserId: binding.odooResUserId,
      openWork,
      dispatched,
      // `accepted` and `sent` are NOT delivery. They are the states where we
      // still do not know whether the person has it.
      awaitingDelivery: awaiting,
      failedDelivery: failed,
      actionsRecorded: actions,
    })
  }
  return out
}
