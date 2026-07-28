/**
 * staff-notification.ts — the NotificationAttempt contract for staff work.
 *
 * Template-first proactive dispatch, correlated to an Odoo WorkRef, enqueued
 * through the EXISTING durable outbox (`lib/notify.ts` → `NotificationOutbox` →
 * `lib/notify-drain.ts`). No second send path, no second queue, no direct Graph
 * call from here.
 *
 * ── Established truth this encodes (do not re-investigate) ──────────────────
 *
 *   - Internal sender 9043 is healthy.
 *   - Free-form dispatch OUTSIDE the 24-hour customer-service window fails with
 *     Meta error 131047 (*Re-engagement message*). Meta still answers HTTP 200;
 *     the failure arrives asynchronously on the status webhook.
 *   - `epic_internal_task_v1` is already an approved template.
 *   - A `delivered` callback was proven once an inbound had opened the window.
 *   - Graph HTTP 200 is NOT delivery evidence.
 *
 * The last point is the whole reason this module exists as a policy layer
 * rather than a helper: the only safe default for anything proactive is a
 * template, and the only thing a 200 licenses us to write is `accepted`.
 */

import type { WorkRefModel } from './work-ref'

/** The approved internal staff task template. */
export const INTERNAL_TASK_TEMPLATE = 'epic_internal_task_v1'

export type DispatchMode = 'template' | 'freeform'

export interface ServiceWindowState {
  /**
   * When the staff member last sent US a message. Meta's 24-hour customer
   * service window opens on an inbound and closes 24h later.
   */
  lastInboundAt: Date | null
  now: Date
}

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Is there an open service window with this person right now?
 *
 * Pure, and takes `now` explicitly rather than reading the clock, so the
 * boundary is testable to the millisecond. The boundary matters: this is the
 * exact predicate whose false-positive produces a 131047.
 */
export function hasOpenServiceWindow(state: ServiceWindowState): boolean {
  if (!state.lastInboundAt) return false
  const age = state.now.getTime() - state.lastInboundAt.getTime()
  return age >= 0 && age < SERVICE_WINDOW_MS
}

export type DispatchDecision =
  | { mode: 'template'; template: string; why: 'proactive_always_template' | 'window_closed' }
  | { mode: 'freeform'; why: 'window_open_continuation' }

/**
 * Choose how to reach a staff member.
 *
 * PROACTIVE work — a new task dispatch, an escalation, a manager nudge — is
 * ALWAYS a template, even when a window happens to be open. That is stricter
 * than Meta requires, and it is deliberate: window state is inferred from our
 * own records, those records can be stale or wrong, and being wrong costs a
 * silent undelivered task. A template is correct in both cases, so the
 * inference never has to be right.
 *
 * Free-form is permitted only as CONTINUATION inside a window the staff member
 * themselves opened — a reply to their own reply.
 */
export function decideDispatchMode(params: {
  proactive: boolean
  window: ServiceWindowState
}): DispatchDecision {
  if (params.proactive) {
    return { mode: 'template', template: INTERNAL_TASK_TEMPLATE, why: 'proactive_always_template' }
  }
  if (hasOpenServiceWindow(params.window)) {
    return { mode: 'freeform', why: 'window_open_continuation' }
  }
  return { mode: 'template', template: INTERNAL_TASK_TEMPLATE, why: 'window_closed' }
}

export interface StaffTaskTemplateInput {
  staffName: string
  workTitle: string
  projectName: string | null
  dueDate: string | null
}

/**
 * Positional body params for `epic_internal_task_v1`, in template order.
 *
 * Every slot is filled with a non-empty string. Meta rejects a template send
 * whose parameter is empty or whitespace, and that rejection is a 400 that a
 * caller could mistake for "the staff member is unreachable" rather than "we
 * built a bad payload". Placeholders are explicit words a human can read in the
 * message, not blanks.
 */
export function buildStaffTaskTemplateParams(input: StaffTaskTemplateInput): string[] {
  const nonEmpty = (v: string | null | undefined, fallback: string): string => {
    const t = (v ?? '').trim()
    return t.length > 0 ? t : fallback
  }
  return [
    nonEmpty(input.staffName, 'Team member'),
    nonEmpty(input.workTitle, 'Assigned work'),
    nonEmpty(input.projectName, 'General'),
    nonEmpty(input.dueDate, 'No due date'),
  ]
}

/**
 * Dedupe key for a staff notification.
 *
 * Keyed on the correlation id, so one work episode produces one proactive
 * dispatch no matter how many times the producer runs. A genuine re-dispatch is
 * a NEW episode with a new correlation id — it must not silently reuse the old
 * one, or the retry will be swallowed by the unique index and read as success.
 */
export function staffNotificationDedupeKey(params: {
  correlationId: string
  purpose: 'task_dispatch' | 'manager_verification' | 'blocker_escalation' | 'onboarding'
}): string {
  return `staff:${params.purpose}:${params.correlationId}`
}

export interface StaffNotificationEnvelope {
  tenantId: string
  contact: string
  channel: 'whatsapp'
  consentBasis: string
  template: string
  dedupeKey: string
  payload: {
    correlationId: string
    workRefModel: WorkRefModel
    workRefId: number
    templateParams: string[]
    summaryLine: string
  }
}

/**
 * The canonical contact key for a staff member.
 *
 * `StaffBinding.wa_id` holds a WhatsApp wa_id — bare digits, no `+`
 * (`17673173398`). `Consent.phone` is declared "E.164 with leading +" in
 * prisma/schema.prisma, and `enqueueNotification` (lib/notify.ts) keys its
 * fail-closed consent lookup on exactly that value. Handing the bare wa_id to
 * the outbox therefore CANNOT match a Consent row: every staff dispatch
 * returned `consent_denied`. Configured, but not effective — same family as
 * the four defects found during cutover.
 *
 * One function, used by every read AND every write that joins a binding to
 * `NotificationOutbox.contact` or `Consent.phone`, so the write key and the
 * read key cannot drift apart again. Normalising only the write would have
 * been worse than the bug: `filterInPlay` reads the outbox back by contact to
 * decide what is in play, and a mismatch there sends every bare ACK back to
 * needs_disambiguation across all open tasks.
 *
 * The customer path already applies this same rule in `checkWaSendGate`
 * (lib/agent-tools.ts); the send adapter strips the `+` again on the way out
 * (lib/notify-whatsapp.ts), so `+`-prefixed is safe end to end.
 */
export function staffContactE164(waId: string): string {
  return `+${waId.replace(/\D/g, '')}`
}

/**
 * Build the enqueue envelope. Pure — the caller hands it to
 * `enqueueNotification`, which owns consent, idempotency and durability.
 *
 * `consentBasis` is `internal_staff_directive`: this is an employer notifying
 * an employee about that employee's own assigned work through a channel the
 * employee registered during onboarding. It is deliberately NOT
 * `owner_self_notification` (which would be a lie about who is being messaged)
 * and NOT a customer basis (which would demand a marketing opt-in that does not
 * apply). A staff member who has not completed onboarding has no binding, so
 * they are never reachable by this path at all.
 */
export function buildStaffNotification(params: {
  tenantId: string
  toWaId: string
  correlationId: string
  workRefModel: WorkRefModel
  workRefId: number
  template: string
  templateInput: StaffTaskTemplateInput
  purpose: 'task_dispatch' | 'manager_verification' | 'blocker_escalation' | 'onboarding'
}): StaffNotificationEnvelope {
  const templateParams = buildStaffTaskTemplateParams(params.templateInput)
  return {
    tenantId: params.tenantId,
    contact: staffContactE164(params.toWaId),
    channel: 'whatsapp',
    consentBasis: 'internal_staff_directive',
    template: params.template,
    dedupeKey: staffNotificationDedupeKey({
      correlationId: params.correlationId,
      purpose: params.purpose,
    }),
    payload: {
      correlationId: params.correlationId,
      workRefModel: params.workRefModel,
      workRefId: params.workRefId,
      templateParams,
      summaryLine: `${templateParams[1]} — ${templateParams[2]} (due ${templateParams[3]})`,
    },
  }
}
