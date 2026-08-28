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

/**
 * Still running. NOT "not sent" — the write has already been handed to the
 * system of record and the outcome is simply not known yet.
 *
 * This state is reachable in ordinary use: the ledger claim is held for up to
 * ~20s (POST timeout plus readback timeout), and the panel's in-flight guard is
 * a per-instance ref that Chatwoot resets whenever it re-mounts the iframe — as
 * it does when an operator switches conversation and comes back. A second click
 * in that window answers `executing`.
 */
export const IN_FLIGHT_BADGE =
  'Still sending — not confirmed yet. Do not send it again until this settles';

/**
 * The default for anything not explicitly known to be safe. It says the one true
 * thing available: we cannot confirm, so go and look.
 */
export const UNKNOWN_BADGE = 'Not confirmed — check the conversation before sending again';

/**
 * THE ONLY LIFECYCLES THAT MAY SAY "Not sent".
 *
 * An allowlist, not a fallthrough, and that is the whole point. Every state here
 * PROVES nothing reached the customer: the request was refused, held, or never
 * left. Anything else — in flight, unproven, or a state added to the contract
 * after this was written — falls to UNKNOWN_BADGE, because telling an operator
 * "Not sent" about a message that IS sent is how the same customer receives the
 * same document twice. That defect was fixed in the ledger and then reappeared
 * here, in the wording, through a default that looked harmless.
 */
const PROVES_NOTHING_WAS_WRITTEN: ReadonlySet<string> = new Set([
  'draft',
  'validation_failed',
  'permission_denied',
  'approval_required',
  'approval_pending',
  'approval_rejected',
  'dependency_unavailable',
  'execution_failed',
  'executor_unavailable',
  'argument_conflict',
]);

export function sendBadgeText(outcome: SendOutcome): string {
  if (outcome.success) return POSTED_BADGE;
  if (outcome.lifecycle === 'idempotent_replay') {
    return outcome.readbackProven ? REPLAY_PROVEN_BADGE : REPLAY_UNPROVEN_BADGE;
  }
  if (outcome.lifecycle === 'readback_failed') return UNPROVEN_BADGE;
  if (outcome.lifecycle === 'executing') return IN_FLIGHT_BADGE;
  if (PROVES_NOTHING_WAS_WRITTEN.has(outcome.lifecycle)) {
    return `Not sent — ${outcome.label}`;
  }
  return UNKNOWN_BADGE;
}
