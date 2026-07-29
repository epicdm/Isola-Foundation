/**
 * Conversation ownership — the authoritative vocabulary and the pure rules
 * that govern it.
 *
 * Implements the state half of
 * `dec-chatwoot-escalation-contract-inbox46-2026-07-29` and
 * `dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29`.
 *
 * ── Why this module exists ───────────────────────────────────────────────
 *
 * Until Commit 2, `Conversation.human_handling` was the SOLE authority over
 * whether Foundation's brain may answer a customer. It is a boolean, so it
 * cannot express any of the four things the live loop actually needs:
 *
 *   1. WHO asked for the human (a customer escalation, an agent taking over,
 *      or nobody — a Chatwoot status flip).
 *   2. WHICH episode of human involvement a later event belongs to, so a
 *      stale handback for a conversation that has since been escalated again
 *      cannot silently resume the AI.
 *   3. That a conversation is mid-handback — reconciling, not yet resumed —
 *      during which BOTH the human and the AI must stay silent.
 *   4. That `conversation_resolved` is an observation about a Chatwoot UI
 *      state, NOT a grant of response authority. The pre-Commit-2 code
 *      cleared the boolean on resolution, which meant closing a ticket
 *      handed the microphone straight back to the AI with no reconciliation
 *      and no record.
 *
 * `human_handling` survives as a COMPATIBILITY PROJECTION of the state
 * (`projectHumanHandling`) so dashboards, counters and the legacy non-gated
 * doors keep working unchanged. Every write of the boolean now goes through
 * the ownership engine (`./transitions.ts`), so the two stores cannot drift
 * apart in the authoritative regime.
 *
 * ── Authoritative vs legacy regime ───────────────────────────────────────
 *
 * See `./authority.ts`. On a door where the ownership model is authoritative
 * (today: gated doors only, and the gate is OFF), the STATE decides whether
 * the AI may speak. On every other door the legacy boolean keeps deciding,
 * exactly as it does in production right now, and ownership is recorded
 * alongside it without changing routing. That is what makes this commit
 * inert while `ISOLA_AI_LOOP_ENABLED` is off.
 *
 * This module is pure: no Prisma, no I/O, no env reads. Everything here is
 * a total function over values, which is why the rules are exhaustively
 * testable without a database.
 */

import { OWNERSHIP_STATES, type OwnershipState } from '@/lib/clawith/contract';

export { OWNERSHIP_STATES };
export type { OwnershipState };

/** The state a conversation is created in and returns to once a resumed turn
 *  has been consumed. */
export const DEFAULT_OWNERSHIP_STATE: OwnershipState = 'AI_OWNED';

/** States in which Foundation may invoke the brain for a customer-facing turn,
 *  execute the customer-facing tool loop, or send an automated reply.
 *
 *  `AI_RESUMED` is separate from `AI_OWNED` so "the conversation came back
 *  from a human" is observable for exactly one turn — see `settleResumed()`
 *  in ./transitions.ts. Both permit an invocation; neither is a licence to
 *  send anything the brain did not produce. */
export const AI_AUTHORITY_STATES: ReadonlySet<OwnershipState> = new Set<OwnershipState>([
  'AI_OWNED',
  'AI_RESUMED',
]);

/** States in which every automated customer-facing reply is suppressed.
 *  `HANDING_BACK` is here deliberately: mid-reconciliation the AI has not
 *  been given authority back yet, and a reply sent during reconciliation
 *  would be a reply composed without the human's outcome in context. */
export const HUMAN_AUTHORITY_STATES: ReadonlySet<OwnershipState> = new Set<OwnershipState>([
  'HUMAN_REQUESTED',
  'HUMAN_OWNED',
  'HANDING_BACK',
]);

export function isOwnershipState(value: unknown): value is OwnershipState {
  return typeof value === 'string' && (OWNERSHIP_STATES as readonly string[]).includes(value);
}

/** True only for states that permit a Clawith invocation for a customer turn. */
export function mayInvokeAi(state: OwnershipState): boolean {
  return AI_AUTHORITY_STATES.has(state);
}

/** The inverse, named for the thing call sites actually assert. */
export function suppressesAutomatedReply(state: OwnershipState): boolean {
  return !mayInvokeAi(state);
}

/** The compatibility projection onto the legacy boolean. NOT authoritative —
 *  it is derived from the state, never the other way round. */
export function projectHumanHandling(state: OwnershipState): boolean {
  return HUMAN_AUTHORITY_STATES.has(state);
}

/**
 * The complete legal transition graph. Anything absent is illegal and is
 * refused by `./transitions.ts` rather than silently applied.
 *
 * Note what is NOT here: there is no edge from any HUMAN state to an AI state
 * other than `HANDING_BACK → AI_RESUMED`. That single edge is reachable only
 * from `completeHandback()`, which runs only after an explicit authorized
 * action AND successful reconciliation. Resolution has no edge at all.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<OwnershipState, readonly OwnershipState[]>> = {
  AI_OWNED:        ['HUMAN_REQUESTED', 'HUMAN_OWNED'],
  AI_RESUMED:      ['AI_OWNED', 'HUMAN_REQUESTED', 'HUMAN_OWNED'],
  HUMAN_REQUESTED: ['HUMAN_OWNED', 'HANDING_BACK'],
  HUMAN_OWNED:     ['HANDING_BACK'],
  // Reconciliation succeeded → AI_RESUMED. Reconciliation failed → back to
  // HUMAN_OWNED. There is no third outcome, and in particular no outcome in
  // which a failed reconciliation leaves the AI in charge.
  HANDING_BACK:    ['AI_RESUMED', 'HUMAN_OWNED'],
};

export function canTransition(from: OwnershipState, to: OwnershipState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** The subset of a Conversation row this module needs. Structural, so both
 *  Prisma rows and test fixtures satisfy it without a cast. */
export interface OwnershipBearingRow {
  ownership_state?: string | null;
  ownership_episode?: number | null;
  human_handling?: boolean | null;
}

export interface OwnershipView {
  state: OwnershipState;
  episode: number;
  /**
   * True when the row could not be read as a consistent ownership fact:
   * an unrecognised state string, or an AI state while the legacy boolean
   * says a human is handling the conversation. Both are treated as
   * human-owned — fail closed. A divergence must silence the AI, never
   * license it.
   */
  diverged: boolean;
}

/**
 * Read ownership off a conversation row, FAIL CLOSED.
 *
 * A row written by an older deploy, a hand-edited row, or a future state
 * string this build does not know about all resolve to `HUMAN_OWNED` with
 * `diverged: true`. The cost of that is a conversation that waits for a
 * person; the cost of failing open is an automated reply into a conversation
 * a human owns, which is the exact class of defect this commit exists to
 * make impossible.
 */
export function readOwnership(row: OwnershipBearingRow): OwnershipView {
  const rawEpisode = typeof row.ownership_episode === 'number' && Number.isFinite(row.ownership_episode)
    ? Math.max(0, Math.trunc(row.ownership_episode))
    : 0;

  if (!isOwnershipState(row.ownership_state)) {
    return { state: 'HUMAN_OWNED', episode: rawEpisode, diverged: true };
  }
  if (mayInvokeAi(row.ownership_state) && row.human_handling === true) {
    return { state: 'HUMAN_OWNED', episode: rawEpisode, diverged: true };
  }
  return { state: row.ownership_state, episode: rawEpisode, diverged: false };
}

/**
 * The LEGACY reply gate, named so an audit of "what decides whether the bot
 * speaks" finds it explicitly instead of an anonymous `if (conv.human_handling)`.
 *
 * This is the pre-Commit-2 rule, retained verbatim for every door where the
 * ownership model is not yet authoritative. It is a compatibility read of a
 * projection, not an ownership decision — the ownership decision is
 * `suppressesAutomatedReply(readOwnership(row).state)`.
 */
export function legacyHumanHandlingSuppresses(row: OwnershipBearingRow): boolean {
  return row.human_handling === true;
}
