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
import { isOdooBindingRequiredError, resolveOdooConfigForTenant } from '../engine-bindings'
import {
  checkActorMayAct,
  completeVerificationActivity,
  createManagerVerificationActivity,
  deriveValidNextActions,
  findActiveOdooUser,
  findTaskForVerification,
  listOpenTasksForUser,
  moveTaskToConceptStage,
  moveTaskToStage,
  postStaffActionNote,
  readVerificationActivity,
  readWorkRecord,
  renderChatterNote,
  resolveVerificationActivityType,
  resolveVerificationModelId,
  type OdooVerificationActivity,
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
  staffContactE164,
} from './staff-notification'
import { mintCorrelationId, type WorkRefModel } from './work-ref'
import { buildMenu, type ManagerVerdict, type MenuRendering, type StaffMenuAction } from './staff-menu'
import {
  MANAGER_VERIFICATION_OPERATION,
  VERIFICATION_ACTIVITY_TYPE_NAMES,
  VERIFICATION_ACTIVITY_TYPE_XML_ID,
  VERIFICATION_DEADLINE_DAYS_DEFAULT,
  managerVerificationOperationId,
  operationConflict,
  readbackMismatch,
  verificationDeadline,
  verificationNote,
  verificationSummary,
  type VerificationRefusal,
} from './manager-verification'
import {
  enqueueManagerVerificationNotification,
  managerVerificationTemplateSpec,
} from './manager-notification'
import { resolveStaffChannel } from './staff-channel'

/**
 * Optional overrides for manager-verification activity-type resolution.
 *
 * Both are VERIFIED against Odoo before use. The code this replaces returned
 * the literal `4`, which is correct on this tenant and silently wrong on the
 * next one; resolution now happens at runtime and a configured id that does not
 * exist is a refusal, never a guess.
 */
function verificationActivityTypeXmlId(): string {
  return (process.env.STAFF_VERIFICATION_ACTIVITY_TYPE_XMLID ?? '').trim() || VERIFICATION_ACTIVITY_TYPE_XML_ID
}

function configuredVerificationActivityTypeId(): number | null {
  const raw = Number(process.env.STAFF_VERIFICATION_ACTIVITY_TYPE_ID)
  return Number.isInteger(raw) && raw > 0 ? raw : null
}

function verificationDeadlineDays(): number {
  const raw = Number(process.env.STAFF_VERIFICATION_DEADLINE_DAYS)
  return Number.isInteger(raw) && raw > 0 ? raw : VERIFICATION_DEADLINE_DAYS_DEFAULT
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
    where: { tenant_id: binding.tenantId, contact: staffContactE164(binding.waId), correlation_id: { in: correlationIds } },
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

export interface ResolveInboundTapInput {
  waId: string
  action: StaffMenuAction
  correlationId: string
  channelTenantId?: string | null
}

/**
 * Resolve a MENU TAP to a route.
 *
 * A tap carries its own action and its own correlation id, so there is no
 * grammar, no label matching, no disambiguation and no `unknown_reference`
 * caused by a typo — the reference cannot be mistyped because it was never
 * typed.
 *
 * What a tap does NOT skip is the authority check, which is identical to the
 * typed path: the sender must resolve to exactly one active binding, and the
 * episode must be open work Odoo says belongs to that person RIGHT NOW. The id
 * travels out to a handset and back; it is an identifier, not a secret. A tap
 * naming anything else is refused, not trusted.
 *
 * Reads only. Applying the action stays a separate, explicit call — same as
 * `resolveInboundStaffMessage`, so a caller can inspect the decision without
 * causing a write.
 */
export async function resolveInboundStaffTap(input: ResolveInboundTapInput): Promise<ResolveInboundResult> {
  const candidates = await findBindingsByWaId(input.waId)

  // Identity only — the empty text can never match a command, so this call
  // decides nothing except "who is this, and may they act at all".
  const provisional = decideInboundRoute({
    text: '',
    bindingCandidates: candidates,
    channelTenantId: input.channelTenantId,
    openWork: [],
  })

  // Identity failed — no point reading Odoo, and we must not.
  if (provisional.route === 'exception') return { route: provisional, openWork: [] }

  const binding = provisional.binding
  const openWork = await listOpenWorkForStaff(binding)
  const target = openWork.find((w) => w.correlationId === input.correlationId)

  // Fail closed: the tap names an episode this person does not currently hold.
  // Help — with their real open work — is the honest answer; acting would mean
  // trusting an id we did not just verify against Odoo.
  if (!target) {
    return {
      route: { route: 'staff_help', binding, attemptedAction: input.action, why: 'unknown_reference' },
      openWork,
    }
  }

  return {
    route: {
      route: 'staff_action',
      binding,
      action: input.action,
      target,
      note: null,
      resolution: 'explicit_ref',
      grammar: 'tap',
    },
    openWork,
  }
}

/**
 * The menu to attach to a reply, built from what Odoo says about the record
 * NOW.
 *
 * Called AFTER the action has been applied, deliberately. A START moves the
 * record New -> In-Progress, so the actions that come back must be
 * In-Progress's actions. Building the menu from the pre-write record would
 * hand the person a "Start work" button for work they just started — the same
 * class of defect as advertising a command the system does not implement.
 *
 * Best-effort by design: any failure returns `none` and the caller sends plain
 * text. A menu problem must never cost a staff member the confirmation, which
 * is the part that carries the fact.
 */
export async function buildStaffReplyMenu(input: {
  binding: StaffBindingRow
  target: Pick<OpenWorkRefCandidate, 'odooModel' | 'odooId' | 'correlationId'>
}): Promise<MenuRendering> {
  try {
    const config = await resolveOdooConfigForTenant(input.binding.tenantId)
    const record = await readWorkRecord(config, {
      odooModel: input.target.odooModel,
      odooId: input.target.odooId,
    })
    if (!record) return { kind: 'none' }
    return buildMenu(record, input.target.correlationId)
  } catch {
    return { kind: 'none' }
  }
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

  let config
  try {
    config = await resolveOdooConfigForTenant(input.binding.tenantId, { requireBinding: true })
  } catch (err) {
    // Not an outage. Odoo was never contacted and a retry cannot help, so it is
    // recorded as its own failure_reason rather than left to propagate as an
    // unhandled throw out of a webhook handler.
    if (isOdooBindingRequiredError(err)) return fail('tenant_not_bound')
    throw err
  }
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
    odooResult.verification = await applyDoneVerification(config, record, input, row.id)
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
/**
 * Move a task to a CONCEPT, letting an explicitly configured stage name win
 * only where that stage genuinely exists on this task's own board.
 *
 * This is the rule proven live for START on 2026-07-29 (task 2291: the
 * configured `In-Progress` missed on project 53, the concept fallback found
 * `In Development`, and the reply named the stage actually reached). It is a
 * shared function rather than two copies precisely so START and the manager
 * verdict cannot drift apart — the START defect was one code path silently
 * disagreeing with what the reply claimed, and two hand-maintained copies of
 * this logic would reintroduce that by construction.
 *
 * `explicitMiss` is reported, never swallowed: an operator must be able to see
 * that a configured stage name is wrong for a board without reading code.
 */
async function moveToConceptWithExplicit(
  config: Awaited<ReturnType<typeof resolveOdooConfigForTenant>>,
  record: OdooWorkRecord,
  concept: 'new' | 'active' | 'blocked' | 'terminal',
  explicit: string,
): Promise<Record<string, unknown>> {
  if (explicit) {
    const named = await moveTaskToStage(config, record, explicit)
    if (named.ok) return { moved: true, via: 'explicit', ...named.detail }

    // The configured name does not exist on this board. Fall back to the
    // board's own stage for this concept rather than reporting a move that
    // never happened — this is the case that produced the live defect on
    // project 53.
    const byConcept = await moveTaskToConceptStage(config, record, concept)
    return byConcept.ok
      ? { moved: true, via: 'concept', explicitMiss: named.reason, ...byConcept.detail }
      : { moved: false, via: 'concept', why: byConcept.reason, explicitMiss: named.reason }
  }

  const result = await moveTaskToConceptStage(config, record, concept)
  return result.ok
    ? { moved: true, via: 'concept', ...result.detail }
    : { moved: false, via: 'concept', why: result.reason }
}

async function applyStartStageMove(
  config: Awaited<ReturnType<typeof resolveOdooConfigForTenant>>,
  record: OdooWorkRecord,
): Promise<Record<string, unknown>> {
  return moveToConceptWithExplicit(
    config,
    record,
    'active',
    (process.env.STAFF_START_STAGE_NAME ?? '').trim(),
  )
}

/**
 * The action verb for the Foundation-owned verification operation row.
 *
 * It shares the StaffWorkAction ledger deliberately —
 * `dec-foundation-native-manager-verification-activity-2026-07-29` asks for the
 * EXISTING dedup/audit substrate, not a second framework. It is not a verb a
 * staff member can send, and the staff-facing counter in `staffOpsBrief`
 * excludes it, so "actions recorded" still means actions the person took.
 *
 * WHY A FOUNDATION ROW AND NOT THE ODOO ACTIVITY ITSELF: Odoo's
 * `action_feedback` UNLINKS a completed `mail.activity`. Anything that used the
 * activity as its own dedup record would forget the operation the moment the
 * manager answered, and a retry would create a second one. This row survives.
 */
const VERIFY_REQUEST_ACTION = 'verify_request'

interface VerificationRequestFacts {
  operation: string
  operationId: string
  episodeId: string
  tenantId: string
  workRefId: number
  managerOdooResUserId: number
}

type VerificationClaim =
  | { state: 'claimed'; rowId: string }
  | { state: 'completed'; rowId: string; activityId: number }
  | { state: 'in_flight'; rowId: string }
  | { state: 'conflict'; rowId: string; why: string }

/**
 * Claim the operation BEFORE Odoo is touched.
 *
 * `create` is the claim, not `findUnique` then `create`: the unique index on
 * (tenant_id, idempotency_key) is what makes a concurrent retry lose the race
 * in the database rather than in application logic, so at most one caller ever
 * reaches the Odoo create.
 */
async function claimVerificationOperation(params: {
  tenantId: string
  staffBindingId: string
  taskId: number
  correlationId: string
  source: string
  actorWaId: string | null
  operationId: string
  episodeId: string
  managerOdooResUserId: number
}): Promise<VerificationClaim> {
  const request: VerificationRequestFacts = {
    operation: MANAGER_VERIFICATION_OPERATION,
    operationId: params.operationId,
    episodeId: params.episodeId,
    tenantId: params.tenantId,
    workRefId: params.taskId,
    managerOdooResUserId: params.managerOdooResUserId,
  }

  try {
    const created = await prisma.staffWorkAction.create({
      data: {
        tenant_id: params.tenantId,
        staff_binding_id: params.staffBindingId,
        work_ref_model: 'project.task',
        work_ref_id: params.taskId,
        correlation_id: params.correlationId,
        action: VERIFY_REQUEST_ACTION,
        source: params.source,
        actor_wa_id: params.actorWaId,
        idempotency_key: params.operationId,
        odoo_result: { request } as never,
      },
      select: { id: true },
    })
    return { state: 'claimed', rowId: created.id }
  } catch (err) {
    // Only a unique-constraint collision means "already claimed". Anything else
    // is a real failure and must not be dressed up as a duplicate.
    if ((err as { code?: string })?.code !== 'P2002') throw err
  }

  const existing = await prisma.staffWorkAction.findUnique({
    where: {
      tenant_id_idempotency_key: { tenant_id: params.tenantId, idempotency_key: params.operationId },
    },
    select: {
      id: true,
      tenant_id: true,
      work_ref_id: true,
      applied_at: true,
      failure_reason: true,
      odoo_result: true,
    },
  })
  if (!existing) return { state: 'conflict', rowId: '', why: 'claim_vanished' }

  const stored = (existing.odoo_result ?? null) as {
    request?: Partial<VerificationRequestFacts>
    activity?: { activityId?: number }
  } | null

  const conflict = operationConflict(
    {
      tenantId: existing.tenant_id,
      workRefId: existing.work_ref_id,
      managerOdooResUserId: stored?.request?.managerOdooResUserId,
      episodeId: stored?.request?.episodeId,
    },
    {
      tenantId: params.tenantId,
      workRefId: params.taskId,
      managerOdooResUserId: params.managerOdooResUserId,
      episodeId: params.episodeId,
    },
  )
  if (conflict) return { state: 'conflict', rowId: existing.id, why: conflict }

  if (existing.applied_at) {
    const activityId = Number(stored?.activity?.activityId ?? 0)
    if (Number.isInteger(activityId) && activityId > 0) {
      return { state: 'completed', rowId: existing.id, activityId }
    }
    return { state: 'conflict', rowId: existing.id, why: 'completed_without_activity_id' }
  }

  // Not applied. A RECORDED failure means the previous attempt stopped at or
  // before creation and is safe to retry on the same row — the same
  // claim/recovery rule `applyStaffAction` already uses. No recorded failure
  // means an attempt is genuinely in flight, and creating a second activity is
  // exactly the duplicate this mechanism exists to prevent.
  if (existing.failure_reason) return { state: 'claimed', rowId: existing.id }
  return { state: 'in_flight', rowId: existing.id }
}

/**
 * DONE is not automatically final. When the staff member has a manager,
 * Foundation creates a `mail.activity` for that manager on the same record, so
 * the verification object is Odoo-native and is itself addressable as a
 * WorkRef. No parallel approval model is introduced.
 *
 * THE FIX THIS FUNCTION CARRIES —
 * `def-spine-manager-verification-activity-never-created-2026-07-29`. The old
 * body called straight through to a create that wrote the STRING `res_model`.
 * That field is readonly on this Odoo, so the record link never formed and
 * every create was refused. It had never worked; it was invisible only because
 * the sole person who had ever pressed DONE was the owner, who has no manager,
 * so the short-circuit above fired first and the create was never reached.
 *
 * The sequence is now: claim the operation → resolve every id from Odoo →
 * prove the target and the assignee exist → create → read back → only then
 * report `requested: true`. Every refusal is recorded and returned truthfully,
 * and no refusal ever produces a manager notice, because a notice about a
 * verification that does not exist is worse than silence.
 */
async function applyDoneVerification(
  config: Awaited<ReturnType<typeof resolveOdooConfigForTenant>>,
  record: OdooWorkRecord,
  input: ApplyStaffActionInput,
  episodeId: string,
): Promise<Record<string, unknown>> {
  const managerOdooResUserId = input.binding.managerOdooResUserId
  if (!managerOdooResUserId) {
    return { requested: false, why: 'staff_member_has_no_manager' }
  }

  const operationId = managerVerificationOperationId({
    tenantId: input.binding.tenantId,
    workRefModel: 'project.task',
    workRefId: record.odooId,
    episodeId,
    managerOdooResUserId,
  })

  try {
    const claim = await claimVerificationOperation({
      tenantId: input.binding.tenantId,
      staffBindingId: input.binding.id,
      taskId: record.odooId,
      correlationId: input.correlationId,
      source: input.source ?? 'whatsapp',
      actorWaId: input.binding.waId,
      operationId,
      episodeId,
      managerOdooResUserId,
    })

    if (claim.state === 'conflict') {
      return { requested: false, why: 'operation_id_conflict', detail: claim.why, operationId }
    }
    if (claim.state === 'in_flight') {
      return { requested: false, why: 'verification_in_flight', operationId }
    }
    if (claim.state === 'completed') {
      // This episode already has its activity. Truthful about the activity, and
      // `deduped` is what stops the caller telling the manager a second time.
      return { requested: true, deduped: true, activityId: claim.activityId, operationId }
    }

    const rowId = claim.rowId
    const refuse = async (why: VerificationRefusal, detail?: unknown): Promise<Record<string, unknown>> => {
      await prisma.staffWorkAction.update({ where: { id: rowId }, data: { failure_reason: why } })
      await audit({
        tenantId: input.binding.tenantId,
        actorId: `staff:${input.binding.id}`,
        action: 'staff_verification.refused',
        entity: 'StaffWorkAction',
        entityId: rowId,
        meta: {
          why,
          detail: detail ?? null,
          operationId,
          episodeId,
          taskId: record.odooId,
          managerOdooResUserId,
        },
      })
      return {
        requested: false,
        why,
        ...(detail !== undefined ? { detail } : {}),
        operationId,
      }
    }

    // 1. res_model_id — resolved and allowlisted. Never a text model name, and
    //    never an id supplied by anything outside this process.
    const resModelId = await resolveVerificationModelId(config, 'project.task')
    if (!resModelId) return refuse('model_not_resolvable_in_odoo')

    // 2. The target really exists, and is the record this DONE is about. The
    //    existence check is a filtering search_read — a by-id read echoes back
    //    ids that do not exist (see findTaskForVerification).
    const task = await findTaskForVerification(config, record.odooId)
    if (!task) return refuse('task_not_found')
    if (record.projectId != null && task.projectId !== record.projectId) {
      return refuse('task_is_not_the_current_work_ref', {
        taskProjectId: task.projectId,
        workRefProjectId: record.projectId,
      })
    }
    if (!task.assigneeUserIds.includes(input.binding.odooResUserId)) {
      return refuse('task_not_assigned_to_staff_member', { assignees: task.assigneeUserIds })
    }

    // 3. The manager. Foundation's own tenant-scoped binding first, so a user id
    //    belonging to another tenant's Odoo can never be assigned to; then Odoo,
    //    because a binding can outlive the account it points at.
    const managerBinding = await findBindingByOdooUser(input.binding.tenantId, managerOdooResUserId)
    if (!managerBinding || !managerBinding.active) return refuse('manager_not_bound_in_this_tenant')
    const managerUser = await findActiveOdooUser(config, managerOdooResUserId)
    if (!managerUser) return refuse('manager_not_active_in_odoo')

    // 4. The activity type, resolved at runtime rather than hardcoded.
    const activityType = await resolveVerificationActivityType(config, {
      xmlId: verificationActivityTypeXmlId(),
      configuredId: configuredVerificationActivityTypeId(),
      names: VERIFICATION_ACTIVITY_TYPE_NAMES,
    })
    if (!activityType) return refuse('activity_type_not_resolvable')

    // 5. Create. The deadline is computed ONCE: the manager's notice quotes
    //    the same review-by date the activity carries, and a midnight
    //    rollover between two calls must not make them disagree.
    const verificationDueBy = verificationDeadline(new Date(), verificationDeadlineDays())
    const created = await createManagerVerificationActivity(config, {
      resModel: 'project.task',
      resModelId,
      resId: task.taskId,
      activityTypeId: activityType.activityTypeId,
      managerOdooResUserId,
      summary: verificationSummary(task.name || record.name),
      note: verificationNote({
        staffName: input.binding.displayName,
        source: input.source ?? 'whatsapp',
        note: input.note ?? null,
        correlationId: input.correlationId,
        operationId,
      }),
      dateDeadline: verificationDueBy,
    })
    if (!created.ok) {
      const why: VerificationRefusal =
        created.reason === 'activity_readback_failed' ? 'activity_readback_failed' : 'activity_create_failed'
      return refuse(why, { reason: created.reason, orphanActivityId: created.activityId ?? null })
    }

    // 6. The readback must agree with what was asked for.
    const mismatch = readbackMismatch(
      {
        resModel: 'project.task',
        resModelId,
        resId: task.taskId,
        userId: managerOdooResUserId,
        activityTypeId: activityType.activityTypeId,
      },
      created.activity,
    )
    if (mismatch) {
      return refuse('activity_readback_mismatch', {
        mismatch,
        orphanActivityId: created.activity.activityId,
      })
    }

    const activity = {
      activityId: created.activity.activityId,
      resModel: created.activity.resModel,
      resModelId: created.activity.resModelId,
      resId: created.activity.resId,
      userId: created.activity.userId,
      activityTypeId: created.activity.activityTypeId,
      activityTypeVia: activityType.via,
      managerBindingId: managerBinding.id,
    }

    await prisma.staffWorkAction.update({
      where: { id: rowId },
      data: {
        applied_at: new Date(),
        failure_reason: null,
        odoo_result: {
          request: {
            operation: MANAGER_VERIFICATION_OPERATION,
            operationId,
            episodeId,
            tenantId: input.binding.tenantId,
            workRefId: record.odooId,
            managerOdooResUserId,
          },
          activity,
        } as never,
      },
    })

    await audit({
      tenantId: input.binding.tenantId,
      actorId: `staff:${input.binding.id}`,
      action: 'staff_verification.requested',
      entity: 'mail.activity',
      entityId: String(activity.activityId),
      meta: { operationId, episodeId, taskId: record.odooId, correlationId: input.correlationId, activity },
    })

    // THE MISSING STEP. Everything above proves the activity exists in Odoo
    // and matches what was asked for; only now may the manager be told. This is
    // the last thing in the function deliberately - a notification is the one
    // side effect that reaches a human, so it goes after every refusal.
    //
    // Its result is REPORTED, never thrown: the verification itself succeeded
    // and that fact must not be rewritten by a notification problem. An
    // unapproved template or an unconfigured staff channel therefore shows up
    // as `notified: false` with a reason, and the activity still stands.
    const notification = await enqueueManagerVerificationNotification(
      {
        tenantId: input.binding.tenantId,
        activityId: activity.activityId,
        operationId,
        episodeId,
        correlationId: input.correlationId,
        workRefModel: 'project.task',
        workRefId: task.taskId,
        workTitle: task.name || record.name,
        projectName: record.projectName,
        staffDisplayName: input.binding.displayName,
        reportedResult: input.note ?? null,
        dueByWording: verificationDueBy,
        manager: {
          id: managerBinding.id,
          waId: managerBinding.waId,
          odooResUserId: managerOdooResUserId,
          active: managerBinding.active,
          displayName: managerBinding.displayName,
        },
      },
      {
        resolveStaffChannel,
        enqueue: enqueueNotification,
        findByDedupeKey: async (tenantId, dedupeKey) => {
          const row = await prisma.notificationOutbox.findUnique({
            where: { tenant_id_dedupe_key: { tenant_id: tenantId, dedupe_key: dedupeKey } },
            select: { id: true, payload: true },
          })
          return row ? { id: row.id, payload: row.payload } : null
        },
        templateSpec: managerVerificationTemplateSpec(),
        env: process.env,
      },
    )

    await audit({
      tenantId: input.binding.tenantId,
      actorId: `staff:${input.binding.id}`,
      action: notification.notified
        ? 'staff_verification.manager_notified'
        : 'staff_verification.manager_not_notified',
      entity: 'mail.activity',
      entityId: String(activity.activityId),
      meta: { operationId, episodeId, notification },
    })

    return {
      requested: true,
      activityId: activity.activityId,
      operationId,
      episodeId,
      resModelId,
      resId: task.taskId,
      managerOdooResUserId,
      activityTypeId: activity.activityTypeId,
      activityTypeVia: activityType.via,
      notification,
    }
  } catch (err) {
    // Nothing proven, so nothing claimed. The DONE's chatter note still stands —
    // it is a true fact about what the staff member did — and the failure is
    // reported here rather than escalating the whole action to a failure.
    return {
      requested: false,
      why: 'verification_failed',
      detail: err instanceof Error ? err.message : String(err),
      operationId,
    }
  }
}

export interface ManagerVerdictInput {
  manager: StaffBindingRow
  activityId: number
  approved: boolean
  feedback?: string | null
  /** The task the activity hangs on, so a verdict can also move the stage. */
  taskId?: number | null
  /** Explicit stage for APPROVE. Honoured only where it exists on the board. */
  approvedStageName?: string
  /** Explicit stage for RETURN. Honoured only where it exists on the board. */
  returnStageName?: string
}

/**
 * Close a verification activity with the manager's outcome. The feedback lands
 * in the record's chatter, so a returned task carries the manager's reason in
 * the system of record rather than only in a Foundation row.
 */
export async function applyManagerVerdict(input: ManagerVerdictInput): Promise<{ ok: boolean; detail: unknown }> {
  let config
  try {
    config = await resolveOdooConfigForTenant(input.manager.tenantId, { requireBinding: true })
  } catch (err) {
    if (isOdooBindingRequiredError(err)) return { ok: false, detail: 'tenant_not_bound' }
    throw err
  }
  const verdict = input.approved ? 'VERIFIED' : 'RETURNED';
  const closed = await completeVerificationActivity(
    config,
    input.activityId,
    `${verdict} by ${input.manager.displayName}.${input.feedback ? ` ${input.feedback}` : ''}`,
  )
  if (!closed.ok) return { ok: false, detail: closed.reason }

  // STAGE HANDLING — the START lesson, applied.
  //
  // This previously called `moveTaskToStage` with a single global name, which
  // matches an EXACT name inside the task's own project. That is the identical
  // construct behind
  // `def-spine-start-reports-started-without-odoo-stage-move-2026-07-29`: on
  // project 53 (`In Development` / `Under Investigation`) no global "approved"
  // name exists, so the move silently did nothing while the manager was told
  // the work had been approved. It also only ran for APPROVE, so a RETURN never
  // moved anything at all.
  //
  // Approve resolves the board's TERMINAL concept, Return resolves its ACTIVE
  // one, and an explicit configured name wins only where it truly exists.
  let stage: Record<string, unknown> = { moved: false, why: 'no_task_reference' }
  let stageNameAfter: string | null = null
  let readbackOk = true

  if (input.taskId) {
    const task = await readWorkRecord(config, { odooModel: 'project.task', odooId: input.taskId })
    if (!task) {
      stage = { moved: false, why: 'task_not_found' }
      readbackOk = false
    } else {
      const explicit = (
        (input.approved
          ? (input.approvedStageName ?? process.env.STAFF_APPROVED_STAGE_NAME)
          : (input.returnStageName ?? process.env.STAFF_RETURN_STAGE_NAME)) ?? ''
      ).trim()
      stage = await moveToConceptWithExplicit(
        config,
        task,
        input.approved ? 'terminal' : 'active',
        explicit,
      )

      // POST-WRITE READBACK. The reply must name the stage Odoo actually holds
      // now, not the one we asked for. A move that reports `moved: true` but
      // reads back unchanged is exactly the class of lie this packet exists to
      // prevent, so the caller gets the observed value and an explicit flag
      // when the readback itself failed.
      const after = await readWorkRecord(config, { odooModel: 'project.task', odooId: input.taskId })
      if (after) stageNameAfter = after.stageName
      else readbackOk = false
    }
  }
  stage.stageNameAfter = stageNameAfter
  stage.readbackOk = readbackOk

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

/**
 * Resolve a MANAGER's Approve / Return tap to an authorised verdict, or refuse.
 *
 * The mirror of `resolveInboundStaffTap`, and fail-closed for the same reason:
 * the payload rode out to a handset and came back, so it is an identifier and
 * never a permission. Every fact it asserts is re-established from Odoo before
 * anything is written.
 *
 * The checks, in order, and why each one is here rather than assumed:
 *
 *  1. IDENTITY, via the same `decideInboundRoute` the staff path uses. A number
 *     bound in two tenants is refused as cross-tenant, and an inactive binding
 *     is refused — neither is folded into "unknown sender".
 *  2. ROLE. Only `manager` or `owner` may render a verdict. The internal API
 *     already enforces this; the WhatsApp path must not be the softer door.
 *  3. THE ACTIVITY EXISTS AND IS OPEN. Read from the Odoo config resolved from
 *     the BINDING's tenant — never a tenant supplied by the caller.
 *  4. THE ACTIVITY IS THIS MANAGER'S. `user_id` must match. A frozen button
 *     outlives its episode and can be forwarded; another manager's activity id
 *     must bounce.
 *  5. THE ACTIVITY HANGS ON A TASK. Without `res_model` / `res_id` a verdict
 *     could move a record the manager was never shown.
 *
 * No step trusts the button label, the phone number alone, or any task id the
 * client supplied — the task comes from the activity, not from the payload.
 */
export type ManagerTapRefusal =
  | 'identity'
  | 'not_a_manager'
  | 'activity_not_open'
  | 'not_this_manager'
  | 'wrong_object'

export type ResolveManagerTapResult =
  | { ok: true; binding: StaffBindingRow; activity: OdooVerificationActivity; taskId: number }
  | { ok: false; refusal: ManagerTapRefusal; why?: string; binding?: StaffBindingRow }

export async function resolveInboundManagerTap(input: {
  waId: string
  verdict: ManagerVerdict
  activityId: number
  channelTenantId: string | null
}): Promise<ResolveManagerTapResult> {
  const candidates = await findBindingsByWaId(input.waId)

  // Identity only — the empty text can never match a command, so this decides
  // nothing except "who is this, and may they act at all".
  const provisional = decideInboundRoute({
    text: '',
    bindingCandidates: candidates,
    channelTenantId: input.channelTenantId,
    openWork: [],
  })
  if (provisional.route === 'exception') {
    // Identity failed — no Odoo read, and we must not.
    return { ok: false, refusal: 'identity', why: provisional.why }
  }

  const binding = provisional.binding
  if (binding.role !== 'manager' && binding.role !== 'owner') {
    return { ok: false, refusal: 'not_a_manager', why: binding.role, binding }
  }

  const config = await resolveOdooConfigForTenant(binding.tenantId)
  const activity = await readVerificationActivity(config, input.activityId)
  if (!activity) {
    // Gone or already resolved — indistinguishable here, and both refuse.
    return { ok: false, refusal: 'activity_not_open', binding }
  }
  if (activity.userId !== binding.odooResUserId) {
    return { ok: false, refusal: 'not_this_manager', binding }
  }
  if (activity.resModel !== 'project.task' || !activity.resId) {
    return { ok: false, refusal: 'wrong_object', why: activity.resModel, binding }
  }

  return { ok: true, binding, activity, taskId: activity.resId }
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

  // The WorkRef correlation goes in the SAME insert as the row.
  //
  // It used to be stamped by a second update immediately after the enqueue.
  // `work_ref_model` is what `isStaffNotification()` keys on, and therefore what
  // arms the staff-channel rule in the drain - and `enqueueNotification` sets
  // `next_attempt_at` to `new Date()`, so the drain can claim the row BETWEEN the
  // two writes. In that window the row is not recognised as staff,
  // `forbidDefaultNumber` is false, and the send falls back to the tenant's
  // earliest-created number, which on the EPIC tenant is the CUSTOMER 6737 line.
  // A crash between the writes made that permanent. One insert closes the window
  // instead of narrowing it.
  const result = await enqueueNotification({
    tenantId: envelope.tenantId,
    contact: envelope.contact,
    channel: envelope.channel,
    consentBasis: envelope.consentBasis,
    template: envelope.template,
    payload: envelope.payload,
    dedupeKey: envelope.dedupeKey,
    workRefModel: input.work.odooModel,
    workRefId: input.work.odooId,
    correlationId: input.work.correlationId,
  })

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
    // Same canonical key the dispatch writes with — see staffContactE164.
    const contactKey = binding.waId ? staffContactE164(binding.waId) : '__none__'
    const [openWork, dispatched, awaiting, failed, actions] = await Promise.all([
      listOpenWorkForStaff(binding).then((w) => w.length).catch(() => 0),
      prisma.notificationOutbox.count({ where: { tenant_id: tenantId, contact: contactKey } }),
      prisma.notificationOutbox.count({
        where: { tenant_id: tenantId, contact: contactKey, provider_status: { in: ['accepted', 'sent'] } },
      }),
      prisma.notificationOutbox.count({
        where: { tenant_id: tenantId, contact: contactKey, provider_status: 'failed' },
      }),
      prisma.staffWorkAction.count({
        where: {
          tenant_id: tenantId,
          staff_binding_id: binding.id,
          applied_at: { not: null },
          // Foundation-owned operations share this ledger but are not actions
          // the staff member took, so they must not inflate their count.
          action: { not: VERIFY_REQUEST_ACTION },
        },
      }),
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
