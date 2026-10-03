/**
 * The asynchronous half: everything that happens AFTER the webhook has been
 * acknowledged.
 *
 * Chatwoot's webhook open/read timeout is 5 seconds (GlobalConfig
 * WEBHOOK_TIMEOUT, default 5, confirmed live as 5). Nothing in this module may
 * ever run on the webhook request path. The handler ACKs first and then calls
 * `processDelivery`.
 *
 * Three invariants:
 *  1. A customer-facing message is sent ONLY when the runtime returned real
 *     answer text, OR when a human handoff has actually been recorded. Every
 *     failure path posts a PRIVATE note and escalates.
 *  2. No reply is ever invented. `runtime_no_text` is treated as a failure, not
 *     as an empty answer.
 *  3. The gateway never claims something happened that did not. If the handoff
 *     could not be recorded, the customer is told nothing at all.
 */
import type { Binding } from "./bindings.js";
import {
  coherentChannelSubject,
  resolveCustomerScope,
  type CustomerScopeResolver,
  type CustomerScopeVerdict,
} from "./customer-scope.js";
import { readTurnHistory } from "./turns.js";
import { detectHumanPromise } from "./promise.js";
import type { ChatwootApi, ChatwootTarget, ConversationHistory } from "./chatwoot.js";
import {
  filterApprovedAttributes,
  filterApprovedLabels,
  mergeCustomAttributes,
  mergeLabels,
} from "./chatwoot.js";
import { approvedLabels, type GatewayConfig } from "./config.js";
import {
  customerAcknowledgement,
  renderHandoffBlockedNote,
  renderHandoffNote,
  type HandoffFailedStep,
} from "./handoff.js";
import { DELIVERY_ACTION, deliveryRef, type LedgerIdentity } from "./deliveryref.js";
import type { Failpoint } from "./failpoint.js";
import type { Ledger, SqlClient } from "./ledger.js";
import type { Logger } from "./log.js";
import { turnIdempotencyKey } from "./idempotency.js";
import { isAgentEscalationReason, type AgentRuntime } from "./runtime.js";
import {
  isReasonCode,
  suppressesAutomatedReply,
  type ConversationRef,
  type OwnershipGate,
} from "./ownership.js";
import type { NoTextClassification, WebhookPayload } from "./webhook.js";
import {
  runGuardedWrite,
  sendGuardedMessage,
  type SendOutcome,
  type WriteContext,
  type WriteDeps,
  WriteFencedError,
} from "./writes.js";

export type DeliveryOutcome =
  /** The customer received the AI answer. */
  | "replied"
  /** No customer message was sent; a human now owns the conversation. */
  | "escalated"
  /** No usable text: the conversation was handed to a human and acknowledged. */
  | "handed_off"
  /** The handoff itself failed. NOTHING was said to the customer. */
  | "handoff_blocked"
  /**
   * The DURABLE ownership store says a human holds this conversation, so the
   * model was never called and nothing was sent.
   *
   * Distinct from `escalated`, which is this delivery HANDING the conversation
   * over. This is a delivery arriving at a conversation somebody already holds.
   */
  | "human_owned"
  /**
   * A human took (or took and returned) the conversation WHILE the model was
   * running. The answer was composed for a conversation that has since moved on,
   * so nothing was sent and no business write fired. Distinct from `human_owned`,
   * where the model was never called: here it was, and its output was discarded.
   */
  | "suppressed_in_flight"
  /**
   * The sender could not be resolved to a verified customer (or to a prospect),
   * so the model was never called and nothing AI-composed was sent. A human was
   * shown the conversation. See `src/customer-scope.ts`.
   */
  | "customer_scope_unresolved";

/**
 * `answer` invokes the model. `handoff` never does — not once, not to describe
 * the attachment, not to summarise anything.
 */
export type DeliveryMode = "answer" | "handoff";

/** The runtime outcome recorded on a path that deliberately never called it. */
export const RUNTIME_NOT_INVOKED = "not_invoked";

/**
 * A delivery that stopped because a person took the conversation, or because its turn
 * budget ran out: nothing further was written. A spent budget leaves the row open; once
 * the lease expires the recovery sweeper takes it and ESCALATES it to a person once
 * (src/recovery-escalation.ts). It does not re-run the turn (Codex R5/R6). A person who
 * holds the conversation needs no retry.
 */
function suppressedResult(writes: WriteContext, runtimeOutcome: string = RUNTIME_NOT_INVOKED): DeliveryResult {
  return {
    outcome: "suppressed_in_flight",
    runtimeOutcome,
    customerMessageSent: false,
    escalated: false,
    handoffBlocked: false,
    needsRetry: writes.authority?.deadlineExceeded === true,
  };
}

const TURN_TIMEOUT = Symbol("turn_timeout");

/**
 * The value, or `TURN_TIMEOUT` when the turn budget runs out first. A rejection propagates.
 *
 * A promise that RESOLVES after the deadline is a timeout too (Codex R3 F1): the timer
 * only fires if the event loop gets there first, and a value that completes after the
 * budget -- an ownership read, a runtime result -- must not be admitted just because it
 * beat the timer callback. `expired` is asked at the moment of resolution.
 */
function raceTurn<T>(
  promise: Promise<T>,
  remainingMs: number,
  expired: () => boolean,
): Promise<T | typeof TURN_TIMEOUT> {
  if (remainingMs <= 0) return Promise.resolve(TURN_TIMEOUT);
  return new Promise<T | typeof TURN_TIMEOUT>((resolve, reject) => {
    const timer = setTimeout(() => resolve(TURN_TIMEOUT), remainingMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(expired() ? TURN_TIMEOUT : value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Write names for the per-delivery idempotency guard. One constant per write so
 * a rename cannot silently create a second, unguarded write.
 */
export const WRITE = {
  reply: "reply",
  failureNote: "failure_note",
  escalateStatus: "escalate_toggle_status",
  escalateAssignment: "escalate_assignment",
  handoffStatus: "handoff_toggle_status",
  handoffAssignment: "handoff_assignment",
  handoffNote: "handoff_note",
  handoffAck: "handoff_customer_message",
  labels: "labels",
  customAttributes: "custom_attributes",
} as const;

/**
 * Why a delivery failed. `runtime_no_text` is the contract violation described
 * in `src/runtime.ts`: the runtime reported success but returned no text.
 */
export const FAILURE_EXPLANATIONS: Readonly<Record<string, string>> = Object.freeze({
  runtime_no_text:
    "the AI runtime reported success but returned no answer text, which violates the inline response contract",
  // The runtime asked for an action this build does not implement. The answer
  // was withheld rather than sent, because it may describe the very action that
  // was requested and would tell the customer something happened that did not.
  runtime_action_unrecognised:
    "the AI runtime requested an action this gateway does not implement; the answer was withheld rather than sent without performing it",
  budget_exhausted: "the AI employee's monthly budget is fully committed; the model was not called",
  provider_error: "the model provider returned an error",
  model_timeout: "the model provider did not answer inside the deadline",
  // Distinct from provider_error on purpose. The model DID answer; Paperclip
  // refused the write-back, so the answer was never persisted and must not be
  // sent. Both escalate, but an operator needs to know which one happened.
  persistence_failed:
    "the model answered, but Paperclip would not accept the write-back, so the answer was not persisted and was withheld",
  invalid_output: "the model provider answered with no usable assistant text",
  duplicate_in_flight:
    "a duplicate of a run that is still executing; the original run owns the answer",
  rejected:
    "the AI runtime refused this invocation before calling the model, for a reason other than budget",
  exposure_mismatch:
    "the AI runtime refused this invocation: the credential is not authorised for this template's exposure class",
  unauthorized: "the AI runtime rejected this gateway's credential",
  runtime_unreachable: "the AI runtime could not be reached",
  runtime_error: "the AI runtime returned an unexpected error",
  customer_scope_unresolved:
    "the sender could not be matched to exactly one verified customer account; the model was not called and no customer data was looked up",
  reply_failed: "the answer could not be delivered to the customer",
  reply_unresolved:
    "the answer may or may not have reached the customer and could not be reconciled; nothing was re-sent",
  // Written by RECOVERY (src/recovery-escalation.ts), never by the live pipeline: a delivery that
  // was interrupted could not be proven complete. The gateway does not resume it; a person does.
  recovery_escalated:
    "this conversation was interrupted (a restart or a timeout) before the gateway could confirm it was finished; the gateway did not resume it and re-sent nothing",
  // The direct Hermes path (src/hermes-runtime.ts). None of these ever sent model text to the customer.
  hermes_config_defect:
    "the public Hermes runtime could not be asked (a credential, address or request defect); nothing was sent to the customer and no retry was made",
  hermes_create_uncertain:
    "starting the AI run failed in a way that leaves it unknown whether a run exists; it was not started again and nothing was sent",
  hermes_duplicate_invoke:
    "this message had already started an AI run; a second run was refused so the customer cannot be answered twice",
  hermes_rate_limited:
    "the AI runtime was at its concurrency limit and was still at it after one retry",
  hermes_busy:
    "no AI run slot became free inside the deadline (another turn for this conversation, or the runtime's cap); nothing was started",
  hermes_history_unavailable:
    "the conversation transcript could not be built or did not contain the message being answered; the AI does not answer without it",
  hermes_run_failed: "the AI run ended in an error",
  hermes_run_cancelled: "the AI run was cancelled before it produced an answer",
  hermes_run_lost:
    "the AI runtime no longer knows this run (it restarted, or the run expired); the run was not started again",
  hermes_run_mismatch:
    "the AI runtime answered about a different run than the one this turn started; that answer was not used",
  hermes_stream_closed_early:
    "the AI run's event stream ended without saying how the run finished; no answer was used",
  hermes_response_too_large:
    "a response from the AI runtime exceeded the size limit; the run was stopped",
  hermes_envelope_invalid:
    "the AI answered, but not in the required one-line format, so none of its text was sent to the customer",
  hermes_envelope_text_too_long:
    "the AI's reply was longer than the allowed length and was not sent",
  hermes_ownership_lost:
    "a person took the conversation while the AI was working; the run was stopped and its answer discarded",
});

/** What the note says about opening the conversation: an intention and a way to check, never a past fact. */
const OPENING_SENTENCE = (who: string): string =>
  `The gateway is moving the conversation to **open** so ${who} can take over; if it is still **pending** when you read this, that step failed, so please open it yourself.`;

export function explainFailure(outcome: string): string {
  return FAILURE_EXPLANATIONS[outcome] ?? "the AI runtime did not produce a usable answer";
}

/**
 * The private note left for the human who picks the conversation up.
 *
 * Deliberately contains no customer content and no correlation with anything
 * secret — a private note is still stored in Chatwoot and read by staff.
 */
export function renderFailureNote(args: {
  outcome: string;
  correlationId: string;
  tenantId: string;
  /**
   * The customer WAS sent a reply before this escalation (the agent asked for a colleague after
   * answering). The note must say so: telling a colleague that nothing was sent to a customer who
   * was answered is a false statement about what happened (Codex R5).
   */
  customerAnswered?: boolean;
}): string {
  return [
    args.customerAnswered === true
      ? "**Isola AI replied to the customer and asked for a colleague.**"
      : "**Isola AI could not answer this conversation.**",
    "",
    `- failure: \`${args.outcome}\``,
    `- what that means: ${explainFailure(args.outcome)}`,
    `- correlation id: \`${args.correlationId}\``,
    `- tenant: \`${args.tenantId}\``,
    "",
    // The note is posted BEFORE the opening is attempted, and the opening can fail, so it never says
    // the conversation WAS opened (Codex R6): it says what the gateway is doing and how to tell.
    // Where the send is UNCERTAIN (recovery, or a reply that could not be reconciled) it never says
    // "no message was sent" either.
    args.outcome === "recovery_escalated" || args.outcome === "reply_unresolved"
      ? `The customer may or may not have received an AI reply, and the gateway has NOT re-sent anything. Please read the conversation and answer if it needs an answer. ${OPENING_SENTENCE("a human")}`
      : args.customerAnswered === true
        ? `The AI replied to the customer (a reply WAS sent) and then asked for a human. ${OPENING_SENTENCE("a colleague")} Please read the reply before answering.`
        : `No message was sent to the customer. ${OPENING_SENTENCE("a human")}`,
  ].join("\n");
}

/** The run context handed to isola-runtime. Carries the message; never logged. */
export function buildRuntimeContext(
  binding: Binding,
  payload: WebhookPayload,
  history?: ConversationHistory,
  customerScope?: CustomerScopeVerdict,
): Record<string, unknown> {
  return {
    source: "chatwoot",
    // The server-resolved customer scope, or ABSENT when no resolver is
    // configured (today's behaviour). Never copied from `customAttributes` or the
    // message — those stay below as untrusted event data.
    ...(customerScope === undefined ? {} : { customerScope }),
    tenantId: binding.tenantId,
    companyId: binding.paperclipCompanyId,
    chatwoot: {
      accountId: payload.accountId,
      inboxId: payload.inboxId,
      conversationDisplayId: payload.conversationDisplayId,
      conversationStatus: payload.conversationStatus,
      messageId: payload.messageId,
      customAttributes: payload.customAttributes,
    },
    // PRIOR TURNS. Absent until 2026-08-17: the model saw ONE message and
    // nothing before it, so it greeted a customer mid-thread as a stranger and
    // re-asked for details it had just been given. Measured as
    // `contextOriginalBytes` FLAT across eight turns of one conversation.
    // Excludes private notes by construction — see `readConversationHistory`.
    ...(history === undefined
      ? {}
      : { history: history.turns, historyTruncated: history.truncated }),
    message: {
      role: "customer",
      content: payload.content ?? "",
    },
  };
}

export interface DeliveryJob {
  correlationId: string;
  deliveryId: string | null;
  /**
   * The atomic key this delivery was reserved under, in the durable ledger.
   * Every write below is claimed beneath it, so a duplicate cannot produce a
   * second note, a second assignment or a second customer message — and that
   * now holds ACROSS a container replacement, not only within one process.
   */
  identity: LedgerIdentity;
  /** sha256 of the raw signed body, as reserved. Carried onto every write row. */
  digest: string;
  binding: Binding;
  payload: WebhookPayload;
  /**
   * True when the recovery sweeper is re-running a delivery a previous attempt
   * acknowledged and did not finish. Such a delivery may already have recorded
   * its own ownership hold, so the gate must not close it out — see the note at
   * the gate in processDelivery.
   */
  resumed?: boolean;
  /** display_id, already known to be non-null by the suppression predicate. */
  conversationId: number;
  startedAtMs: number;
  mode: DeliveryMode;
  /** Present iff `mode === "handoff"`. */
  classification: NoTextClassification | null;
}

export interface PipelineDeps {
  /** Conversation memory. Absent = the gateway answers exactly as it did before. */
  turnStore?: SqlClient;
  /**
   * True when the transcript of this conversation is KNOWN to be missing a staff reply that could
   * not be recorded (Step A+). The history is then treated as ABSENT, so the direct Hermes path
   * answers nothing and escalates once instead of answering without what the person told the
   * customer. Absent = no conversation is ever marked (the previous behaviour).
   */
  historyGap?: (accountId: number, conversationId: number) => boolean;
  config: GatewayConfig;
  chatwoot: ChatwootApi;
  runtime: AgentRuntime;
  logger: Logger;
  /** The same durable ledger the webhook path reserved the delivery in. */
  ledger: Ledger;
  /**
   * The durable answer to "may the AI speak in this conversation".
   *
   * A PORT, not a database. This module must never import a driver, a
   * connection or any SQL — exactly as it never imports one for Chatwoot or the
   * runtime. Production supplies `createPostgresOwnershipGate`; the unit suite
   * supplies an in-memory double.
   */
  ownership: OwnershipGate;
  /**
   * Server-side customer-scope resolution (see `src/customer-scope.ts`). Absent
   * means the gateway behaves exactly as it did before the seam existed. Applied
   * to PUBLIC bindings only: an INTERNAL line is staff, gated by its allowlist.
   */
  customerScope?: CustomerScopeResolver;
  /** Test-only; `DISARMED` in every production deployment. */
  failpoint: Failpoint;
  now: () => number;
}

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  runtimeOutcome: string;
  customerMessageSent: boolean;
  escalated: boolean;
  /** True when the handoff could not be recorded and the customer was told nothing. */
  handoffBlocked: boolean;
  /** True when an operator has to pick this up by hand. Surfaced for retry. */
  needsRetry: boolean;
}

/**
 * The conversation's ownership identity, built ONLY from the resolved binding
 * and the delivery's own identifiers — never from the webhook body. A caller
 * cannot address another tenant's ownership rows by crafting a payload, for the
 * same reason and by the same mechanism as `bindingIdentity` in
 * `src/deliveryref.ts`.
 */
function conversationRefOf(job: DeliveryJob): ConversationRef {
  return {
    tenantId: job.binding.tenantId,
    chatwootAccountId: job.binding.chatwootAccountId,
    chatwootConversationId: job.conversationId,
    chatwootInboxId: job.binding.chatwootInboxId,
    bindingId: job.identity.bindingId,
  };
}

/** Annotation writes: published best-effort after a reply or an escalation. */
const ANNOTATION_ACTIONS: readonly string[] = [WRITE.labels, WRITE.customAttributes];

/**
 * Raised when a conversation could not be durably marked as human-held.
 *
 * It propagates out of `processDelivery`, so the delivery is left with an open
 * lease and the recovery sweeper retries it. That is the correct failure: the
 * customer has been told nothing, Chatwoot shows nothing, and nothing is
 * inconsistent — as opposed to publishing a handover the store does not know
 * about, which is silently wrong and stays wrong.
 */
export class OwnershipHoldFailedError extends Error {
  readonly status: string;
  constructor(status: string) {
    super(`could not establish a durable human hold: ${status}`);
    this.name = "OwnershipHoldFailedError";
    this.status = status;
  }
}

/**
 * Move the conversation to a human-authority state, or throw.
 *
 * Succeeds when the RESULTING state suppresses the AI. That is deliberately the
 * test rather than `status === "applied"`, because three different outcomes all
 * mean "a human holds this conversation and the bot is silent":
 *
 *   applied              — this call moved it.
 *   duplicate            — a redelivery; the original moved it.
 *   illegal_transition   — it is ALREADY in a human state, which is exactly
 *                          where this was trying to put it.
 *
 * Only a genuine failure — the store unreachable, or a refusal that leaves the
 * conversation in an AI state — is fatal.
 */
async function establishHumanHold(
  deps: PipelineDeps,
  job: DeliveryJob,
  base: Record<string, unknown>,
  args: {
    operationId: string;
    reason: string;
    actorRef: string;
    alertCode: string;
    /** The episode this delivery started under (Codex R3 F5); null = unknown, no precondition. */
    expectedEpisode?: number | null;
  },
): Promise<{ state: string; episode: number; stale?: true }> {
  let transition;
  try {
    transition = await deps.ownership.requestHuman({
      conversation: conversationRefOf(job),
      operationId: args.operationId,
      reason: args.reason,
      actorRef: args.actorRef,
      correlationId: job.correlationId,
      expectedEpisode: args.expectedEpisode ?? null,
    });
  } catch (err) {
    deps.logger.error({
      ...base,
      event: "ownership",
      alert: true,
      alertCode: args.alertCode,
      outcome: "not_recorded",
      detail: err instanceof Error ? err.name : "unknown ownership failure",
    });
    throw new OwnershipHoldFailedError("store_unavailable");
  }

  // The conversation moved to a NEWER episode after this delivery read it (a person took
  // it and handed it back). NOT a failure and NOT a hold of ours: report it so the caller
  // stops, and never adopt whatever episode is there now (Codex R3 F5).
  if (transition.status === "stale_episode") {
    deps.logger.warn({
      ...base,
      event: "ownership",
      outcome: "stale_episode",
      ownershipState: transition.state,
      episode: transition.episode,
      expectedEpisode: args.expectedEpisode ?? null,
      detail:
        "the conversation moved to a newer ownership episode before this delivery could record its hold; no hold was opened and none will be adopted",
    });
    return { state: transition.state, episode: transition.episode, stale: true };
  }

  if (!suppressesAutomatedReply(transition.state)) {
    deps.logger.error({
      ...base,
      event: "ownership",
      alert: true,
      alertCode: args.alertCode,
      outcome: "not_recorded",
      transitionStatus: transition.status,
      ownershipState: transition.state,
      detail:
        "the conversation is still in an AI-authority state, so nothing will be published to Chatwoot",
    });
    throw new OwnershipHoldFailedError(transition.status);
  }

  deps.logger.info({
    ...base,
    event: "ownership",
    outcome: transition.status,
    ownershipState: transition.state,
    episode: transition.episode,
    duplicateSource: transition.duplicateSource,
  });
  return { state: transition.state, episode: transition.episode };
}

/**
 * The conversation is held by a PERSON (it moved after this delivery decided to write):
 * latch the fence so nothing further is written, say so once, and report the
 * conversation as visibly with a human, which is what it is.
 */
function stopForPerson(
  deps: PipelineDeps,
  writes: WriteContext,
  base: Record<string, unknown>,
  stage: string,
  held: { state: string; episode: number },
): true {
  if (writes.authority !== undefined) writes.authority.fenced = true;
  deps.logger.warn({
    ...base,
    event: "ownership",
    outcome: "suppressed_in_flight",
    stage,
    ownershipState: held.state,
    episode: held.episode,
    customerMessageSent: false,
    detail:
      "a person holds this conversation; the remaining writes of this delivery were not made",
  });
  return true;
}

export async function processDelivery(
  deps: PipelineDeps,
  job: DeliveryJob,
): Promise<DeliveryResult> {
  const { binding, payload, correlationId } = job;
  // THE TURN BUDGET (Codex R2/R5) is CONTAINMENT, NOT A GUARANTEE. What it enforces: every
  // Chatwoot request carries the remaining budget and ends at it; the write fence
  // (`writes.fence`) refuses a Chatwoot write, and `escalate()` refuses to record its hold,
  // once the deadline has passed; an ownership read or a runtime result that has not arrived
  // by it is a timeout; `finish()` refuses to complete the row after it. What it does NOT
  // enforce: the handoff path records its ownership hold without a deadline check; a durable
  // write already in flight at the deadline can still commit; `ledger.complete()` carries no
  // owner or lease predicate; and a live handler can overlap a recovery handler after the
  // lease expires (Codex F2/F3, open by design). Do NOT read this budget as proof that no
  // durable mutation starts after the deadline, or that no other worker has begun. The budget
  // is sized at boot to end before the ledger lease does.
  const turnDeadlineAt = job.startedAtMs + deps.config.turnBudgetMs;
  const turnExpired = (): boolean => deps.now() >= turnDeadlineAt;
  const target: ChatwootTarget = {
    accountId: binding.chatwootAccountId,
    conversationId: job.conversationId,
    accessToken: binding.agentBotAccessToken,
    // The tenant's own Chatwoot, when the binding names one.
    ...(binding.chatwootBaseUrl === undefined ? {} : { baseUrl: binding.chatwootBaseUrl }),
    // Every Chatwoot request of this turn ends at the turn deadline (Codex R2).
    remainingMs: () => Math.max(0, turnDeadlineAt - deps.now()),
  };

  const base = {
    correlationId,
    deliveryId: job.deliveryId,
    accountId: binding.chatwootAccountId,
    inboxId: binding.chatwootInboxId,
    conversationId: job.conversationId,
    tenantId: binding.tenantId,
  };

  const writeDeps: WriteDeps = {
    chatwoot: deps.chatwoot,
    ledger: deps.ledger,
    logger: deps.logger,
    leaseMs: deps.config.ledgerLeaseMs,
    failpoint: deps.failpoint,
  };
  const writes: WriteContext = {
    identity: job.identity,
    digest: job.digest,
    correlationId: job.correlationId,
    // The inbound message is the reconciliation pivot: anything at or before it
    // predates any reply we could have sent for this delivery.
    pivotMessageId: job.payload.messageId,
    base,
  };

  const finish = async (outcome: string): Promise<void> => {
    // A late completion is REJECTED (Codex R2). After the turn budget this worker may no
    // longer be the one that owns the delivery: the lease is about to expire, the sweeper
    // will take the row (to close it if the ledger proves it complete, otherwise to escalate
    // it once to a person), and closing it here would take a delivery from the worker that is
    // handling it (or hide that this one never finished). This is containment, not
    // exclusivity: a live handler can still overlap the sweeper (open, F2/F3).
    if (turnExpired() || writes.authority?.deadlineExceeded === true) {
      deps.logger.error({
        ...base,
        event: "delivery",
        alert: true,
        alertCode: "turn_budget_exhausted_completion_rejected",
        outcome,
        detail:
          "the turn budget was spent before this delivery could be closed; the row is left open for the worker that resumes it after the lease expires",
      });
      return;
    }
    try {
      await deps.ledger.complete(job.identity, DELIVERY_ACTION, null);
    } catch (err) {
      // The work is done; only the bookkeeping failed. The recovery sweeper will find the
      // row: if the ledger proves the delivery complete it closes it, otherwise it escalates
      // it once to a person. It never re-runs the turn and never sends anything again.
      deps.logger.error({
        ...base,
        event: "delivery",
        alert: true,
        alertCode: "ledger_close_failed",
        outcome,
        detail: err instanceof Error ? err.message : "unknown ledger failure",
      });
    }
  };

  // ---- THE OWNERSHIP GATE -------------------------------------------------
  //
  // The durable answer to "may the AI speak here", consulted BEFORE the model
  // is invoked and before the handoff path can post anything.
  //
  // This is the authority `evaluateSuppression` cannot carry. That predicate
  // reads Chatwoot's UI state — status is `pending`, nobody is assigned — which
  // is a snapshot with no episode and no memory. An agent who resolves a ticket
  // for housekeeping, or an automation rule that moves it back to `pending`,
  // silently returns the microphone to the bot. The store remembers; the
  // snapshot cannot.
  //
  // WHY THIS IS SAFE TO SHIP BEFORE ANYTHING WRITES TRANSITIONS
  //   A conversation with no row reads as AI_OWNED — a fact, not an absence.
  //   So against an empty store this gate suppresses NOTHING and behaviour is
  //   bit-for-bit what it is today. It only ever adds suppression, and only
  //   once a transition has actually been recorded.
  //
  // FAIL CLOSED
  //   An unreachable store REJECTS rather than returning a default. Treating
  //   "I could not find out" as AI_OWNED would let the bot answer a
  //   conversation a human is holding, and it would look identical in the logs
  //   to a healthy read. The delivery is already durably reserved, so failing
  //   here loses nothing: the lease expires and the recovery sweeper retries.
  const ownership = await deps.ownership.read(conversationRefOf(job));

  if (ownership.diverged) {
    // The stored state was not a value this build recognises. It has been
    // failed closed to HUMAN_OWNED, which is correct and also invisible unless
    // it is said out loud.
    deps.logger.error({
      ...base,
      event: "ownership",
      alert: true,
      alertCode: "ownership_state_unreadable",
      outcome: "failed_closed_to_human_owned",
      episode: ownership.episode,
    });
  }

  // NOTE (Codex R6, comment only): since round 5 NO production caller sets `job.resumed`: the
  // recovery sweeper no longer re-runs a delivery through this pipeline, it escalates it
  // (src/recovery-escalation.ts). The exemption below is kept because the tests pin it; in
  // production `finishingOwnWork` is always false.
  //
  // A resumed delivery is exempt from the short-circuit ONLY when it is the one
  // that recorded the hold, and the hold has not moved on since.
  //
  // The gate answers "may the AI speak", and a human hold means no. But a
  // resumed delivery may be the one that RECORDED that hold and then died
  // before finishing the Chatwoot writes — the hold is established before them,
  // deliberately. Short-circuiting THAT would close the delivery for good and
  // leave the conversation suppressed for the AI and invisible to any human:
  // nobody answers, which is the worst outcome available.
  //
  // Exempting every resumed delivery is far too wide, though: a delivery that
  // stalled while a real person took the conversation over would come back and
  // talk straight over them. So the exemption is narrowed by two facts read
  // from the store:
  //
  //   1. the current episode was opened by THIS delivery's own operation id;
  //   2. the state is still HUMAN_REQUESTED — nobody has actually replied. Once
  //      it is HUMAN_OWNED a person is really there, and a stale "I passed this
  //      to a team member" acknowledgement would be both late and wrong.
  //
  // Re-running under those conditions is safe: the ownership transition is
  // keyed on this delivery's operation id, every Chatwoot write is claimed
  // under this delivery's ledger key and reconciled, and the acknowledgement is
  // claimed per episode with this delivery as the claimant.
  const ownsCurrentHold =
    ownership.state === "HUMAN_REQUESTED" &&
    ownership.escalationOperationId !== null &&
    (ownership.escalationOperationId === `escalate:${job.identity.eventId}` ||
      ownership.escalationOperationId === `handoff:${job.identity.eventId}`);

  const finishingOwnWork = job.resumed === true && ownsCurrentHold;

  if (finishingOwnWork) {
    deps.logger.warn({
      ...base,
      event: "ownership",
      outcome: "resuming_own_handover",
      ownershipState: ownership.state,
      episode: ownership.episode,
      detail:
        "this delivery recorded the human hold and did not finish publishing it; completing its own writes rather than closing out",
    });
  }

  if (!finishingOwnWork && suppressesAutomatedReply(ownership.state)) {
    deps.logger.info({
      ...base,
      event: "ownership",
      outcome: "human_owned",
      ownershipState: ownership.state,
      episode: ownership.episode,
      detail: "a human holds this conversation; the model was not called and nothing was sent",
    });
    await finish("human_owned");
    return {
      outcome: "human_owned",
      runtimeOutcome: RUNTIME_NOT_INVOKED,
      customerMessageSent: false,
      escalated: false,
      handoffBlocked: false,
      needsRetry: false,
    };
  }

  // The ONE predicate for "the AI still has authority over this conversation",
  // used by the rechecks (after the customer scope, before the runtime, after the
  // model) AND handed to a long-running runtime so it can stop early on a takeover.
  // Same state, same episode, same rule.
  const ownershipStillMine = (read: Awaited<ReturnType<typeof deps.ownership.read>>): boolean =>
    !read.diverged &&
    read.episode === ownership.episode &&
    (finishingOwnWork
      ? read.state === ownership.state &&
        read.escalationOperationId === ownership.escalationOperationId
      : !suppressesAutomatedReply(read.state));

  // THE WRITE FENCE (Codex R3). One ownership read is only as fresh as the last
  // await: history, the model, a ledger claim, a reconciliation and every Chatwoot
  // call each age it, and a reply plus its annotations is up to five HTTP operations
  // (an escalation up to seven). So the fence is asked IMMEDIATELY BEFORE the runtime
  // call and before EACH write (writes.ts calls it after the claim and any
  // reconciliation, right before the wire).
  //   - While the AI has the conversation the question is "is it still AI-authorised,
  //     in the episode this delivery started under" (`ownershipStillMine`).
  //   - Once THIS delivery has recorded a human hold (`authority.heldEpisode`) the
  //     question is "is it still our unanswered hold": same episode and still
  //     HUMAN_REQUESTED. A person who replied or took it moves it to HUMAN_OWNED, and
  //     the remaining note / status / assignment / labels / attributes must not follow
  //     them (an assignment would overwrite the person who just took it).
  // After one denial the fence latches: this delivery writes nothing more.
  // A rejected read propagates (nothing written, the sweeper retries): "I could not
  // find out who holds this" is never "nobody does".
  const authority: NonNullable<WriteContext["authority"]> = {
    heldEpisode: null,
    fenced: false,
    deadlineExceeded: false,
    episodeAtStart: ownership.episode,
  };
  writes.authority = authority;
  writes.turnExpired = turnExpired;
  // The turn budget closes the fence for good: the one place every wire write passes
  // through also refuses at/after the deadline, and an ownership read that does not
  // return before it is a denial (fail closed), never an indefinite wait.
  const budgetSpent = (stage: string): false => {
    authority.fenced = true;
    authority.deadlineExceeded = true;
    deps.logger.error({
      ...base,
      event: "delivery",
      alert: true,
      alertCode: "turn_budget_exhausted",
      outcome: "turn_budget_exhausted",
      stage,
      customerMessageSent: false,
      detail:
        "the turn budget was spent before this write; it and every later write of this delivery were not made, and the row is left open for the worker that resumes it after the lease expires",
    });
    return false;
  };
  writes.fence = async (stage: string): Promise<boolean> => {
    if (authority.fenced) return false;
    if (turnExpired()) return budgetSpent(stage);
    const raced = await raceTurn(deps.ownership.read(conversationRefOf(job)), turnDeadlineAt - deps.now(), turnExpired);
    if (raced === TURN_TIMEOUT) return budgetSpent(stage);
    const read = raced;
    const mine =
      authority.heldEpisode === null
        ? ownershipStillMine(read)
        : !read.diverged && read.episode === authority.heldEpisode && read.state === "HUMAN_REQUESTED";
    if (mine) return true;
    authority.fenced = true;
    deps.logger.warn({
      ...base,
      event: "ownership",
      outcome: "suppressed_in_flight",
      stage,
      ownershipState: read.state,
      episode: read.episode,
      episodeAtStart: ownership.episode,
      heldEpisode: authority.heldEpisode,
      customerMessageSent: false,
      detail:
        "ownership moved before this write; it and every later write of this delivery were not made",
    });
    return false;
  };

  // No usable text: hand over to a human, and never call the model.
  if (job.mode === "handoff") {
    const handoff = await processHandoff(deps, job, target, writeDeps, writes, base);
    // DO NOT close the ledger row when the handoff did not land.
    //
    // The ownership store now suppresses the AI the moment the transfer is
    // recorded, which happens BEFORE the Chatwoot writes. So a handoff that
    // records the hold and then fails to open or assign the conversation leaves
    // the worst possible state: the bot will not answer, and no human has been
    // shown the conversation either. Nobody replies.
    //
    // Leaving the row open lets its lease expire so the recovery sweeper
    // retries the whole handoff. Every write beneath it is claimed under this
    // delivery's ledger key and reconciled, so the retry cannot produce a
    // second note or a second acknowledgement.
    if (handoff.needsRetry) {
      deps.logger.error({
        ...base,
        event: "handoff",
        alert: true,
        alertCode: "handoff_left_open_for_recovery",
        outcome: handoff.outcome,
        detail:
          "the conversation is suppressed for the AI but the handoff did not complete; the delivery is left unfinished so the sweeper retries it",
      });
      return handoff;
    }
    await finish(handoff.outcome);
    return handoff;
  }

  // (`ownershipStillMine` and the write fence are defined above the handoff branch.)

  // ---- THE CUSTOMER SCOPE ---------------------------------------------------
  //
  // WHICH customer is this? Resolved here, server-side, from the signed sender
  // identity only — never from `customAttributes`, the message text or the
  // model. Consulted AFTER the ownership gate (a human-held conversation needs no
  // lookup) and BEFORE the model, so an unresolved sender costs no model call.
  //
  // FAIL CLOSED. `unresolved` — and a resolver that rejects, which
  // `resolveCustomerScope` reports as unresolved — never becomes `anonymous`:
  // the model is not called, nothing AI-composed is sent, and a human is shown
  // the conversation through the ordinary escalation path. An `anonymous`
  // prospect IS answered; failing closed must not mean refusing everyone.
  let customerScope: CustomerScopeVerdict | undefined;
  if (deps.customerScope !== undefined && binding.exposure === "PUBLIC") {
    const resolved = await resolveCustomerScope(deps.customerScope, {
      tenantId: binding.tenantId,
      chatwootAccountId: binding.chatwootAccountId,
      chatwootInboxId: binding.chatwootInboxId,
      chatwootConversationId: job.conversationId,
      channelSubject: coherentChannelSubject({
        channelSubject: payload.channelSubject,
        senderType: payload.senderType,
        senderId: payload.senderId ?? null,
        contactInboxContactId: payload.contactInboxContactId ?? null,
        contactInboxInboxId: payload.contactInboxInboxId ?? null,
        routedInboxId: binding.chatwootInboxId,
      }),
    });

    // OWNERSHIP MAY HAVE MOVED WHILE THE RESOLVER RAN (Codex D5). The gate above is
    // older than this lookup, and the unresolved branch below WRITES (a note, a
    // status change, an assignment) before the post-run recheck can see anything.
    // So ownership is read again here, before either branch acts: a conversation a
    // person took in the meantime gets no escalation writes and no model call. Same
    // predicate, same fail-closed read as the post-run recheck (a rejected read
    // propagates: nothing is written and the sweeper retries).
    const afterScope = await deps.ownership.read(conversationRefOf(job));
    if (!ownershipStillMine(afterScope)) {
      deps.logger.warn({
        ...base,
        event: "ownership",
        outcome: "suppressed_in_flight",
        stage: "customer_scope",
        ownershipState: afterScope.state,
        episode: afterScope.episode,
        episodeAtStart: ownership.episode,
        scopeVerdict: resolved.verdict.kind,
        customerMessageSent: false,
        detail:
          "ownership changed while the customer scope was being resolved; no escalation write was made, the model was not called and nothing was sent",
      });
      await finish("suppressed_in_flight");
      return {
        outcome: "suppressed_in_flight",
        runtimeOutcome: RUNTIME_NOT_INVOKED,
        customerMessageSent: false,
        escalated: false,
        handoffBlocked: false,
        needsRetry: false,
      };
    }

    if (resolved.verdict.kind === "unresolved") {
      deps.logger.error({
        ...base,
        event: "customer_scope",
        alert: true,
        alertCode: "customer_scope_unresolved",
        outcome: "customer_scope_unresolved",
        unresolvedReason: resolved.reason,
        customerMessageSent: false,
        durationMs: deps.now() - job.startedAtMs,
        detail:
          "the sender could not be resolved to a verified customer; the model was not called and nothing was sent to the customer",
      });
      const visible = await escalate(
        deps,
        job,
        target,
        writeDeps,
        writes,
        "customer_scope_unresolved",
      );
      // Not closed when the escalation never became visible: the AI is suppressed
      // and no human has been shown the conversation, so the sweeper must retry.
      if (visible) await finish("customer_scope_unresolved");
      return {
        outcome: "customer_scope_unresolved",
        runtimeOutcome: RUNTIME_NOT_INVOKED,
        customerMessageSent: false,
        escalated: true,
        handoffBlocked: false,
        needsRetry: !visible,
      };
    }
    customerScope = resolved.verdict;
  }

  // Chatwoot retries the same delivery id, so reusing it as the run id makes
  // the runtime call idempotent across those retries too.
  const runId = job.deliveryId ?? correlationId;

  // PRIOR TURNS, from the conversation record Chatwoot already gives us.
  // DEGRADES, NEVER FAILS: an unreadable conversation costs the model its
  // memory of this thread, which is exactly today's behaviour — it must never
  // cost the customer their reply. (conversations#show is also the call that
  // 500s once a team is assigned on some builds, so this WILL fail sometimes.)
  // MEMORY, from the gateway's OWN ledger — not from Chatwoot.
  // conversations#show returns one message, and the messages index 401s an
  // AgentBot token (both measured 2026-08-17). The gateway already sees every
  // turn, so it records them and reads them back here.
  let history: ConversationHistory | undefined;
  const knownHole = deps.historyGap?.(binding.chatwootAccountId, job.conversationId) === true;
  if (knownHole) {
    // A staff reply could not be recorded: the stored thread is NOT the thread the customer sees.
    deps.logger.warn({
      ...base,
      event: "context",
      outcome: "history_gap_unrecorded_staff_turn",
    });
  }
  if (deps.turnStore !== undefined && !knownHole) {
    try {
      const h = await readTurnHistory(
        deps.turnStore,
        binding.chatwootAccountId,
        job.conversationId,
      );
      history = { turns: h.turns, messageIds: h.messageIds, truncated: h.truncated };
    } catch (err) {
      deps.logger.warn({
        ...base,
        event: "context",
        outcome: "history_unavailable",
        detail: err instanceof Error ? err.message : "turn store read failed",
      });
    }
  }

  // OBSERVABILITY, and it is not decoration. A history of ZERO turns and a
  // working history were indistinguishable in the logs, so a fetch that
  // silently returned nothing survived an entire live test looking green.
  // If a state cannot be observed from outside, the process must declare it.
  deps.logger.info({
    ...base,
    event: "context",
    outcome: history === undefined ? "history_absent" : "history_built",
    historyMessageCount: history?.turns.length ?? 0,
    historyTruncated: history?.truncated ?? false,
  });

  // The runtime call is itself a mutation when the runtime is Paperclip (it creates an
  // issue and wakes an employee), and the history read above can have taken a while
  // (Codex R3: a takeover during readTurnHistory() still reached the runtime).
  if (!(await writes.fence?.("runtime_invoke") ?? true)) {
    await finish("suppressed_in_flight");
    return suppressedResult(writes);
  }

  // ONE abort signal for the whole runtime call (Codex R3 F1): fired the moment the turn
  // budget is spent, so a runtime stops starting requests and aborts the one in flight.
  // Discarding a late result is not cancelling the work that produced it.
  const turnAbort = new AbortController();
  const invoked = deps.runtime.invoke({
    templateId: binding.templateId,
    // THE BINDING'S exposure, not a constant. A hardcoded "PUBLIC" here made
    // every INTERNAL invocation fail closed with 403 exposure_mismatch — see
    // the note on AgentRuntimeRequest.exposure in runtime.ts.
    exposure: binding.exposure,
    agentId: binding.paperclipAgentId,
    runId,
    context: buildRuntimeContext(binding, payload, history, customerScope),
    idempotencyKey: turnIdempotencyKey(job.identity, job.mode),
    ...(history?.messageIds === undefined ? {} : { historyMessageIds: history.messageIds }),
    isStillOwned: async () => ownershipStillMine(await deps.ownership.read(conversationRefOf(job))),
    signal: turnAbort.signal,
  });
  // The runtime call is raced against the turn deadline: a runtime that never returns
  // (or returns after the budget) must not hold the turn open past the lease. Giving up
  // is "no answer" and the row stays open for the recovery sweeper to escalate; the abandoned
  // call is allowed to finish on its own and its result is discarded.
  const ran = await raceTurn(invoked, turnDeadlineAt - deps.now(), turnExpired);
  if (ran === TURN_TIMEOUT) {
    invoked.catch(() => undefined);
    turnAbort.abort();
    budgetSpent("runtime_result");
    return suppressedResult(writes, "model_timeout");
  }
  const result = ran;

  // ---- THE IN-FLIGHT OWNERSHIP RECHECK ------------------------------------
  //
  // The gate above answered "may the AI speak" BEFORE the model ran. The model
  // can run for up to the runtime deadline (90 s), and a human can take the
  // conversation in that window. Writing the reply on the strength of a read
  // that old talks over them, and the escalation / annotation writes that
  // follow would mutate a conversation a person now holds.
  //
  // So ownership is read AGAIN, here: after the runtime has returned and before
  // ANYTHING is written — the reply, an escalation (status, assignment, note),
  // a failure note, a label or an attribute. Two things must still hold:
  //   1. the state still gives the AI authority (or this delivery is finishing
  //      the very hold it recorded, unchanged); and
  //   2. the EPISODE is the one the run started under. A human who took the
  //      conversation and handed it back leaves the state AI-authorised again
  //      with a later episode — the answer was still composed for a
  //      conversation that has moved on, so state alone is not enough.
  //
  // FAIL CLOSED. If this read rejects, the rejection propagates exactly as the
  // pre-run gate's does: nothing is written, the row is left unfinished, the
  // lease expires and the recovery sweeper re-runs the delivery (whose own
  // pre-run gate and this recheck then decide with a fresh read). "I could not
  // find out who holds this" is never treated as "nobody does".
  //
  // RESIDUAL WINDOW, stated rather than hidden: this is a read then a write, not
  // a compare-and-set inside the Chatwoot write. A takeover landing in the few
  // milliseconds between this read and the post cannot be caught here; it is
  // narrowed from "the whole model run" to "one network round trip".
  const recheck = await deps.ownership.read(conversationRefOf(job));
  const stillMine = ownershipStillMine(recheck);

  if (!stillMine) {
    deps.logger.warn({
      ...base,
      event: "ownership",
      outcome: "suppressed_in_flight",
      ownershipState: recheck.state,
      episode: recheck.episode,
      episodeAtStart: ownership.episode,
      runtimeOutcome: result.outcome,
      runtimeCorrelationId: result.correlationId,
      customerMessageSent: false,
      detail:
        "ownership changed while the model was running; the answer was discarded and nothing was written to the customer or to Chatwoot",
    });
    // Closed (unless the turn budget is spent), not left to the sweeper: a retry would re-run the model into a
    // conversation a human holds. The delivery row is the ONLY ledger row — no
    // write was claimed, so there is nothing for reconciliation to resend.
    await finish("suppressed_in_flight");
    return {
      outcome: "suppressed_in_flight",
      runtimeOutcome: result.outcome,
      customerMessageSent: false,
      escalated: false,
      handoffBlocked: false,
      needsRetry: false,
    };
  }

  // `result.outcome` has already been derived from the runtime's structured
  // `completionState` where it supplied one (see src/runtime.ts), so
  // `persistence_failed` arrives here as itself and not as `provider_error`.
  //
  // The contract violation. `outcome: ok` with no text is NOT an empty answer.
  //
  // AN ACTION THIS BUILD CANNOT PERFORM IS A FAILURE, NOT A REPLY.
  //
  // The runtime asked for something this gateway does not implement. Sending
  // the answer and quietly doing nothing is the dangerous option, because the
  // answer may describe the very thing that was requested — "I've arranged a
  // callback for you" — and the customer would be told an action happened that
  // did not. Fail closed: no customer message, and a human is shown the
  // conversation. Same treatment as no usable text, for the same reason.
  const failureOutcome =
    result.outcome !== "ok"
      ? result.outcome
      : result.actionUnrecognised
        ? "runtime_action_unrecognised"
        : result.text === null || result.text.trim().length === 0
          ? "runtime_no_text"
          : null;

  if (failureOutcome === null) {
    const answer = result.text as string;
    const sent = await sendGuardedMessage(
      writeDeps,
      writes,
      WRITE.reply,
      target,
      answer,
      false,
    );

    if (sent.kind === "fenced") {
      // Ownership moved between the post-run recheck and the wire (the claim and any
      // reconciliation sit in between). Nothing was sent and the fence has said so.
      await finish("suppressed_in_flight");
      return suppressedResult(writes, result.outcome);
    }

    if (sent.kind === "failed") {
      deps.logger.error({
        ...base,
        event: "reply",
        outcome: "reply_failed",
        runtimeOutcome: result.outcome,
        runtimeCompletionState: result.completionState,
        runtimeCorrelationId: result.correlationId,
        durationMs: deps.now() - job.startedAtMs,
        detail: sent.detail,
      });
      const visible = await escalate(deps, job, target, writeDeps, writes, "reply_failed");
      if (visible) await finish("reply_failed");
      return {
        outcome: "escalated",
        runtimeOutcome: "reply_failed",
        customerMessageSent: false,
        escalated: true,
        handoffBlocked: false,
        needsRetry: false,
      };
    }

    if (sent.kind === "ambiguous") {
      // Fail CLOSED. The answer may already be with the customer, so it is not
      // re-sent and no second acknowledgement is invented. The alert has
      // already been raised by `sendGuardedMessage`; the conversation is opened
      // so a human can look at it.
      deps.logger.error({
        ...base,
        event: "reply",
        outcome: "reply_unresolved",
        runtimeOutcome: result.outcome,
        runtimeCompletionState: result.completionState,
        runtimeCorrelationId: result.correlationId,
        customerMessageSent: false,
        needsRetry: true,
        durationMs: deps.now() - job.startedAtMs,
        detail: sent.detail,
      });
      // This branch already declines to finish, below.
      await escalate(deps, job, target, writeDeps, writes, "reply_unresolved");
      // Deliberately NOT completed: the ledger row stays claimed so a later
      // sweep can reconcile it once Chatwoot is answering again.
      return {
        outcome: "escalated",
        runtimeOutcome: "reply_unresolved",
        customerMessageSent: false,
        escalated: true,
        handoffBlocked: false,
        needsRetry: true,
      };
    }

    const alreadyPresent = sent.kind === "already_present" || sent.kind === "skipped";

    // THE AGENT PROMISED A HUMAN. Honour it.
    // The reply is already with the customer — escalating AFTER the send is
    // deliberate: the promise has been made, so the worst outcome is a promise
    // nobody hears. Escalating before the send would risk the reverse.
    // ---- WHO DECIDES THE ESCALATION ---------------------------------------
    //
    // STRUCTURED METADATA WINS, ALWAYS AND EXCLUSIVELY.
    //
    // When the runtime returned an action, that action IS the decision and the
    // reply text is never inspected. This is what closes the defect: the same
    // intent phrased two ways — "a colleague will…" and "I'll bring in a
    // colleague" — used to produce an escalation and a silence respectively,
    // because the wording was the signal. Now the field is the signal and the
    // wording is free.
    //
    // The heuristic is consulted ONLY when the runtime said nothing at all
    // (`action === null`): an older runtime, or a template that does not emit
    // actions. That is the rollback path, and it is also why the two mechanisms
    // can never both fire — they are the two arms of one branch, not two
    // checks in sequence.
    //
    // `action === "reply"` is a POSITIVE statement that no human is needed, so
    // it suppresses the heuristic too. Falling through to phrase matching there
    // would let wording override the agent's own explicit decision, which is
    // the defect in the other direction.
    const structuredAction = result.action;
    const usingStructuredAction = structuredAction !== null;
    const heuristicEnabled = deps.config.escalationPhraseHeuristic;

    const promise =
      usingStructuredAction || !heuristicEnabled
        ? { promised: false, matched: [] as string[], deferred: undefined }
        : detectHumanPromise(answer);

    const escalateForHuman = usingStructuredAction
      ? structuredAction === "request_human"
      : promise.promised;

    // The reason written to the ownership audit trail. A structured escalation
    // carries the agent's own bounded code; the heuristic path keeps the code
    // it has always used. Neither is ever free text — `ownership.ts` throws on
    // a non-code, and the runtime client has already refused anything that does
    // not match the code shape.
    //
    // VALIDATED HERE, not merely at the HTTP boundary. This is the component
    // that hands the value to the ownership ledger, and the ledger persists it
    // to an audit table — so this is where the guarantee has to be made. The
    // HTTP client checks the same set, but any other `AgentRuntime`
    // implementation bypasses it, and a code-shaped string like
    // `card_4111111111111111` would satisfy `ownership.ts`'s pattern and be
    // written verbatim. Anything outside the ratified seven degrades to the
    // default code rather than travelling. Adversarial review, 2026-08-25.
    const escalationReason =
      usingStructuredAction && structuredAction === "request_human"
        ? isAgentEscalationReason(result.actionReason)
          ? result.actionReason
          : "explicit_human_request"
        : "agent_requested_human";

    // A DEFERRAL IS NOT A NON-EVENT. The reply named a human but the AI is still
    // asking the customer something, so handing over now would suppress the
    // answer it just asked for. Logged, because a deferral nobody can see is the
    // same silent skip that let the handback sweeper strand a customer for nine
    // hours — and because repeated deferrals with no commitment is exactly the
    // shape of "a promise nobody was told about" reappearing.
    if (promise.deferred !== undefined) {
      deps.logger.info({
        ...base,
        event: "promise",
        outcome: "escalation_deferred",
        matchedPhrases: promise.matched,
        reason: promise.deferred,
        detail:
          "the reply named a human but is still asking the customer; the AI keeps the " +
          "conversation so the answer is not suppressed",
      });
    }
    if (escalateForHuman) {
      deps.logger.info({
        ...base,
        event: "promise",
        outcome: "human_promised",
        // WHICH MECHANISM DECIDED. Without this the two paths are
        // indistinguishable in the log, and "is the structured contract
        // actually working in staging?" becomes an investigation instead of a
        // log read.
        escalationSource: usingStructuredAction ? "structured_action" : "phrase_heuristic",
        agentAction: structuredAction,
        escalationReason,
        matchedPhrases: promise.matched,
        detail: usingStructuredAction
          ? "the agent asked for a human in its structured action; escalating"
          : "the reply promised a human; escalating so someone is actually told",
      });
      const visible = await escalate(
        deps,
        job,
        target,
        writeDeps,
        writes,
        escalationReason,
        // The reply was sent (or was already there) before this escalation.
        { customerAnswered: true },
      );
      await annotate(deps, job, target, writeDeps, writes, "escalated");
      deps.logger.info({
        ...base,
        event: "delivery",
        outcome: "replied_and_escalated",
        runtimeOutcome: result.outcome,
        runtimeCorrelationId: result.correlationId,
        answerChars: answer.length,
        messagePostedNow: sent.kind === "sent",
        chatwootMessageId: sent.kind === "skipped" ? null : sent.messageId,
        escalationVisible: visible,
        escalationSource: usingStructuredAction ? "structured_action" : "phrase_heuristic",
        agentAction: structuredAction,
        escalationReason,
        matchedPhrases: promise.matched,
        durationMs: deps.now() - job.startedAtMs,
      });
      // DO NOT COMPLETE AN INVISIBLE ESCALATION.
      // If neither the status change nor the assignment landed, ownership has
      // already suppressed the AI and Chatwoot shows nothing: the conversation
      // is owned by NOBODY. Leaving the delivery unfinished keeps the ledger row
      // claimed so the recovery sweeper retries it. This mirrors the guard the
      // failure path above already had — review 2026-08-17 found this branch
      // finishing unconditionally, which is the exact defect this work removes.
      if (visible) await finish("replied");
      return {
        outcome: "replied",
        runtimeOutcome: result.outcome,
        customerMessageSent: !alreadyPresent,
        escalated: true,
        handoffBlocked: false,
        needsRetry: !visible,
      };
    }

    await annotate(deps, job, target, writeDeps, writes, "replied");
    deps.logger.info({
      ...base,
      event: "delivery",
      outcome: "replied",
      runtimeOutcome: result.outcome,
      runtimeCompletionState: result.completionState,
      runtimeCorrelationId: result.correlationId,
      answerChars: answer.length,
      // True when this delivery physically posted the message; false when a
      // previous attempt had already posted it and reconciliation proved so.
      messagePostedNow: sent.kind === "sent",
      chatwootMessageId: sent.kind === "skipped" ? null : sent.messageId,
      durationMs: deps.now() - job.startedAtMs,
    });
    await finish("replied");
    return {
      outcome: "replied",
      runtimeOutcome: result.outcome,
      customerMessageSent: !alreadyPresent,
      escalated: false,
      handoffBlocked: false,
      needsRetry: false,
    };
  }

  deps.logger.error({
    ...base,
    event: "delivery",
    outcome: failureOutcome,
    runtimeOutcome: result.outcome,
    // The truthful end state, straight from the runtime's body. This is the
    // field that distinguishes persistence_failed from provider_error.
    runtimeCompletionState: result.completionState,
    runtimeContractVersion: result.contractVersion,
    runtimeCorrelationId: result.correlationId,
    customerMessageSent: false,
    durationMs: deps.now() - job.startedAtMs,
  });
  const escalationVisible = await escalate(deps, job, target, writeDeps, writes, failureOutcome);
  // Not closed when the escalation never became visible: the AI is suppressed
  // and no human has been shown the conversation, so the sweeper must retry.
  if (escalationVisible) await finish(failureOutcome);
  return {
    outcome: "escalated",
    runtimeOutcome: failureOutcome,
    customerMessageSent: false,
    escalated: true,
    handoffBlocked: false,
    needsRetry: false,
  };
}

// ---------------------------------------------------------------------------
// The no-usable-text handoff
// ---------------------------------------------------------------------------

/**
 * Canonical order, exactly as specified:
 *
 *   1. open the conversation
 *   2. assign the escalation team, when one is configured
 *   3. the AI is now suppressed for this conversation BY THE EXISTING
 *      PREDICATE — `status_not_pending` and `human_assigned` are evaluated
 *      before the no-text branch, so the next delivery on this conversation is
 *      suppressed rather than handed off again. No second mechanism is added,
 *      and `test/handoff.test.ts` asserts it rather than assuming it.
 *   4. exactly ONE private note, with the attachment type and count only
 *   5. and only then, exactly ONE customer-visible message
 *
 * Steps 1 and 2 are the handoff. If either fails, step 5 does not happen: the
 * customer is never told a human has it when no human has it.
 *
 * The model is not called anywhere in here, and no attachment URL is read,
 * fetched or logged.
 */
async function processHandoff(
  deps: PipelineDeps,
  job: DeliveryJob,
  target: ChatwootTarget,
  writeDeps: WriteDeps,
  writes: WriteContext,
  base: Record<string, unknown>,
): Promise<DeliveryResult> {
  // `mode === "handoff"` always carries a classification; this keeps the
  // function total rather than asserting.
  const classification: NoTextClassification = job.classification ?? {
    reason: "empty_message",
    attachmentCount: 0,
    attachmentTypes: [],
    contentType: null,
  };
  const teamId = job.binding.escalationTeamId ?? null;

  const context = {
    ...base,
    handoffReason: classification.reason,
    attachmentCount: classification.attachmentCount,
    // Closed-vocabulary types only: never a filename, never a URL.
    attachmentTypes: classification.attachmentTypes,
    contentType: classification.contentType,
    runtimeInvoked: false,
  };

  // ---- 0. SUPPRESS FIRST, AND ONLY PUBLISH IF IT HELD --------------------
  //
  // Before a single Chatwoot write. A handoff IS a transfer of response
  // authority, so it is recorded as one, and it is recorded before anything
  // observable happens — otherwise a second delivery arriving between the
  // assignment and the transition would still read AI_OWNED and answer a
  // conversation already handed over.
  //
  // THROWS if the hold could not be established, before the customer is told
  // anything. This is the same rule the four steps below already follow: a
  // handoff that cannot be completed truthfully is not announced. Here the
  // untruth would be invisible — Chatwoot would show the conversation handed
  // over while the store still licensed the bot to answer it.
  //
  // Keyed on this delivery's ledger identity, so Chatwoot's redeliveries of the
  // same webhook collapse to ONE episode rather than incrementing per retry.
  const hold = await establishHumanHold(deps, job, context, {
    operationId: `handoff:${job.identity.eventId}`,
    reason: classification.reason,
    actorRef: "gateway:handoff",
    alertCode: "ownership_transition_failed_on_handoff",
    expectedEpisode: writes.authority?.episodeAtStart ?? null,
  });

  // Same rule as `escalate` (Codex R3 F5): a newer episode is not ours to adopt.
  if (hold.stale === true) {
    stopForPerson(deps, writes, base, "handoff_hold_stale_episode", hold);
    return suppressedResult(writes);
  }

  // Same rule as `escalate`: the hold is ours only if the conversation was still the
  // AI's. A person who already has it gets none of the handoff writes.
  if (hold.state !== "HUMAN_REQUESTED") {
    stopForPerson(deps, writes, base, "handoff_hold", hold);
    return suppressedResult(writes);
  }
  if (writes.authority !== undefined) writes.authority.heldEpisode = hold.episode;

  // ---- 1. open -----------------------------------------------------------
  try {
    await runGuardedWrite(writeDeps, writes, WRITE.handoffStatus, () =>
      deps.chatwoot.openConversation(target),
    );
  } catch (err) {
    if (err instanceof WriteFencedError) return suppressedResult(writes);
    return blockHandoff(deps, job, target, writeDeps, writes, context, classification, teamId, {
      failedStep: "toggle_status",
      detail: err instanceof Error ? err.message : "unknown chatwoot failure",
    });
  }

  // ---- 2. assign ---------------------------------------------------------
  if (teamId !== null) {
    try {
      await runGuardedWrite(writeDeps, writes, WRITE.handoffAssignment, () =>
        deps.chatwoot.assignTeam(target, teamId),
      );
    } catch (err) {
      if (err instanceof WriteFencedError) return suppressedResult(writes);
      // The conversation stays open — that half succeeded and undoing it would
      // only hide the problem from the human who has to pick this up.
      return blockHandoff(deps, job, target, writeDeps, writes, context, classification, teamId, {
        failedStep: "assignment",
        detail: err instanceof Error ? err.message : "unknown chatwoot failure",
      });
    }
  }

  // ---- 3. AI suppression is now the DURABLE STORE's job. ------------------
  //
  // It was the Chatwoot-state predicate's job — an open conversation with an
  // assignee is refused by `evaluateSuppression`. That still holds and is left
  // in place, but it is no longer what carries the guarantee: it cannot survive
  // somebody resolving the ticket, and it never knew which episode it was in.
  // Step 0 above recorded the transfer; the gate in `processDelivery` reads it.

  // ---- 4. exactly one private note ---------------------------------------
  const note = renderHandoffNote({
    classification,
    correlationId: job.correlationId,
    tenantId: job.binding.tenantId,
    assignedTeamId: teamId,
  });
  const notePosted = await sendGuardedMessage(
    writeDeps,
    writes,
    WRITE.handoffNote,
    target,
    note,
    true,
  );
  if (notePosted.kind === "fenced") return suppressedResult(writes); // a person has it
  const noteRecorded = notePosted.kind !== "failed" && notePosted.kind !== "ambiguous";
  if (!noteRecorded) {
    // A missing note does not make the acknowledgement untrue — the
    // conversation IS open and assigned — so it does not block step 5. It is
    // still an operator-visible error.
    deps.logger.error({
      ...context,
      event: "handoff",
      outcome: "handoff_note_failed",
      detail: notePosted.kind === "failed" ? notePosted.detail : notePosted.detail,
    });
  }

  // ---- 5. exactly one customer-visible message ---------------------------
  //
  // "Exactly one" is scoped to the EPISODE, not to this delivery.
  //
  // The per-delivery guard below (`WRITE.handoffAck` under this delivery's
  // ledger key) stops the SAME delivery acknowledging twice. It cannot stop two
  // DIFFERENT deliveries doing it once each: two no-text messages arriving
  // together both read AI_OWNED at the gate, one moves the conversation to
  // HUMAN_REQUESTED and the other finds it already held — which
  // `establishHumanHold` correctly accepts — and then both would greet the
  // customer for one handover.
  //
  // The claim is a conditional UPDATE on `handover_ack_episode` whose ROW COUNT
  // is the answer, so exactly one of them wins it. The loser says nothing. A
  // duplicate acknowledgement is worse than the silence it replaces: it tells
  // the customer twice that a person is coming, for one person coming.
  const heldEpisode = (await deps.ownership.read(conversationRefOf(job))).episode;
  const mayAcknowledge = await deps.ownership.claimAck(
    conversationRefOf(job),
    heldEpisode,
    // The delivery IS the claimant, so its own retry re-enters the claim while a
    // different delivery cannot.
    deliveryRef(job.identity, WRITE.handoffAck),
  );
  if (!mayAcknowledge) {
    deps.logger.info({
      ...context,
      event: "handoff",
      outcome: "handoff_ack_already_claimed",
      episode: heldEpisode,
      customerMessageSent: false,
      noteRecorded,
      detail:
        "another delivery already acknowledged this handover episode; staying silent rather than greeting the customer twice",
    });
    return {
      outcome: "handed_off",
      runtimeOutcome: RUNTIME_NOT_INVOKED,
      customerMessageSent: false,
      escalated: true,
      handoffBlocked: false,
      needsRetry: false,
    };
  }

  const acknowledgement = customerAcknowledgement(classification.reason);
  const ack = await sendGuardedMessage(
    writeDeps,
    writes,
    WRITE.handoffAck,
    target,
    acknowledgement,
    false,
  );

  if (ack.kind === "fenced") return suppressedResult(writes); // a person has it; nothing was said
  if (ack.kind === "failed" || ack.kind === "ambiguous") {
    // Never re-sent blind: `sendGuardedMessage` has already reconciled, and
    // either proved the acknowledgement absent (failed) or could not resolve it
    // (ambiguous, alerted). Either way the customer is told nothing more.
    deps.logger.error({
      ...context,
      event: "handoff",
      outcome: ack.kind === "failed" ? "handoff_ack_failed" : "handoff_ack_unresolved",
      customerMessageSent: false,
      noteRecorded,
      needsRetry: true,
      durationMs: deps.now() - job.startedAtMs,
      detail: ack.detail,
    });
    await annotate(deps, job, target, writeDeps, writes, "handed_off");
    return {
      outcome: "handed_off",
      runtimeOutcome: RUNTIME_NOT_INVOKED,
      customerMessageSent: false,
      escalated: true,
      handoffBlocked: false,
      needsRetry: true,
    };
  }

  deps.logger.warn({
    ...context,
    event: "delivery",
    outcome: "handed_off",
    customerMessageSent: true,
    messagePostedNow: ack.kind === "sent",
    noteRecorded,
    assignedTeamId: teamId,
    durationMs: deps.now() - job.startedAtMs,
  });
  await annotate(deps, job, target, writeDeps, writes, "handed_off");
  return {
    outcome: "handed_off",
    runtimeOutcome: RUNTIME_NOT_INVOKED,
    customerMessageSent: ack.kind === "sent",
    escalated: true,
    handoffBlocked: false,
    needsRetry: false,
  };
}

/**
 * The handoff could not be recorded. Log at ERROR for operator alerting, post
 * the one private note saying so plainly, and send the customer NOTHING.
 */
async function blockHandoff(
  deps: PipelineDeps,
  job: DeliveryJob,
  target: ChatwootTarget,
  writeDeps: WriteDeps,
  writes: WriteContext,
  context: Record<string, unknown>,
  classification: NoTextClassification,
  teamId: number | null,
  failure: { failedStep: HandoffFailedStep; detail: string },
): Promise<DeliveryResult> {
  deps.logger.error({
    ...context,
    event: "delivery",
    outcome: "handoff_blocked",
    failedStep: failure.failedStep,
    customerMessageSent: false,
    // Surfaced so an operator can pick this conversation up by hand.
    needsRetry: true,
    durationMs: deps.now() - job.startedAtMs,
    detail: failure.detail,
  });

  const note = renderHandoffBlockedNote({
    classification,
    correlationId: job.correlationId,
    tenantId: job.binding.tenantId,
    assignedTeamId: teamId,
    failedStep: failure.failedStep,
  });
  const posted = await sendGuardedMessage(
    writeDeps,
    writes,
    WRITE.handoffNote,
    target,
    note,
    true,
  );
  if (posted.kind === "failed" || posted.kind === "ambiguous") {
    deps.logger.error({
      ...context,
      event: "handoff",
      outcome: "handoff_note_failed",
      detail: posted.detail,
    });
  }

  await annotate(deps, job, target, writeDeps, writes, "handoff_blocked");
  return {
    outcome: "handoff_blocked",
    runtimeOutcome: RUNTIME_NOT_INVOKED,
    customerMessageSent: false,
    escalated: false,
    handoffBlocked: true,
    needsRetry: true,
  };
}

/**
 * Private note, then open, then assign. Each step is independent: a failure in
 * one is logged and does not stop the next, because getting the conversation in
 * front of a human matters more than the annotations.
 */
/**
 * Returns TRUE when the conversation is now visibly with a human in Chatwoot —
 * opened, or assigned, or both. FALSE means the AI has been suppressed by the
 * ownership store and NOTHING in Chatwoot reflects that, which is the state
 * where nobody answers: the caller must not close the delivery.
 */
async function escalate(
  deps: PipelineDeps,
  job: DeliveryJob,
  target: ChatwootTarget,
  writeDeps: WriteDeps,
  writes: WriteContext,
  outcome: string,
  opts: { customerAnswered?: boolean } = {},
): Promise<boolean> {
  const base = {
    correlationId: job.correlationId,
    deliveryId: job.deliveryId,
    accountId: job.binding.chatwootAccountId,
    inboxId: job.binding.chatwootInboxId,
    conversationId: job.conversationId,
    tenantId: job.binding.tenantId,
  };

  // SUPPRESS FIRST, PUBLISH SECOND — and publish ONLY IF the suppression is
  // durable.
  //
  // The transition is recorded before any Chatwoot write, because the reverse
  // order leaves a window in which a second delivery, arriving between the
  // assignment and the transition, still reads AI_OWNED and answers a
  // conversation already handed to a person.
  //
  // And it THROWS rather than continuing if the hold could not be established.
  // That is the whole point: publishing an escalation into Chatwoot while the
  // store still says AI_OWNED produces the exact defect this engine exists to
  // prevent — a conversation that LOOKS handed over to every human reading
  // Chatwoot, while the next inbound message reads AI_OWNED and gets an
  // automated reply. Better to fail the delivery: it is already durably
  // reserved, so its lease expires and the recovery sweeper retries the whole
  // escalation, writes and all.
  //
  // The operation id is the delivery's own ledger identity, so a redelivery of
  // THIS webhook presents the same id and claims once — one escalation, one
  // note, one assignment, however many times Chatwoot retries.
  // Recording the hold is itself a durable mutation: not after the turn budget.
  if (writes.turnExpired?.() === true) {
    if (writes.authority !== undefined) {
      writes.authority.fenced = true;
      writes.authority.deadlineExceeded = true;
    }
    return true;
  }
  const hold = await establishHumanHold(deps, job, base, {
    operationId: `escalate:${job.identity.eventId}`,
    // `outcome` can originate from the runtime's response body, which is an
    // EXTERNAL string this service does not control. The store refuses free
    // text, so passing it through unchecked would let a runtime that returned
    // "Model timed out after 30s" turn every escalation into a permanent
    // failure: the hold would never be recorded, the delivery would never
    // complete, and the sweeper would retry it forever.
    //
    // Substituting a fixed code loses nothing that matters — the exact outcome
    // is already in the private note, the log line and the delivery ledger.
    reason: isReasonCode(outcome) ? outcome : "runtime_outcome_unrecognised",
    actorRef: "gateway:escalate",
    alertCode: "ownership_transition_failed_on_escalate",
    expectedEpisode: writes.authority?.episodeAtStart ?? null,
  });

  // The conversation moved to a newer episode while this delivery was working (Codex R3
  // F5): there is no hold of ours to adopt, and none of the writes below are ours to make.
  if (hold.stale === true) {
    return stopForPerson(deps, writes, base, "escalate_hold_stale_episode", hold);
  }

  // The hold can only be recorded as OUR hold if the conversation was still the AI's.
  // If a person took it between the decision to escalate and now, the store answers
  // with their state (HUMAN_OWNED): they have it, and none of the writes below are ours
  // to make (Codex R3: they used to be made regardless).
  if (hold.state !== "HUMAN_REQUESTED") {
    return stopForPerson(deps, writes, base, "escalate_hold", hold);
  }
  if (writes.authority !== undefined) writes.authority.heldEpisode = hold.episode;

  const note = renderFailureNote({
    outcome,
    correlationId: job.correlationId,
    tenantId: job.binding.tenantId,
    ...(opts.customerAnswered === true ? { customerAnswered: true } : {}),
  });

  const posted: SendOutcome = await sendGuardedMessage(
    writeDeps,
    writes,
    WRITE.failureNote,
    target,
    note,
    true,
  );
  if (posted.kind === "fenced") return true; // a person has it; the fence has said so
  if (posted.kind === "failed" || posted.kind === "ambiguous") {
    deps.logger.error({
      ...base,
      event: "escalate",
      outcome: "private_note_failed",
      detail: posted.detail,
    });
  }

  let opened = false;
  try {
    await runGuardedWrite(writeDeps, writes, WRITE.escalateStatus, () =>
      deps.chatwoot.openConversation(target),
    );
    opened = true;
  } catch (err) {
    if (err instanceof WriteFencedError) return true; // a person has it
    deps.logger.error({
      ...base,
      event: "escalate",
      outcome: "toggle_status_failed",
      detail: err instanceof Error ? err.message : "unknown chatwoot failure",
    });
  }

  let assigned = false;
  const teamId = job.binding.escalationTeamId;
  if (teamId !== undefined) {
    try {
      await runGuardedWrite(writeDeps, writes, WRITE.escalateAssignment, () =>
        deps.chatwoot.assignTeam(target, teamId),
      );
      assigned = true;
    } catch (err) {
      if (err instanceof WriteFencedError) return true; // a person has it
      deps.logger.error({
        ...base,
        event: "escalate",
        outcome: "assignment_failed",
        teamId,
        detail: err instanceof Error ? err.message : "unknown chatwoot failure",
      });
    }
  }

  const visible = opened || assigned;
  if (!visible) {
    // The ownership store has already suppressed the AI for this conversation,
    // and Chatwoot shows nothing. Neither side will answer. Say so loudly and
    // let the caller leave the delivery open for the sweeper.
    deps.logger.error({
      ...base,
      event: "escalate",
      alert: true,
      alertCode: "escalation_not_visible_to_humans",
      outcome: "escalation_invisible",
      failure: outcome,
      detail:
        "the AI is suppressed for this conversation but neither the status change nor the assignment landed in Chatwoot; nobody will answer until this is retried",
    });
  } else {
    deps.logger.warn({ ...base, event: "escalate", outcome: "escalated", failure: outcome });
  }
  await annotate(deps, job, target, writeDeps, writes, outcome);
  return visible;
}

/**
 * Labels and custom attributes, both read-modify-write because both Chatwoot
 * endpoints are full replacements.
 *
 * If the READ fails, the WRITE is skipped. Losing our own label is trivial;
 * wiping a human's labels or a tenant's custom attributes is not.
 */
async function annotate(
  deps: PipelineDeps,
  job: DeliveryJob,
  target: ChatwootTarget,
  writeDeps: WriteDeps,
  writes: WriteContext,
  outcome: string,
): Promise<void> {
  const base = {
    correlationId: job.correlationId,
    deliveryId: job.deliveryId,
    accountId: job.binding.chatwootAccountId,
    inboxId: job.binding.chatwootInboxId,
    conversationId: job.conversationId,
    tenantId: job.binding.tenantId,
  };

  if (deps.config.applyLabels) {
    const wanted =
      outcome === "replied" ? deps.config.answeredLabel : deps.config.escalatedLabel;
    const additions = filterApprovedLabels(
      wanted === null ? [] : [wanted],
      approvedLabels(deps.config, job.binding),
    );
    if (additions.length > 0) {
      let existing: string[] | null = null;
      try {
        existing = await deps.chatwoot.getLabels(target);
      } catch (err) {
        deps.logger.warn({
          ...base,
          event: "labels",
          outcome: "label_read_failed",
          detail: err instanceof Error ? err.message : "unknown chatwoot failure",
        });
      }
      if (existing !== null) {
        const merged = mergeLabels(existing, additions);
        // Nothing to do if every wanted label is already present: this endpoint
        // is a full replacement, so a no-op write is still a write.
        if (merged.length !== existing.length) {
          try {
            await runGuardedWrite(writeDeps, writes, WRITE.labels, () =>
              deps.chatwoot.setLabels(target, merged),
            );
          } catch (err) {
            if (err instanceof WriteFencedError) return; // a person has it
            deps.logger.warn({
              ...base,
              event: "labels",
              outcome: "label_write_failed",
              detail: err instanceof Error ? err.message : "unknown chatwoot failure",
            });
          }
        }
      }
    }
  }

  if (deps.config.applyCustomAttributes) {
    const additions = filterApprovedAttributes({
      isola_tenant_id: job.binding.tenantId,
      isola_agent_id: job.binding.paperclipAgentId,
      isola_last_outcome: outcome,
      isola_last_correlation_id: job.correlationId,
      isola_last_run_at: new Date(deps.now()).toISOString(),
    });
    let existing: Record<string, unknown> | null = null;
    try {
      existing = await deps.chatwoot.getCustomAttributes(target);
    } catch (err) {
      deps.logger.warn({
        ...base,
        event: "custom_attributes",
        outcome: "attribute_read_failed",
        detail: err instanceof Error ? err.message : "unknown chatwoot failure",
      });
    }
    if (existing !== null) {
      const merged = mergeCustomAttributes(existing, additions);
      try {
        await runGuardedWrite(writeDeps, writes, WRITE.customAttributes, () =>
          deps.chatwoot.setCustomAttributes(target, merged),
        );
      } catch (err) {
        if (err instanceof WriteFencedError) return; // a person has it
        deps.logger.warn({
          ...base,
          event: "custom_attributes",
          outcome: "attribute_write_failed",
          detail: err instanceof Error ? err.message : "unknown chatwoot failure",
        });
      }
    }
  }
}
