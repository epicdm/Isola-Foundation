/**
 * staff-channel.ts - which WhatsApp number an INTERNAL staff notification goes
 * out from.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 *   `sendWhatsApp` historically defaulted to the tenant EARLIEST-CREATED
 *   WhatsApp number. On the EPIC tenant that is `278390858690809`,
 *   `+1 767 295 6737` - the CUSTOMER-facing line, created 2026-07-17, eleven
 *   days before the internal staff line existed. So the default was not a
 *   neutral fallback; it was "message your own employee from the number your
 *   customers talk to", and it was one unset environment variable away from
 *   happening. Record creation order is not a channel-selection rule.
 *
 * THE RULE
 *   A staff notification resolves an EXPLICITLY configured staff channel or it
 *   does not send at all. There is no second choice, no nearest match and no
 *   "any number belonging to the tenant will do". An unconfigured staff channel
 *   is an operational error a human must fix, and it says so.
 *
 * WHAT MARKS A ROW AS STAFF
 *   `work_ref_model` - set only by the Wave 1 staff-dispatch path
 *   (`dispatchWorkToStaff`) and absent on every customer-facing notification.
 *   Using the existing marker rather than inventing a second one keeps the
 *   classification in one place.
 */

export const STAFF_PHONE_NUMBER_ID_ENV = "STAFF_NOTIFICATION_PHONE_NUMBER_ID"

export type StaffChannelResolution =
  | { ok: true; phoneNumberId: string }
  | { ok: false; reason: string }

/** True when this outbox row is an internal staff notification. */
export function isStaffNotification(row: { work_ref_model?: string | null }): boolean {
  return typeof row.work_ref_model === "string" && row.work_ref_model.length > 0
}

/**
 * Resolve the configured staff channel, or refuse.
 *
 * Deliberately takes `env` so the rule is testable without mutating the
 * process, and deliberately returns a refusal rather than throwing: the drain
 * records it as this row failure reason, which is where an operator will
 * actually look.
 */
export function resolveStaffChannel(env: NodeJS.ProcessEnv = process.env): StaffChannelResolution {
  const configured = (env[STAFF_PHONE_NUMBER_ID_ENV] ?? "").trim()
  if (!configured) {
    return {
      ok: false,
      reason: `${STAFF_PHONE_NUMBER_ID_ENV} is not configured - refusing to send an internal staff notification from an unspecified number`,
    }
  }
  if (!/^\d+$/.test(configured)) {
    return {
      ok: false,
      reason: `${STAFF_PHONE_NUMBER_ID_ENV} is not a Meta phone_number_id - refusing to send`,
    }
  }
  return { ok: true, phoneNumberId: configured }
}
