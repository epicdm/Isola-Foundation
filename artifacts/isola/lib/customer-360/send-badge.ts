/**
 * send-badge@1 — the one-line wording on a document row after a send attempt.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A FUNCTION IN THE COMPONENT
 * -------------------------------------------------------------
 * It started in `customer-360-app.tsx`, which imports a CSS module. That drags
 * the whole PostCSS/Tailwind/lightningcss chain into any test that touches it,
 * and on this platform that chain fails to load — so the test file never ran and
 * its assertions silently proved nothing. Copy that a human reads is exactly the
 * thing that must stay pinned, so it lives here, free of styling imports, where
 * a test can actually execute it.
 *
 * WHY THE REPLAY CASE IS NOT SIMPLY "Already sent"
 * ------------------------------------------------
 * `idempotent_replay` inherits whatever the earlier attempt ended as, and the
 * presentation contract says plainly that this "may itself have been
 * readback_failed". So a replay is evidence of delivery ONLY when the earlier
 * attempt's readback actually proved one. Printing "Already sent" for an
 * unproven replay would manufacture a delivery claim out of a retry — the exact
 * confident-wrong failure the whole slice exists to prevent.
 *
 * The lifecycle still carries `success: false` for a replay. That data contract
 * is unchanged; only the operator-facing wording moves, and it leads with the
 * DELIVERED state when — and only when — delivery was proven.
 */

export interface SendOutcome {
  success: boolean;
  label: string;
  detail: string;
  operationId: string | null;
  lifecycle: string;
  /** Whether an authoritative readback proved the message exists and is visible. */
  readbackProven: boolean;
}

/**
 * WHY "POSTED" AND NOT "SENT"
 * ---------------------------
 * The readback proves the message exists in Chatwoot, is non-private, and its
 * content matches byte for byte. That is PERSISTENCE IN THE SYSTEM OF RECORD.
 * It is not delivery: Chatwoot's outbound leg is asynchronous, the row exists
 * before the channel has attempted anything, and `status` is never read here. On
 * a conversation outside WhatsApp's 24-hour window, Chatwoot stores the message
 * and Meta refuses it seconds later — and the old wording said "Sent — Done and
 * confirmed" the whole time.
 *
 * So the badge claims exactly what was measured. Delivery status is a real
 * upgrade and is on the backlog; until it exists, the honest word is "posted".
 */
export const POSTED_BADGE = 'Posted into the conversation — read back from the system of record';
export const REPLAY_PROVEN_BADGE = 'Already posted — not posted again';
export const REPLAY_UNPROVEN_BADGE =
  'Already attempted — not posted again, and the earlier attempt was never confirmed';
/**
 * The state a timed-out send now lands in, and it leads with the uncertainty.
 * The lifecycle's own label is "Written but not confirmed"; prefixing that with
 * "Not sent" put the least likely reading first, on the one state where
 * something probably WAS written — and invited the operator to send again.
 */
export const UNPROVEN_BADGE =
  'May have been posted — not confirmed. Check the conversation before trying again';

export function sendBadgeText(outcome: SendOutcome): string {
  if (outcome.success) return POSTED_BADGE;
  if (outcome.lifecycle === 'idempotent_replay') {
    return outcome.readbackProven ? REPLAY_PROVEN_BADGE : REPLAY_UNPROVEN_BADGE;
  }
  if (outcome.lifecycle === 'readback_failed') return UNPROVEN_BADGE;
  return `Not sent — ${outcome.label}`;
}
