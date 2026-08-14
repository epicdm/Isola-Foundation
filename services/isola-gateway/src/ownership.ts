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
