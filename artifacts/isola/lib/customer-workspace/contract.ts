/**
 * customer-workspace@1 — the presentation contract for the Customer 360 workspace.
 *
 * This module is pure. It performs no I/O, imports nothing at runtime (every
 * import here is `import type`, which TypeScript erases), and therefore can be
 * tested without a database, a network or a rendered tree.
 *
 * WHAT IT IS FOR
 * --------------
 * Two questions get answered wrongly in workbenches, over and over:
 *
 *   1. "Is this section empty, or did we fail to find out?"
 *   2. "Did that action work?"
 *
 * Both have the same failure shape: a state that means UNKNOWN gets rendered as
 * a state that means NO, or worse, as a state that means YES. The contracts
 * underneath this file already draw those distinctions carefully. This file's
 * only job is to carry them to the screen without flattening them.
 */

import type { SectionResult } from '@/lib/context/context-bundle'
import type { ActionOutcome } from '@/lib/governed/action'
import type { ClaimOutcome } from '@/lib/operations/ledger'
import type { WorkOutcome } from '@/lib/activity/sources/staff-work-action'

export const CUSTOMER_WORKSPACE_VERSION = 'customer-workspace@1' as const

/* ── Section states ────────────────────────────────────────────────────────
 *
 * `empty` and `unavailable` are the pair that matters. "We asked and there is
 * nothing" and "we could not ask" look identical to any UI that only receives
 * an array, and they mean opposite things to whoever is reading the screen.
 */

export const SECTION_STATES = [
  /** Not asked yet. The absence of an answer, not an answer. */
  'loading',
  /** Asked, answered, has content. */
  'available',
  /** Asked, answered, genuinely nothing to show. */
  'empty',
  /** Answered, but a named part of it could not be fetched. Keeps what it has. */
  'partial',
  /** Answered from a copy the source itself called out of date. */
  'stale',
  /** This reader may not see this section. Says nothing about whether it exists. */
  'forbidden',
  /** The source could not answer. NOT the same as `empty`. */
  'unavailable',
  /** The answer arrived and could not be understood. Our fault, not the source's. */
  'error',
  /** A retry is in flight; the previous answer is still on screen. */
  'retrying',
] as const
export type SectionState = (typeof SECTION_STATES)[number]

export interface SectionView {
  state: SectionState
  /** How many records are being shown. Never guessed, never shown for `forbidden`. */
  count: number
  /**
   * Why the section is not `available`. Safe for a screen: adapters sanitise
   * driver text before it reaches here. Absent for `forbidden` — a reason is
   * itself a disclosure about a record this reader may not know exists.
   */
  reason: string | null
  /** Which system answered, and when. Null when nothing answered. */
  provenance: { source: string; fetchedAt: string; stale: boolean } | null
  /** Named parts that did not answer, for `partial`. Empty otherwise. */
  missing: readonly string[]
}

export interface ViewSectionOptions {
  /**
   * Parts of a composed section that did not answer. A section built from more
   * than one upstream is `partial` when some of them failed — it keeps what it
   * has and names what it lost, rather than discarding a usable answer.
   */
  missing?: readonly string[]
  /** A retry is in flight over an answer we already have. */
  retrying?: boolean
}

/**
 * Turn one `SectionResult` into what the screen renders.
 *
 * `undefined` means the section was never requested or has not come back —
 * `loading`. It deliberately does not become `empty`.
 */
export function viewSection(
  result: SectionResult<readonly unknown[]> | undefined,
  options: ViewSectionOptions = {},
): SectionView {
  const missing = options.missing ?? []

  if (result === undefined) {
    return { state: 'loading', count: 0, reason: null, provenance: null, missing: [] }
  }

  if (result.status === 'forbidden') {
    // No reason, no count, no provenance. A reader who may not see this section
    // must not be able to infer from the refusal how much is behind it.
    return { state: 'forbidden', count: 0, reason: null, provenance: null, missing: [] }
  }

  if (result.status === 'unavailable') {
    return {
      state: 'unavailable',
      count: 0,
      reason: result.reason,
      provenance: null,
      missing: [],
    }
  }

  if (!Array.isArray(result.data)) {
    // The adapter answered with something this view cannot read. That is our
    // defect, not the source's, and it is not an empty section.
    return {
      state: 'error',
      count: 0,
      reason: 'the answer could not be read',
      provenance: null,
      missing: [],
    }
  }

  const provenance = {
    source: result.provenance.source,
    fetchedAt: result.provenance.fetchedAt.toISOString(),
    stale: result.provenance.stale,
  }
  const count = result.data.length

  // Order matters below. `retrying` sits on top of a real answer, `partial`
  // outranks `stale`, and `empty` is only reached once we know the whole
  // section answered.
  if (options.retrying) return { state: 'retrying', count, reason: null, provenance, missing }
  if (missing.length > 0) {
    return {
      state: 'partial',
      count,
      reason: `${missing.length === 1 ? 'one part' : `${missing.length} parts`} of this section could not be fetched`,
      provenance,
      missing,
    }
  }
  if (result.provenance.stale) {
    return {
      state: 'stale',
      count,
      reason: 'this is a stored copy, not a fresh read',
      provenance,
      missing: [],
    }
  }
  if (count === 0) return { state: 'empty', count: 0, reason: null, provenance, missing: [] }

  return { state: 'available', count, reason: null, provenance, missing: [] }
}

/** True when the section is showing records the reader can act on. */
export function sectionHasContent(view: SectionView): boolean {
  return view.count > 0
}

/**
 * True when the section's state means "we do not know", as opposed to "there is
 * nothing" or "you may not see it". Used to decide whether the workspace as a
 * whole must announce that it is showing an incomplete picture.
 */
export function sectionIsUnknown(view: SectionView): boolean {
  return view.state === 'unavailable' || view.state === 'error' || view.state === 'partial'
}

/* ── Action lifecycle ──────────────────────────────────────────────────────*/

export const ACTION_LIFECYCLE_STATES = [
  'draft',
  'validation_failed',
  'permission_denied',
  'approval_required',
  'approval_pending',
  'approval_rejected',
  'executing',
  'dependency_unavailable',
  'execution_failed',
  'executor_unavailable',
  'readback_failed',
  'completed_verified',
  'idempotent_replay',
  'argument_conflict',
] as const
export type ActionLifecycleState = (typeof ACTION_LIFECYCLE_STATES)[number]

/**
 * States that belong to the FORM rather than to a recorded operation. Nothing
 * has been sent in either of them, and neither appears in any source contract.
 */
export const FORM_ONLY_STATES: readonly ActionLifecycleState[] = ['draft', 'executing']

export type RetryAdvice = 'safe' | 'unsafe' | 'not_applicable'
export type LifecycleTone =
  | 'neutral'
  | 'pending'
  | 'refused'
  | 'unreachable'
  | 'unproven'
  | 'confirmed'

export interface LifecyclePresentation {
  state: ActionLifecycleState
  /** Short, unique, and never a colour name. */
  label: string
  /** What the reader is actually told. Written for a staff member, not an engineer. */
  sentence: string
  /** A non-colour marker, so meaning survives monochrome and a screen reader. */
  marker: string
  tone: LifecycleTone
  /** The action will not move on its own from here. */
  terminal: boolean
  /**
   * TRUE for exactly one state. If this is ever true for readback_failed, the
   * one guarantee this whole module exists for has been lost.
   */
  success: boolean
  /** Whether sending the SAME write again is a sensible thing to do. */
  retryWrite: RetryAdvice
  /** Whether asking the system of record again for the result is sensible. */
  retryReadback: RetryAdvice
  /** A human needs to go and look at the system of record. */
  escalate: boolean
  /** The result on screen belongs to an EARLIER attempt, not this one. */
  showsPriorResult: boolean
}

const P = (p: LifecyclePresentation): LifecyclePresentation => p

export const LIFECYCLE_PRESENTATION: Readonly<
  Record<ActionLifecycleState, LifecyclePresentation>
> = {
  draft: P({
    state: 'draft',
    label: 'Not sent',
    sentence: 'This has not been sent. Nothing has been written.',
    marker: '·',
    tone: 'neutral',
    terminal: false,
    success: false,
    retryWrite: 'not_applicable',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  validation_failed: P({
    state: 'validation_failed',
    label: 'Rejected before sending',
    sentence: 'The details were not valid, so this was never sent. Nothing was written.',
    marker: '✕',
    tone: 'refused',
    terminal: true,
    success: false,
    // Correcting the details makes a NEW request; re-sending this one does not.
    retryWrite: 'unsafe',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  permission_denied: P({
    state: 'permission_denied',
    label: 'Not permitted',
    sentence:
      'You may not take this action on this record. Nothing was sent and nothing was written.',
    marker: '✕',
    tone: 'refused',
    terminal: true,
    success: false,
    retryWrite: 'unsafe',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  approval_required: P({
    state: 'approval_required',
    label: 'Needs approval',
    sentence: 'This needs a person to approve it before it can run. Nothing has been written.',
    marker: '⏸',
    tone: 'pending',
    terminal: false,
    success: false,
    retryWrite: 'not_applicable',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  approval_pending: P({
    state: 'approval_pending',
    label: 'Waiting for approval',
    sentence: 'An approval request is open and has not been decided. Nothing has been written.',
    marker: '⏳',
    tone: 'pending',
    terminal: false,
    success: false,
    retryWrite: 'not_applicable',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  approval_rejected: P({
    state: 'approval_rejected',
    label: 'Approval refused',
    sentence: 'A person refused this. Nothing was written.',
    marker: '✕',
    tone: 'refused',
    terminal: true,
    success: false,
    retryWrite: 'unsafe',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  executing: P({
    state: 'executing',
    label: 'Running',
    sentence: 'Sent to the system of record. The outcome is not known yet.',
    marker: '…',
    tone: 'pending',
    terminal: false,
    success: false,
    retryWrite: 'unsafe',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  // ── The pair the order singles out. Everything about them differs. ────────

  dependency_unavailable: P({
    state: 'dependency_unavailable',
    label: 'Could not reach the system',
    sentence:
      'The system of record could not be contacted, so it never received this. It did not refuse — it was not reached. Nothing was written, and trying again is reasonable.',
    marker: '⟳',
    tone: 'unreachable',
    terminal: true,
    success: false,
    retryWrite: 'safe',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  execution_failed: P({
    state: 'execution_failed',
    label: 'The system refused it',
    sentence:
      'The system of record answered and rejected this. Nothing was written. Sending the same thing again will be refused the same way.',
    marker: '✕',
    tone: 'refused',
    terminal: true,
    success: false,
    retryWrite: 'unsafe',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  executor_unavailable: P({
    state: 'executor_unavailable',
    label: 'Nothing here can do this yet',
    sentence:
      'This action is listed but has no implementation behind it, so nothing was performed. This is a gap in the system, not a refusal by the system of record.',
    marker: '⌀',
    tone: 'unreachable',
    terminal: true,
    success: false,
    retryWrite: 'unsafe',
    retryReadback: 'not_applicable',
    escalate: true,
    showsPriorResult: false,
  }),

  // ── The state this module exists for. ────────────────────────────────────

  readback_failed: P({
    state: 'readback_failed',
    label: 'Written but not confirmed',
    sentence:
      'Something was written and we could not read it back to prove what. Do not treat this as done. Check the system of record before acting on it.',
    marker: '!',
    tone: 'unproven',
    terminal: true,
    // NOT success. A write we cannot prove is not a write we can report.
    success: false,
    // Sending it again may write it a second time. Reading it back may not.
    retryWrite: 'unsafe',
    retryReadback: 'safe',
    escalate: true,
    showsPriorResult: false,
  }),

  completed_verified: P({
    state: 'completed_verified',
    label: 'Done and confirmed',
    sentence: 'Written, and read back from the system of record to prove it.',
    marker: '✓',
    tone: 'confirmed',
    terminal: true,
    success: true,
    retryWrite: 'not_applicable',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),

  idempotent_replay: P({
    state: 'idempotent_replay',
    label: 'Already recorded',
    sentence:
      'This exact request had already been recorded, so nothing was written again. The result shown belongs to that earlier attempt — its own state is the one that counts.',
    marker: '≡',
    tone: 'neutral',
    terminal: true,
    // Deliberately not success. A replay inherits whatever the earlier attempt
    // ended as, and that may itself have been readback_failed.
    success: false,
    retryWrite: 'not_applicable',
    retryReadback: 'safe',
    escalate: false,
    showsPriorResult: true,
  }),

  argument_conflict: P({
    state: 'argument_conflict',
    label: 'Same reference, different details',
    sentence:
      'This reference was already used with different details. Returning the earlier result would answer a question that was not asked, so it was refused. Nothing was written.',
    marker: '⚑',
    tone: 'refused',
    terminal: true,
    success: false,
    retryWrite: 'unsafe',
    retryReadback: 'not_applicable',
    escalate: false,
    showsPriorResult: false,
  }),
}

export function presentLifecycle(state: ActionLifecycleState): LifecyclePresentation {
  return LIFECYCLE_PRESENTATION[state]
}

/**
 * The ONLY state that may be rendered as a success. Kept as a function so a
 * component asks the contract rather than testing a string it happens to know.
 */
export function isProvenSuccess(state: ActionLifecycleState): boolean {
  return LIFECYCLE_PRESENTATION[state].success
}

/** True when a write may have landed without us being able to prove it. */
export function mayHaveWritten(state: ActionLifecycleState): boolean {
  return state === 'readback_failed'
}

/* ── Mappings from the three real source vocabularies ───────────────────────
 *
 * Each is total over its source union and written as an exhaustive record, so
 * adding an outcome upstream breaks the build here instead of silently landing
 * on a default.
 */

const FROM_ACTION_OUTCOME: Readonly<Record<ActionOutcome, ActionLifecycleState>> = {
  EXECUTED: 'completed_verified',
  VALIDATION_FAILED: 'validation_failed',
  PERMISSION_DENIED: 'permission_denied',
  APPROVAL_REQUIRED: 'approval_required',
  APPROVAL_REJECTED: 'approval_rejected',
  EXECUTOR_UNAVAILABLE: 'executor_unavailable',
  EXECUTION_FAILED: 'execution_failed',
  READBACK_FAILED: 'readback_failed',
  IDEMPOTENT_REPLAY: 'idempotent_replay',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
}

export function fromActionOutcome(outcome: ActionOutcome): ActionLifecycleState {
  return FROM_ACTION_OUTCOME[outcome]
}

export type ClaimStatus = ClaimOutcome['status']

const FROM_CLAIM_STATUS: Readonly<Record<ClaimStatus, ActionLifecycleState>> = {
  // The ledger has handed us the claim; the write is what happens next.
  claimed: 'executing',
  already_completed: 'idempotent_replay',
  in_flight: 'executing',
  argument_conflict: 'argument_conflict',
  // The earlier attempt failed and this caller may not retry it. The refusal is
  // ours, not the system of record's, but the outcome for the reader is the
  // same: it did not happen and re-sending will not change that.
  previously_failed: 'execution_failed',
  retry_after_failure: 'executing',
}

export function fromClaimStatus(status: ClaimStatus): ActionLifecycleState {
  return FROM_CLAIM_STATUS[status]
}

const FROM_WORK_OUTCOME: Readonly<Record<WorkOutcome, ActionLifecycleState>> = {
  completed_verified: 'completed_verified',
  readback_failed: 'readback_failed',
  dependency_unavailable: 'dependency_unavailable',
  execution_failed: 'execution_failed',
  in_progress: 'executing',
}

export function fromWorkOutcome(outcome: WorkOutcome): ActionLifecycleState {
  return FROM_WORK_OUTCOME[outcome]
}

/**
 * An approval verdict is not an action outcome — it is the reason an action is
 * sitting still. `pending` and `required` are deliberately different states:
 * one means nobody has been asked yet, the other means somebody has been asked
 * and has not answered.
 */
export function fromApprovalVerdict(
  state: 'pending' | 'granted' | 'rejected' | 'none',
): ActionLifecycleState {
  if (state === 'pending') return 'approval_pending'
  if (state === 'rejected') return 'approval_rejected'
  if (state === 'none') return 'approval_required'
  // Granted does not mean done. It means the action may now run.
  return 'executing'
}
