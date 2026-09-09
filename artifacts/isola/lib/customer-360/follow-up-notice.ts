/**
 * follow-up-notice.ts — what the operator is told when "Create follow-up task"
 * does not create a follow-up task.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE COMPONENT
 * -------------------------------------------------------
 * components/customer-360/customer-360-app.test.tsx already records the
 * lesson, in its own header: that component imports a CSS module, and on some
 * platforms that import chain fails to LOAD, which makes every assertion in
 * the file silently not run. Copy a human reads must be pinned somewhere that
 * actually executes. This module is pure — no React, no CSS, no I/O — so its
 * test cannot be silently skipped.
 *
 * WHAT WENT WRONG BEFORE IT EXISTED
 * ---------------------------------
 * The container read `if (result?.ok && result.followUp)` and did nothing on
 * anything else, with a comment saying a refusal "is silently absorbed here".
 * That absorbed EVERY refusal: an unreachable Odoo, a failed readback, an
 * unresolvable activity type — and, once the write guard landed, a tenant with
 * no OdooBinding row. The button re-enabled and the operator was shown nothing
 * at all, which is not even a failure they can report.
 *
 * THE DISTINCTION THAT MATTERS
 * ----------------------------
 * These three are different facts and get different words:
 *
 *   not bound      the destination does not exist. Nothing was written and
 *                  nothing will be until a person connects this business's
 *                  Odoo. RETRYING CANNOT HELP, so the copy must not invite it.
 *   refused        the route answered and said no, and said why.
 *   unreachable    we never got an answer. Whether the follow-up was created
 *                  is UNKNOWN — not "nothing happened". The request may have
 *                  arrived. So it points at the system of record rather than
 *                  claiming a state it cannot prove.
 */

// FROM THE CONSTANTS MODULE, NOT FROM engine-bindings.
// This file is reached from `components/customer-360/customer-360-app.tsx`,
// which is `'use client'`. `@/lib/engine-bindings` imports `@/lib/tenant-secrets`,
// which imports `node:crypto`, so importing the code from there put a Node
// crypto module into a browser bundle and `next build` failed. Same constant,
// same single definition, no server dependency.
import { TENANT_NOT_BOUND } from '@/lib/engine-bindings.constants'

/**
 * A business whose Odoo is not connected.
 *
 * Deliberately says what is true and what to do, and deliberately does NOT say
 * "something went wrong" or "try again": nothing went wrong, and trying again
 * is the one thing guaranteed not to work.
 */
export const FOLLOW_UP_NOT_BOUND_NOTICE =
  'This business is not connected to an Odoo instance, so the follow-up was not created and nothing was written. This is not a temporary fault — the connection has to be set up before follow-ups can be created here.'

/**
 * The request never got an answer. The honest state is UNKNOWN, so this points
 * at the system of record instead of asserting that nothing happened.
 */
export const FOLLOW_UP_UNREACHABLE_NOTICE =
  'Isola could not reach the system of record, so it is not known whether the follow-up was created. Check this customer in Odoo before creating another one.'

/** Used when the route refused without saying anything usable. */
export const FOLLOW_UP_REFUSED_FALLBACK = 'The follow-up was not created.'

/**
 * The notice for one create-followup response body, or null when the follow-up
 * was actually created and proven.
 *
 * `null` is reserved for the ONE case the route calls success: `ok: true` with
 * a readback-proven row. Anything else — including a body this function does
 * not recognise — produces a notice, because an unrecognised answer is not a
 * created follow-up and must never be rendered as one.
 */
export function followUpNoticeFor(result: unknown): string | null {
  const body = (result ?? {}) as Record<string, unknown>

  if (body.ok === true && body.followUp) return null

  if (body.reason === TENANT_NOT_BOUND) return FOLLOW_UP_NOT_BOUND_NOTICE

  const detail = typeof body.error === 'string' ? body.error.trim() : ''
  return detail ? `${FOLLOW_UP_REFUSED_FALLBACK} ${detail}` : FOLLOW_UP_REFUSED_FALLBACK
}
