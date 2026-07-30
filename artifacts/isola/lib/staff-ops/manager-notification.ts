/**
 * manager-notification.ts - tell the MANAGER that a verification is waiting.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `applyDoneVerification` (lib/staff-ops/service.ts) creates the Odoo
 * `mail.activity`, reads it back, proves the readback agrees and returns
 * `requested: true`. And then nothing happens. `enqueueNotification` had exactly
 * two production callers - the voicemail poller and task dispatch - so the
 * manager was never told. `manager_verification` already existed as purpose
 * vocabulary and as a dedupe-key case; no code path ever reached it. Missing
 * implementation, not a provider failure.
 *
 * A verification nobody is told about is indistinguishable from no verification
 * at all, which is why this is a release blocker rather than a nicety.
 *
 * ── Why the notification cannot precede the readback ────────────────────────
 *
 * The inputs here are the PROVEN activity: an activity id that came back from
 * Odoo and matched what was asked for. This function is deliberately unable to
 * run earlier, because every field it needs is a readback output. Telling a
 * manager to go and verify something that does not exist in Odoo would send them
 * to an empty record - worse than silence, and the specific mistake
 * `def-spine-manager-verification-activity-never-created-2026-07-29` produced for
 * a day.
 *
 * ── Why the message is specified but NOT sendable yet ───────────────────────
 *
 * Two hard constraints, both verified in this repository rather than assumed:
 *
 *   1. A manager verdict can ONLY arrive as a BUTTON TAP.
 *      `decodeManagerVerdictId` (`mv:<verdict>:<activityId>`) is called from one
 *      place, app/api/webhooks/whatsapp/route.ts, on a tap id. `parseStaffCommand`
 *      has verbs ACK / START / BLOCKED / DONE / UPDATE / MY TASKS / HELP and no
 *      approve or return verb at all. So there is no text command for a verdict,
 *      and a message must not advertise one.
 *
 *   2. The outbox can only send TEMPLATES. `sendWhatsApp` calls `sendTemplate`;
 *      there is no interactive-message path through `NotificationOutbox`.
 *
 * Together those rule out the tempting options. Reusing `epic_internal_task_v1`
 * would advertise ACK / START / DONE to a MANAGER - staff commands, which would
 * apply a staff action to the task instead of recording a verdict. A free-form
 * interactive button message is processable inbound but not sendable outbound
 * through this queue. So the only honest option left is the third one: define the
 * template contract, commit it, send nothing, and name Meta approval as the
 * blocker.
 *
 * `MANAGER_VERIFICATION_TEMPLATE_SPEC.approved` is `false` and this module
 * REFUSES to enqueue while it is. That is not a stub - the enqueue path below is
 * complete and tested on both sides of the flag, so approving the template at
 * Meta and flipping one value is the whole remaining change.
 */

import {
  encodeManagerVerdictTemplatePayload,
  managerVerdictLabel,
  type ManagerVerdict,
} from './manager-verdict'
import { flattenForTemplate } from './staff-notification'
import { resolveStaffChannel, type StaffChannelResolution } from './staff-channel'

/** Purpose vocabulary. Already present in `staffNotificationDedupeKey`. */
export const MANAGER_VERIFICATION_PURPOSE = 'manager_verification' as const

export const MANAGER_VERIFICATION_TEMPLATE = 'epic_manager_verification_v1'
export const MANAGER_VERIFICATION_TEMPLATE_PARAM_COUNT = 5

/**
 * The template contract, as it must be submitted to Meta.
 *
 * Committed, reviewable and diffable BEFORE it exists at Meta, so the thing we
 * asked to be approved and the thing the code sends cannot drift. The two
 * QUICK_REPLY buttons are the whole point: their payloads are
 * `mv:approve:<activityId>` and `mv:return:<activityId>`, which is exactly what
 * `decodeManagerVerdictId` already parses. Nothing new is invented inbound.
 *
 * `approved` is the load-bearing field. While it is false, `buildManagerVerificationMessage`
 * reports the message as not sendable and the enqueue refuses.
 */
export const MANAGER_VERIFICATION_TEMPLATE_SPEC = {
  name: MANAGER_VERIFICATION_TEMPLATE,
  language: 'en_US',
  category: 'UTILITY',
  parameter_format: 'POSITIONAL',
  /**
   * {{1}} task reference, e.g. #2590   {{2}} staff member
   * {{3}} reported result              {{4}} project / board
   * {{5}} due-by wording
   *
   * Deliberately makes no claim that a decision has been made, and names no
   * text command - the buttons are the only advertised interaction.
   */
  body:
    'Verification needed for EPIC Task {{1}}\n\n' +
    'Completed by: {{2}}\n' +
    'Reported result: {{3}}\n' +
    'Project: {{4}}\n' +
    'Please review by: {{5}}\n\n' +
    'Use the buttons below to approve, or to return it for rework with a reason.',
  buttons: [
    { type: 'QUICK_REPLY', text: managerVerdictLabel('approve') },
    { type: 'QUICK_REPLY', text: managerVerdictLabel('return') },
  ],
  /** FALSE until Meta approves it. Nothing is sent while this is false. */
  approved: false,
} as const

/**
 * Operators confirm the Meta approval here, not by editing a constant.
 *
 * Strict equality with the string `true`, following `isAiLoopEnabled` - a stray
 * `1`, `yes` or `TRUE` must not start messaging managers. Once Meta approves
 * `epic_manager_verification_v1`, setting this is the entire remaining change:
 * no code edit, no redeploy of a literal.
 */
export const MANAGER_VERIFICATION_TEMPLATE_APPROVED_ENV =
  'STAFF_MANAGER_VERIFICATION_TEMPLATE_APPROVED'

export function managerVerificationTemplateSpec(
  env: NodeJS.ProcessEnv = process.env,
): { approved: boolean } {
  if (MANAGER_VERIFICATION_TEMPLATE_SPEC.approved) return { approved: true }
  return { approved: env[MANAGER_VERIFICATION_TEMPLATE_APPROVED_ENV] === 'true' }
}

export type ManagerNotificationRefusal =
  /** The activity was not proven - no id, no operation, no episode. */
  | 'activity_not_proven'
  | 'manager_binding_missing'
  | 'manager_binding_inactive'
  | 'manager_destination_missing'
  | 'staff_channel_not_configured'
  | 'template_not_approved'
  | 'dedupe_payload_conflict'
  | 'consent_denied'
  | 'duplicate'

export interface ManagerVerificationNotificationInput {
  tenantId: string
  /** Proven from the Odoo readback, not from the request. */
  activityId: number
  /** Foundation's operation id for this verification. Carries the identity. */
  operationId: string
  /** The StaffWorkAction row id of the staff DONE - the verification episode. */
  episodeId: string
  correlationId: string
  workRefModel: string
  workRefId: number
  workTitle: string
  projectName: string | null
  /** Who did the work. From the staff binding, never from a message. */
  staffDisplayName: string
  /** What the staff member reported. Display copy; never an authority. */
  reportedResult: string | null
  dueByWording: string | null
  /** The AUTHORITATIVE manager binding. Never derived from model output. */
  manager: {
    id: string
    waId: string | null
    odooResUserId: number
    active: boolean
    displayName: string
  }
}

export type ManagerMessageContract = {
  template: string
  params: string[]
  /** Tap payloads the inbound path already decodes. */
  buttonPayloads: Record<ManagerVerdict, string>
  /** False while the template is unapproved at Meta. */
  sendable: boolean
  why: string | null
}

/**
 * The dedupe identity.
 *
 * Derived ENTIRELY from `managerVerificationOperationId`, which already encodes
 * tenant, `project.task#<id>`, `ep:<episodeId>`, `mgr:<resUserId>` and the
 * operation name. Deriving a second identity here would create two things that
 * both claim to say when two notifications are the same, and the first time they
 * disagreed a manager would get two messages or none.
 *
 * Under `NotificationOutbox @@unique([tenant_id, dedupe_key])` this gives:
 *   - the same episode retried  -> same key -> P2002 -> reported duplicate;
 *   - a NEW episode on the same task -> different `ep:` -> independently
 *     deliverable, which is required: a returned task legitimately gets
 *     verified again.
 */
export function managerVerificationDedupeKey(operationId: string): string {
  return `staff:${MANAGER_VERIFICATION_PURPOSE}:${operationId}`
}

/**
 * Build the manager's message.
 *
 * Every parameter is flattened - Meta rejects a body parameter containing a
 * newline, a tab or four consecutive spaces, and both the task title and the
 * staff member's reported result are free text a human typed on a phone.
 */
export function buildManagerVerificationMessage(
  input: Pick<
    ManagerVerificationNotificationInput,
    'activityId' | 'workRefId' | 'workTitle' | 'projectName' | 'staffDisplayName' | 'reportedResult' | 'dueByWording'
  >,
  spec: { approved: boolean } = MANAGER_VERIFICATION_TEMPLATE_SPEC,
): ManagerMessageContract {
  const params = [
    `#${input.workRefId}`,
    flattenForTemplate(input.staffDisplayName, 'A team member'),
    flattenForTemplate(input.reportedResult, 'Marked complete with no note'),
    flattenForTemplate(input.projectName, 'General'),
    flattenForTemplate(input.dueByWording, 'As soon as possible'),
  ]
  if (params.length !== MANAGER_VERIFICATION_TEMPLATE_PARAM_COUNT) {
    throw new Error(
      `manager verification template expects ${MANAGER_VERIFICATION_TEMPLATE_PARAM_COUNT} params, built ${params.length}`,
    )
  }
  return {
    template: MANAGER_VERIFICATION_TEMPLATE,
    params,
    buttonPayloads: {
      approve: encodeManagerVerdictTemplatePayload('approve', input.activityId),
      return: encodeManagerVerdictTemplatePayload('return', input.activityId),
    },
    sendable: spec.approved === true,
    why: spec.approved === true ? null : `${MANAGER_VERIFICATION_TEMPLATE} is not approved at Meta`,
  }
}

export interface EnqueueOutcome {
  enqueued: boolean
  id?: string
  reason?: string
}

export interface ManagerNotificationDeps {
  resolveStaffChannel: (env?: NodeJS.ProcessEnv) => StaffChannelResolution
  /**
   * The existing durable outbox. `workRefModel`/`workRefId`/`correlationId` are
   * passed INTO the insert rather than stamped afterwards - see the note in the
   * enqueue below.
   */
  enqueue: (params: {
    tenantId: string
    contact: string
    channel: string
    consentBasis: string
    template: string
    payload: Record<string, unknown>
    dedupeKey: string
    workRefModel?: string | null
    workRefId?: number | null
    correlationId?: string | null
  }) => Promise<EnqueueOutcome>
  /** Existing row for this key, so a payload conflict is refused not ignored. */
  findByDedupeKey: (
    tenantId: string,
    dedupeKey: string,
  ) => Promise<{ id: string; payload: unknown } | null>
  /** The template's approval state. Injected so both branches are testable. */
  templateSpec: { approved: boolean }
  env: NodeJS.ProcessEnv
}

export type ManagerNotificationResult =
  | {
      notified: true
      outboxId: string
      dedupeKey: string
      activityId: number
      template: string
      contact: string
    }
  | {
      notified: false
      why: ManagerNotificationRefusal
      detail?: string
      dedupeKey?: string
    }

/** Bare wa_id to the `+E.164` key the outbox and Consent both use. */
export function managerContactE164(waId: string): string {
  return `+${waId.replace(/\D/g, '')}`
}

/**
 * The payload identity that must not change under a reused dedupe key.
 *
 * Only the fields that decide WHAT the manager is told and WHICH object they
 * would act on. `reportedResult` is display copy and is deliberately excluded -
 * a retry that re-reads a slightly reworded note is still the same
 * notification, and failing it would strand a legitimate retry.
 */
export function notificationIdentity(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null | undefined
  if (!p || typeof p !== 'object') return null
  return [
    String(p.operationId ?? ''),
    String(p.episodeId ?? ''),
    String(p.activityId ?? ''),
    String(p.managerOdooResUserId ?? ''),
    String(p.workRefModel ?? ''),
    String(p.workRefId ?? ''),
  ].join('|')
}

/**
 * Enqueue exactly one manager-verification notification for a PROVEN activity.
 *
 * Resolves - never throws for an expected condition. Ordered so that everything
 * refusable is refused before the outbox is touched: a refusal must leave no row
 * behind, because a queued row for a notification we then decided not to send is
 * a row the drain will try to send anyway.
 */
export async function enqueueManagerVerificationNotification(
  input: ManagerVerificationNotificationInput,
  deps: ManagerNotificationDeps,
): Promise<ManagerNotificationResult> {
  // 1. The activity must be proven. These three come from the readback path and
  //    nowhere else, so their absence means this was called too early.
  if (!Number.isInteger(input.activityId) || input.activityId <= 0) {
    return { notified: false, why: 'activity_not_proven', detail: 'activityId is not a positive integer' }
  }
  if (!(input.operationId ?? '').trim()) {
    return { notified: false, why: 'activity_not_proven', detail: 'operationId is required' }
  }
  if (!(input.episodeId ?? '').trim()) {
    return { notified: false, why: 'activity_not_proven', detail: 'episodeId is required' }
  }

  // 2. The manager, from the authoritative binding.
  if (!input.manager || !input.manager.id) {
    return { notified: false, why: 'manager_binding_missing' }
  }
  if (!input.manager.active) {
    return { notified: false, why: 'manager_binding_inactive' }
  }
  const waId = (input.manager.waId ?? '').replace(/\D/g, '')
  if (!waId) {
    return { notified: false, why: 'manager_destination_missing' }
  }
  const contact = managerContactE164(waId)

  // 3. The staff channel, BEFORE the outbox is touched. §6: a missing
  //    configuration fails closed before enqueue or provider invocation, and the
  //    reason names the configuration gap without printing its value.
  const channel = deps.resolveStaffChannel(deps.env)
  if (!channel.ok) {
    return { notified: false, why: 'staff_channel_not_configured', detail: channel.reason }
  }

  const dedupeKey = managerVerificationDedupeKey(input.operationId)

  // 4. The message. Refused while the template is unapproved - and refused
  //    BEFORE enqueue, so we never queue something Meta would reject.
  const message = buildManagerVerificationMessage(input, deps.templateSpec)
  if (!message.sendable) {
    return {
      notified: false,
      why: 'template_not_approved',
      detail: message.why ?? 'template not approved',
      dedupeKey,
    }
  }

  const payload: Record<string, unknown> = {
    purpose: MANAGER_VERIFICATION_PURPOSE,
    operationId: input.operationId,
    episodeId: input.episodeId,
    correlationId: input.correlationId,
    activityId: input.activityId,
    managerBindingId: input.manager.id,
    managerOdooResUserId: input.manager.odooResUserId,
    workRefModel: input.workRefModel,
    workRefId: input.workRefId,
    templateParams: message.params,
    buttonPayloads: message.buttonPayloads,
    // The SAME payloads, ordered to the approved template's button order:
    // index 0 = "Approve", index 1 = "Return for rework". `buttonPayloads` is
    // the readable map for operators; this is the array the send adapter needs,
    // because Meta indexes button components positionally and rejects the whole
    // send if an index has no matching approved button.
    quickReplyPayloads: [message.buttonPayloads.approve, message.buttonPayloads.return],
    // Human-readable line for operators reading the outbox. States the ASK, and
    // never that a verdict has been reached.
    summaryLine: `Verification needed for #${input.workRefId} - ${message.params[2]} (completed by ${message.params[1]})`,
  }

  // 5. A reused key carrying a DIFFERENT notification is a conflict, not a
  //    duplicate. `enqueueNotification` reports P2002 as `duplicate` without
  //    comparing payloads, so a genuine collision would otherwise be silently
  //    swallowed and the manager told about the wrong record - or nothing.
  const existing = await deps.findByDedupeKey(input.tenantId, dedupeKey)
  if (existing) {
    const before = notificationIdentity(existing.payload)
    const now = notificationIdentity(payload)
    if (before !== null && now !== null && before !== now) {
      return {
        notified: false,
        why: 'dedupe_payload_conflict',
        detail: 'dedupe key reused for a different verification',
        dedupeKey,
      }
    }
    return { notified: false, why: 'duplicate', dedupeKey }
  }

  // 6. Enqueue. The WorkRef correlation goes in the SAME insert, deliberately.
  //
  //    `dispatchWorkToStaff` enqueues and THEN stamps `work_ref_model` in a
  //    second update. `isStaffNotification(row)` keys on exactly that column,
  //    and the drain picks a row up as soon as `next_attempt_at <= now`, which
  //    `enqueueNotification` sets to `new Date()`. So between those two writes
  //    the row is not recognised as staff, `forbidDefaultNumber` is false, and
  //    the send falls back to the tenant's earliest-created number - the
  //    CUSTOMER 6737 line. A crash between them makes that permanent. Setting
  //    the correlation in the insert removes the window rather than narrowing it.
  const result = await deps.enqueue({
    tenantId: input.tenantId,
    contact,
    channel: 'whatsapp',
    consentBasis: 'internal_staff_directive',
    template: message.template,
    payload,
    dedupeKey,
    workRefModel: input.workRefModel,
    workRefId: input.workRefId,
    correlationId: input.correlationId,
  })

  if (!result.enqueued) {
    const reason = result.reason === 'consent_denied' ? 'consent_denied' : 'duplicate'
    return { notified: false, why: reason, dedupeKey }
  }

  return {
    notified: true,
    outboxId: result.id as string,
    dedupeKey,
    activityId: input.activityId,
    template: message.template,
    contact,
  }
}
