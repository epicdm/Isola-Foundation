/**
 * Conversation ownership — the vocabulary and the pure rules.
 *
 * WHY THIS EXISTS IN THE GATEWAY
 * ------------------------------
 * Today this service decides whether the AI may speak from Chatwoot's own UI
 * state, in `evaluateSuppression`: reply only when `status === "pending"` and
 * nobody is assigned. That predicate is honest about what it can see and wrong
 * about what it means. It cannot express:
 *
 *   1. WHO asked for the human — a customer escalation, an agent taking over,
 *      or nobody at all (a status flip done for housekeeping).
 *   2. WHICH episode of human involvement a later event belongs to, so a stale
 *      handback for a conversation that has since been escalated AGAIN cannot
 *      silently resume the AI.
 *   3. That a conversation is mid-handback — reconciling, not yet resumed —
 *      during which BOTH the human and the AI must stay silent.
 *   4. That a Chatwoot status change is an OBSERVATION, not a grant of response
 *      authority. Under the current predicate, an agent resolving and reopening
 *      a ticket, or an automation rule moving it back to `pending`, hands the
 *      microphone straight back to the AI with no reconciliation and no record.
 *
 * This module is the state half of the ownership contract already ratified and
 * proven in Foundation:
 *   dec-chatwoot-escalation-contract-inbox46-2026-07-29          (Ratified)
 *   dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29 (Ratified)
 *
 * It is a BEHAVIOUR-PRESERVING PORT of `artifacts/isola/lib/ownership/state.ts`.
 * The vocabulary, the transition graph and the fail-closed read are identical by
 * intent; `test/ownership.test.ts` pins each of them so a future edit to either
 * copy that silently diverges fails here. Ported rather than imported because
 * this service is a standalone package with no workspace alias, deliberately —
 * it is the only publicly exposed Isola component and it does not take a
 * dependency on the Foundation application tree.
 *
 * PURE ON PURPOSE
 * ---------------
 * No database, no I/O, no clock, no env. Everything here is a total function
 * over values, which is what makes the rules exhaustively testable without a
 * Postgres. The durable half lives in `src/ownership-store.ts`.
 */

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The five states, in the order declared by `lib/clawith/contract.ts`. The wire
 * contract and both stores speak one language; a sixth state is a contract
 * change, not a local edit.
 */
export const OWNERSHIP_STATES = [
  "AI_OWNED",
  "HUMAN_REQUESTED",
  "HUMAN_OWNED",
  "HANDING_BACK",
  "AI_RESUMED",
] as const;

export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

/** The state a conversation is created in, and returns to once a resumed turn
 *  has been consumed. */
export const DEFAULT_OWNERSHIP_STATE: OwnershipState = "AI_OWNED";

/**
 * States in which the gateway may invoke the runtime for a customer-facing turn
 * or send an automated reply.
 *
 * `AI_RESUMED` is separate from `AI_OWNED` so "this conversation just came back
 * from a human" is observable for exactly one turn. Both permit an invocation;
 * neither is a licence to send anything the model did not produce.
 */
export const AI_AUTHORITY_STATES: ReadonlySet<OwnershipState> = new Set<OwnershipState>([
  "AI_OWNED",
  "AI_RESUMED",
]);

/**
 * States in which every automated customer-facing reply is suppressed.
 *
 * `HANDING_BACK` is here deliberately: mid-reconciliation the AI has not been
 * given authority back yet, and a reply sent during reconciliation would be a
 * reply composed without the human's outcome in context.
 */
export const HUMAN_AUTHORITY_STATES: ReadonlySet<OwnershipState> = new Set<OwnershipState>([
  "HUMAN_REQUESTED",
  "HUMAN_OWNED",
  "HANDING_BACK",
]);

/**
 * The operation kinds recorded in the transition ledger. Free-form text in the
 * column; enumerated here so the audit surface is inspectable and a typo cannot
 * invent a new kind silently.
 */
export const OWNERSHIP_OPERATION_KINDS = [
  "escalate",
  "human_assigned",
  "human_reply",
  "handback_begin",
  "handback_complete",
  "handback_failed",
  "resolution_observed",
  "resumed_settled",
  /**
   * A human assignee was OBSERVED on a conversation_updated/status_changed
   * payload that did not arrive through this gateway's own escalation flow —
   * an "Assign to me" done directly in Chatwoot, outside requestHumanOwnership
   * / confirmHumanOwnership. Kept distinct from "human_assigned" (which is
   * confirmHumanOwnership's own escalation-confirmed transition) so the audit
   * trail can tell the two provenances apart: one is the gateway's own flow
   * completing, the other is this reconciliation noticing a hold it never
   * created. def-handback-sweeper-is-blind-to-manually-assigned-conversations-2026-09-13.
   */
  "assignee_observed",
] as const;

export type OwnershipOperationKind = (typeof OWNERSHIP_OPERATION_KINDS)[number];

/**
 * The seven escalation reason codes, from the same ratified contract. Carried
 * so a transition's `reason` for an escalation is drawn from a closed set
 * rather than free text a caller invented.
 */
export const ESCALATION_REASON_CODES = [
  "explicit_human_request",
  "low_confidence",
  "policy_boundary",
  "approval_required",
  "tool_failure",
  "complaint_sensitive",
  "unsupported_request",
] as const;

export type EscalationReasonCode = (typeof ESCALATION_REASON_CODES)[number];

/**
 * Reason strings are CODES, never prose, and this is where that is enforced
 * rather than merely intended.
 *
 * The store's "no customer content" guarantee was previously carried only by a
 * column-name scan — which proves no column is NAMED for content, and proves
 * nothing about what a caller puts in a free-text `reason`. A caller could pass
 * the customer's message, the model's answer or an attachment filename by
 * accident, and it would be written to the audit table and survive there.
 *
 * A code matching this pattern cannot contain a space, a quote, an @, a slash
 * or any punctuation prose needs, and is capped at 64 characters. Every reason
 * the gateway actually passes is already of this shape: the failure outcomes in
 * `FAILURE_EXPLANATIONS`, the handoff `NoTextClassification.reason` values and
 * the escalation reason codes.
 */
export const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

/** Thrown rather than silently truncating: a reason that is not a code is a
 *  programming error at the call site, and the safe thing is to refuse to write
 *  it at all rather than to write a redacted version that looks deliberate. */
export class ReasonNotACodeError extends Error {
  constructor() {
    super(
      "ownership reason must be a lower-case code matching " +
        String(REASON_CODE_PATTERN) +
        " — free text is refused because this value is persisted to the audit trail",
    );
    this.name = "ReasonNotACodeError";
  }
}

export function assertReasonCode(value: string): string {
  if (!isReasonCode(value)) throw new ReasonNotACodeError();
  return value;
}

export function isOwnershipState(value: unknown): value is OwnershipState {
  return typeof value === "string" && (OWNERSHIP_STATES as readonly string[]).includes(value);
}

export function isEscalationReasonCode(value: unknown): value is EscalationReasonCode {
  return (
    typeof value === "string" && (ESCALATION_REASON_CODES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** True only for states that permit an invocation for a customer turn. */
export function mayInvokeAi(state: OwnershipState): boolean {
  return AI_AUTHORITY_STATES.has(state);
}

/** The inverse, named for the thing call sites actually assert. */
export function suppressesAutomatedReply(state: OwnershipState): boolean {
  return !mayInvokeAi(state);
}

/**
 * The complete legal transition graph. Anything absent is illegal and is
 * refused by `src/ownership-store.ts` rather than silently applied.
 *
 * Note what is NOT here: there is no edge from any HUMAN state to an AI state
 * other than `HANDING_BACK -> AI_RESUMED`. That single edge is reachable only
 * after an explicit authorized handback AND successful reconciliation.
 * Resolution has no edge at all.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<OwnershipState, readonly OwnershipState[]>> = {
  AI_OWNED: ["HUMAN_REQUESTED", "HUMAN_OWNED"],
  AI_RESUMED: ["AI_OWNED", "HUMAN_REQUESTED", "HUMAN_OWNED"],
  HUMAN_REQUESTED: ["HUMAN_OWNED", "HANDING_BACK"],
  HUMAN_OWNED: ["HANDING_BACK"],
  // Reconciliation succeeded -> AI_RESUMED. Reconciliation failed ->
  // HUMAN_OWNED. There is no third outcome, and in particular no outcome in
  // which a failed reconciliation leaves the AI in charge.
  HANDING_BACK: ["AI_RESUMED", "HUMAN_OWNED"],
};

export function canTransition(from: OwnershipState, to: OwnershipState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Fail-closed read of a persisted state string.
 *
 * A row written by an older deploy, a hand-edited row, or a state string this
 * build does not know about all resolve to `HUMAN_OWNED`. The cost of that is a
 * conversation that waits for a person; the cost of failing open is an
 * automated reply into a conversation a human owns, which is the exact class of
 * defect this module exists to make impossible.
 */
export function readState(raw: unknown): OwnershipState {
  return isOwnershipState(raw) ? raw : "HUMAN_OWNED";
}

/** Episodes are non-negative integers. Anything else reads as 0, which is the
 *  value that makes an `expectedEpisode` check refuse rather than match. */
export function readEpisode(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.trunc(raw));
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isSafeInteger(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Conversation identity
// ---------------------------------------------------------------------------

/**
 * The stable identity of one Chatwoot conversation, as a single text key.
 *
 * WHY A DERIVED KEY RATHER THAN A COMPOSITE ONE
 *   The ratified constraint is `UNIQUE (tenant_id, conversation_id,
 *   operation_id)`. Foundation satisfies it with a cuid primary key on its own
 *   `Conversation` table. This service has no such table and must not invent a
 *   second registry of conversations, so the identity is derived from the
 *   routing identifiers it already holds — the same idiom `bindingIdentity` in
 *   `src/deliveryref.ts` already uses for bindings.
 *
 * WHAT IS AND IS NOT IN IT
 *   `accountId` and the conversation's DISPLAY id. Chatwoot's `display_id` is
 *   unique per account, so the pair identifies the conversation exactly, and it
 *   is the value the conversation API paths expect — see the note on
 *   `conversationDisplayId` in `src/webhook.ts`. The tenant is deliberately NOT
 *   folded in: it is a separate column so tenant isolation is a predicate the
 *   database can enforce and an auditor can read, not something hidden inside
 *   an opaque string.
 *
 *   The inbox is NOT in the key. An inbox move must not orphan a conversation's
 *   ownership history and hand a live human conversation back to the AI under a
 *   fresh key.
 *
 * Contains no customer content and no secret.
 */
export function conversationKey(accountId: number, conversationDisplayId: number): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new RangeError("conversationKey: accountId must be a positive integer");
  }
  if (!Number.isSafeInteger(conversationDisplayId) || conversationDisplayId <= 0) {
    throw new RangeError("conversationKey: conversationDisplayId must be a positive integer");
  }
  return `cw:${accountId}:${conversationDisplayId}`;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** The conversation a transition applies to, in this service's own identifiers. */
export interface ConversationRef {
  /** Resolved from the binding, NEVER read from the webhook payload. */
  tenantId: string;
  chatwootAccountId: number;
  /** Chatwoot's `display_id` — see `conversationKey` above. */
  chatwootConversationId: number;
  chatwootInboxId?: number | null;
  bindingId?: string | null;
}

export interface OwnershipView {
  state: OwnershipState;
  episode: number;
  handoverAckEpisode: number | null;
  /**
   * The operation id that opened the CURRENT episode of human involvement.
   *
   * Read so a resumed delivery can tell "a human holds this because MY OWN
   * earlier attempt recorded it, and I still owe Chatwoot the writes" apart
   * from "a different human genuinely took this over". Without that distinction
   * a resumed delivery either abandons its own half-finished handover or talks
   * over somebody else, and there is no third option.
   */
  escalationOperationId: string | null;
  /**
   * True when the stored state string was not one this build recognises and was
   * therefore failed closed to HUMAN_OWNED. A divergence must silence the AI,
   * never license it — and it must be VISIBLE, because that silence is
   * otherwise indistinguishable from a legitimate human hold.
   */
  diverged: boolean;
}

export type TransitionStatus =
  /** Claimed and applied by THIS call. Side effects belong here and nowhere else. */
  | "applied"
  /** This exact operation was already claimed. Nothing changed. Not an error. */
  | "duplicate"
  /** The caller named an episode that is no longer current. Refused. */
  | "stale_episode"
  /** Not in a state from which this transition is legal. Refused. */
  | "illegal_transition";

export interface TransitionOutcome {
  /** True for `applied` and `duplicate` — the intent holds. False means refused. */
  ok: boolean;
  status: TransitionStatus;
  /** The state AFTER this call. Unchanged when not applied. */
  state: OwnershipState;
  episode: number;
  operationId: string;
  /**
   * Which mechanism produced a `duplicate`.
   *
   *   `replay`     — the pre-check found the operation already recorded; a
   *                  retried delivery arriving after the original finished.
   *   `constraint` — the INSERT was rejected by the unique index. A concurrent
   *                  writer won the race.
   *
   * Recorded because "the database rejected it" and "we noticed and did not
   * try" are different facts, and an audit that cannot tell them apart cannot
   * show the constraint is doing any work.
   */
  duplicateSource: "replay" | "constraint" | null;
}

/**
 * THE PORT the reply path depends on.
 *
 * Narrow on purpose. `src/pipeline.ts` must not import a database driver, a
 * connection or any SQL — it takes this interface, exactly as it already takes
 * `ChatwootApi`, `AgentRuntime` and `Ledger`. The Postgres implementation is
 * `createPostgresOwnershipGate` in `src/ownership-store.ts`; the unit suite
 * supplies an in-memory one.
 *
 * Every method is failure-visible rather than failure-silent: an implementation
 * that cannot reach its store must REJECT, so the caller fails closed. A gate
 * that returns AI_OWNED when it does not know is a gate that licenses the bot
 * to answer a conversation a human is holding.
 */
export interface OwnershipGate {
  /** Current authority. Never throws for "no row" — a conversation with no
   *  history is AI_OWNED, which is a fact and not an absence. */
  read(ref: ConversationRef): Promise<OwnershipView>;

  /** Accepted escalation -> HUMAN_REQUESTED, opening a new episode. */
  requestHuman(input: {
    conversation: ConversationRef;
    operationId: string;
    reason: string;
    actorRef?: string | null;
    correlationId?: string | null;
  }): Promise<TransitionOutcome>;

  /**
   * Claim the right to send ONE handover acknowledgement for one episode.
   *
   * True means THIS caller may send. The claim is a conditional UPDATE whose
   * ROW COUNT is the answer, so two DIFFERENT deliveries racing cannot both get
   * true — one greeting per handover, not one per delivery.
   *
   * `claimantRef` identifies the delivery holding the claim, and re-claiming
   * with the SAME ref succeeds. That is not a loophole, it is the point: a
   * delivery whose acknowledgement failed to send is retried by the recovery
   * sweeper, and a claim it could not re-enter would mean the customer is
   * greeted ZERO times rather than once. Cross-delivery exclusion is preserved
   * because a different delivery presents a different ref. At-most-once for the
   * same delivery is already guaranteed a layer down, by the per-delivery write
   * guard, which also reconciles an ambiguous send rather than repeating it.
   */
  claimAck(ref: ConversationRef, episode: number, claimantRef: string): Promise<boolean>;

  /**
   * RECONCILIATION, not part of the reply path's own decision.
   *
   * def-handback-sweeper-is-blind-to-manually-assigned-conversations-2026-09-13:
   * a conversation assigned directly in Chatwoot ("Assign to me"), outside
   * requestHumanOwnership/confirmHumanOwnership, leaves NO row here — reads
   * default to AI_OWNED, which is correct for a conversation with no history
   * but wrong once a human has quietly started holding it. This method is
   * how that gets noticed and recorded, from signals the gateway ALREADY
   * receives (conversation_updated/conversation_status_changed on its
   * existing Agent Bot endpoint) but previously discarded.
   *
   * Called from the webhook handler ALONGSIDE evaluateSuppression, never
   * inside it and never gating it — the live reply decision this turn must
   * be byte-identical whether this call succeeds, no-ops, or throws. Its
   * caller is expected to swallow any rejection.
   *
   * Returns null (and writes nothing) when there is nothing to reconcile:
   * no assignee present, or the conversation is resolved — resolve is a
   * terminal state this must never reopen (see recordResolution's own doc
   * comment on the identical principle for the escalation-driven path).
   */
  reconcileObservedAssignment(input: {
    conversation: ConversationRef;
    /** Stable per delivery, so a Chatwoot redelivery of the same event is a
     *  no-op rather than a second write. */
    operationId: string;
    /** Whether Chatwoot's payload currently shows a human assignee present. */
    hasAssignee: boolean;
    /** Chatwoot's raw conversation status string from the payload, or null
     *  when absent/unreadable. Only 'resolved' is checked; anything else
     *  (open, pending, snoozed, unknown, null) is treated as reconcilable. */
    status: string | null;
  }): Promise<TransitionOutcome | null>;
}
