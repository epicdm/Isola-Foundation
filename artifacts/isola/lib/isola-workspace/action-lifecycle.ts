/**
 * Isola Workspace — the governed-action lifecycle.
 *
 * THE SINGLE MOST IMPORTANT BEHAVIOUR IN THIS DESIGN.
 *
 *     proposed -> awaitingApproval -> executing -> completed (with readback)
 *                        |                |
 *                     blocked           failed
 *                                         |
 *                                    unconfirmed
 *
 * The rules below are not stylistic. Each exists because the alternative tells an operator
 * something untrue about what a customer has been told.
 *
 *   1. `executing` IS NOT SUCCESS. The UI says "this is not finished until the sales system
 *      confirms it." Green never appears during execution.
 *
 *   2. `completed` REQUIRES A READBACK — the owning system's own statement of its own state,
 *      plus a timestamp. Not a paraphrase of the request we sent. Without one the state is
 *      `unconfirmed`, rendered dashed, saying "Do not tell the customer it arrived yet."
 *
 *   3. `blocked` MEANS NOTHING WAS ATTEMPTED. Distinct from failure. It must say the
 *      customer has not been told anything.
 *
 *   4. `failed` STATES WHAT DID NOT CHANGE and what the customer still believes.
 *
 *   5. AN AI EMPLOYEE MAY PREPARE AN ACTION. IT MAY NEVER APPROVE ONE. Approval is captured
 *      against a named human.
 *
 * This module is pure and has no rendering concerns, so the rules are enforced once, in one
 * place, and asserted directly by tests rather than inferred from markup.
 */

import type { ActionState, SourceRef } from './contracts'

// ── Readback ────────────────────────────────────────────────────────────────

/**
 * Proof that a change actually exists in the owning system.
 *
 * `statement` MUST be the system's own words about its own state — e.g. "Reminder 'Follow up
 * on package pricing' now exists on the Joss Boutique record, assigned to Eric Giraud, due
 * 7 Aug 2026." NEVER "Action completed successfully", which is a statement about our request
 * rather than about their state, and is exactly the lie this type exists to prevent.
 */
export interface Readback {
  /** Plain English. Never a vendor name. */
  system: SourceRef
  /** The owning system's own statement of its own state. */
  statement: string
  /** When we read it back. Required — a readback without a time is not evidence. */
  readAt: string
  /** Optional link to the authoritative record. */
  href?: string
}

export function isValidReadback(r: Readback | null | undefined): r is Readback {
  return Boolean(r && r.statement.trim() && r.readAt.trim() && r.system)
}

// ── Actors ──────────────────────────────────────────────────────────────────

export interface ActionActor {
  name: string
  kind: 'human' | 'ai'
}

// ── The action ──────────────────────────────────────────────────────────────

export interface GovernedActionInstance {
  id: string
  /** Written as an outcome, not a system call. */
  title: string
  /** Customer + timing. */
  subtitle?: string
  state: ActionState
  /** Who asked for it. An AI may appear here; it may never appear as approver. */
  requestedBy: ActionActor
  /** REQUIRED. What will change, and whether anything reaches the customer. */
  consequence: string
  /** REQUIRED for blocked / failed / unconfirmed. */
  explanation?: string
  /** REQUIRED for failed. What the customer still believes. */
  customerImpact?: string
  /** Present only in `completed`. Enforced by `assertActionInvariants`. */
  readback?: Readback | null
  /** The named human who approved. Never an AI. */
  approvedBy?: ActionActor | null
  reversible?: boolean
  /** Who owns it, for the avatar and the "Owner …" line. */
  assignee?: ActionActor
  /** "high priority", "due tomorrow", "2 days late". */
  dueLabel?: string
  /**
   * PRESENTATION ONLY — not a state.
   *
   * The design's ActionCard has an `overdue` variant, but "overdue" is not one of the seven
   * action states: it is a `proposed` action whose due date has passed. Modelling it as a
   * state would have produced an eighth state with no transitions of its own and would have
   * broken the invariant that every state describes what happened to the REQUEST. Lateness
   * describes the clock, not the request, so it rides alongside as a flag.
   */
  overdue?: boolean
}

// ── Transitions ─────────────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  proposed: ['awaitingApproval', 'executing', 'blocked'],
  awaitingApproval: ['executing', 'blocked'],
  // Execution has exactly three honest outcomes: it confirmed, it did not happen, or it was
  // accepted and we cannot prove it landed. There is no fourth, and in particular there is
  // no path back to `awaitingApproval` — re-approving something already in flight is how
  // duplicate side effects happen.
  executing: ['completed', 'failed', 'unconfirmed'],
  // Terminal. `failed` may be retried, which creates a NEW attempt rather than mutating this
  // one, so the record of the failure survives.
  completed: [],
  blocked: [],
  failed: [],
  // Deliberately terminal with NO transitions and NO retry. We do not know whether the
  // effect landed; retrying risks doing it twice. Only an authoritative readback obtained
  // out of band can resolve it, which creates a new record.
  unconfirmed: [],
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export class ActionLifecycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionLifecycleError'
  }
}

/**
 * Apply a transition, enforcing every invariant. Returns a NEW instance; never mutates.
 *
 * The `completed` guard is the load-bearing one: it is impossible to construct a completed
 * action through this function without a valid readback. A UI that renders "Done and
 * confirmed" therefore cannot be lying, because the state it is rendering could not exist.
 */
export function transition(
  action: GovernedActionInstance,
  to: ActionState,
  patch: Partial<GovernedActionInstance> = {},
): GovernedActionInstance {
  if (!canTransition(action.state, to)) {
    throw new ActionLifecycleError(
      `Cannot move action "${action.id}" from ${action.state} to ${to}.`,
    )
  }

  const next: GovernedActionInstance = { ...action, ...patch, state: to }
  assertActionInvariants(next)
  return next
}

/**
 * The invariants, enforced on every constructed action.
 *
 * Called by `transition` and directly by fixtures, so a hand-written fixture cannot express
 * a state the product forbids either.
 */
export function assertActionInvariants(a: GovernedActionInstance): void {
  const fail = (m: string) => {
    throw new ActionLifecycleError(`Action "${a.id}": ${m}`)
  }

  if (!a.consequence?.trim()) {
    fail('every governed action must state its consequence, including whether anything reaches the customer')
  }

  // RULE 2 — the reason this module exists.
  if (a.state === 'completed' && !isValidReadback(a.readback)) {
    fail(
      'cannot be "Done and confirmed" without an authoritative readback carrying the owning ' +
        "system's own statement and a timestamp. Use `unconfirmed` when the effect was accepted " +
        'but cannot be proven.',
    )
  }

  // A readback on a non-terminal state would let a UI render success early.
  if (a.readback && a.state !== 'completed') {
    fail(`carries a readback in state "${a.state}"; a readback may only accompany "completed"`)
  }

  // RULE 5 — an AI may prepare, never approve.
  if (a.approvedBy?.kind === 'ai') {
    fail('was approved by an AI employee. Approval must be captured against a named human.')
  }

  // RULES 3 and 4 — these states are useless to an operator without their explanation.
  if ((a.state === 'blocked' || a.state === 'unconfirmed') && !a.explanation?.trim()) {
    fail(`state "${a.state}" requires an explanation saying what did and did not happen`)
  }
  if (a.state === 'failed') {
    if (!a.explanation?.trim()) fail('a failed action must explain what did not change')
    if (!a.customerImpact?.trim()) {
      fail('a failed action must state what the customer still believes')
    }
  }
}

// ── Presentation vocabulary ─────────────────────────────────────────────────

/**
 * The exact operator-facing words. From `06-inventories.md`.
 *
 * These were chosen for Caribbean small-business operators and reviewed for plainness.
 * They are NOT to be "improved" into product language: "Done and confirmed" carries the
 * readback guarantee in a way "Completed" does not, and "Did not work" is legible to
 * someone for whom "Error" is jargon.
 */
export const ACTION_STATE_LABEL: Record<ActionState, string> = {
  proposed: 'To do',
  awaitingApproval: 'Awaiting your approval',
  executing: 'Running now',
  completed: 'Done and confirmed',
  blocked: 'Blocked',
  failed: 'Did not work',
  unconfirmed: 'Not confirmed',
}

/** The semantic colour family per state. `executing` is info — NEVER ok. */
export const ACTION_STATE_FAMILY: Record<
  ActionState,
  'neutral' | 'warn' | 'info' | 'ok' | 'block' | 'err'
> = {
  proposed: 'neutral',
  awaitingApproval: 'warn',
  executing: 'info',
  completed: 'ok',
  blocked: 'block',
  failed: 'err',
  unconfirmed: 'neutral',
}

/** Whether offering a retry is honest. Never for `unconfirmed` — we cannot know. */
export function offersRetry(state: ActionState): boolean {
  return state === 'failed'
}
