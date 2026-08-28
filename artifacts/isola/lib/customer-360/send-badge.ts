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

export const REPLAY_PROVEN_BADGE = 'Already sent — not sent again';
export const REPLAY_UNPROVEN_BADGE =
  'Already attempted — not sent again, and the earlier attempt was never confirmed';

export function sendBadgeText(outcome: SendOutcome): string {
  if (outcome.success) return `Sent — ${outcome.label}`;
  if (outcome.lifecycle === 'idempotent_replay') {
    return outcome.readbackProven ? REPLAY_PROVEN_BADGE : REPLAY_UNPROVEN_BADGE;
  }
  return `Not sent — ${outcome.label}`;
}
