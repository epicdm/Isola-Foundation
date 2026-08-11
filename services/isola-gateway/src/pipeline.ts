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
import type { ChatwootApi, ChatwootTarget } from "./chatwoot.js";
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
import { DELIVERY_ACTION, type LedgerIdentity } from "./deliveryref.js";
import type { Ledger } from "./ledger.js";
import type { Logger } from "./log.js";
import type { AgentRuntime } from "./runtime.js";
import type { NoTextClassification, WebhookPayload } from "./webhook.js";
import {
  runGuardedWrite,
  sendGuardedMessage,
  type SendOutcome,
  type WriteContext,
  type WriteDeps,
} from "./writes.js";

export type DeliveryOutcome =
  /** The customer received the AI answer. */
  | "replied"
  /** No customer message was sent; a human now owns the conversation. */
  | "escalated"
  /** No usable text: the conversation was handed to a human and acknowledged. */
  | "handed_off"
  /** The handoff itself failed. NOTHING was said to the customer. */
  | "handoff_blocked";

/**
 * `answer` invokes the model. `handoff` never does — not once, not to describe
 * the attachment, not to summarise anything.
 */
export type DeliveryMode = "answer" | "handoff";

/** The runtime outcome recorded on a path that deliberately never called it. */
export const RUNTIME_NOT_INVOKED = "not_invoked";

/**
 * Write names for the per-delivery idempotency guard. One constant per write so
 * a rename cannot silently create a second, unguarded write.
 */
const WRITE = {
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
  reply_failed: "the answer could not be delivered to the customer",
  reply_unresolved:
    "the answer may or may not have reached the customer and could not be reconciled; nothing was re-sent",
});

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
}): string {
  return [
    "**Isola AI could not answer this conversation.**",
    "",
    `- failure: \`${args.outcome}\``,
    `- what that means: ${explainFailure(args.outcome)}`,
    `- correlation id: \`${args.correlationId}\``,
    `- tenant: \`${args.tenantId}\``,
    "",
    "No message was sent to the customer. The conversation has been moved to **open** so a human can take over.",
  ].join("\n");
}

/** The run context handed to isola-runtime. Carries the message; never logged. */
export function buildRuntimeContext(
  binding: Binding,
  payload: WebhookPayload,
): Record<string, unknown> {
  return {
    source: "chatwoot",
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
  /** display_id, already known to be non-null by the suppression predicate. */
  conversationId: number;
  startedAtMs: number;
  mode: DeliveryMode;
  /** Present iff `mode === "handoff"`. */
  classification: NoTextClassification | null;
}

export interface PipelineDeps {
  config: GatewayConfig;
  chatwoot: ChatwootApi;
  runtime: AgentRuntime;
  logger: Logger;
  /** The same durable ledger the webhook path reserved the delivery in. */
  ledger: Ledger;
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

export async function processDelivery(
  deps: PipelineDeps,
  job: DeliveryJob,
): Promise<DeliveryResult> {
  const { binding, payload, correlationId } = job;
  const target: ChatwootTarget = {
    accountId: binding.chatwootAccountId,
    conversationId: job.conversationId,
    accessToken: binding.agentBotAccessToken,
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
    try {
      await deps.ledger.complete(job.identity, DELIVERY_ACTION, null);
    } catch (err) {
      // The work is done; only the bookkeeping failed. The recovery sweeper
      // will find the row, reconcile every write as already-present and close
      // it out without sending anything again.
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

  // No usable text: hand over to a human, and never call the model.
  if (job.mode === "handoff") {
    const handoff = await processHandoff(deps, job, target, writeDeps, writes, base);
    await finish(handoff.outcome);
    return handoff;
  }

  // Chatwoot retries the same delivery id, so reusing it as the run id makes
  // the runtime call idempotent across those retries too.
  const runId = job.deliveryId ?? correlationId;

  const result = await deps.runtime.invoke({
    templateId: binding.templateId,
    exposure: "PUBLIC",
    agentId: binding.paperclipAgentId,
    runId,
    context: buildRuntimeContext(binding, payload),
  });

  // `result.outcome` has already been derived from the runtime's structured
  // `completionState` where it supplied one (see src/runtime.ts), so
  // `persistence_failed` arrives here as itself and not as `provider_error`.
  //
  // The contract violation. `outcome: ok` with no text is NOT an empty answer.
  const failureOutcome =
    result.outcome !== "ok"
      ? result.outcome
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
      await escalate(deps, job, target, writeDeps, writes, "reply_failed");
      await finish("reply_failed");
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
  await escalate(deps, job, target, writeDeps, writes, failureOutcome);
  await finish(failureOutcome);
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

  // ---- 1. open -----------------------------------------------------------
  try {
    await runGuardedWrite(writeDeps, writes, WRITE.handoffStatus, () =>
      deps.chatwoot.openConversation(target),
    );
  } catch (err) {
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
      // The conversation stays open — that half succeeded and undoing it would
      // only hide the problem from the human who has to pick this up.
      return blockHandoff(deps, job, target, writeDeps, writes, context, classification, teamId, {
        failedStep: "assignment",
        detail: err instanceof Error ? err.message : "unknown chatwoot failure",
      });
    }
  }

  // ---- 3. AI suppression is now the existing predicate's job. -------------

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
  const acknowledgement = customerAcknowledgement(classification.reason);
  const ack = await sendGuardedMessage(
    writeDeps,
    writes,
    WRITE.handoffAck,
    target,
    acknowledgement,
    false,
  );

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
async function escalate(
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

  const note = renderFailureNote({
    outcome,
    correlationId: job.correlationId,
    tenantId: job.binding.tenantId,
  });

  const posted: SendOutcome = await sendGuardedMessage(
    writeDeps,
    writes,
    WRITE.failureNote,
    target,
    note,
    true,
  );
  if (posted.kind === "failed" || posted.kind === "ambiguous") {
    deps.logger.error({
      ...base,
      event: "escalate",
      outcome: "private_note_failed",
      detail: posted.detail,
    });
  }

  try {
    await runGuardedWrite(writeDeps, writes, WRITE.escalateStatus, () =>
      deps.chatwoot.openConversation(target),
    );
  } catch (err) {
    deps.logger.error({
      ...base,
      event: "escalate",
      outcome: "toggle_status_failed",
      detail: err instanceof Error ? err.message : "unknown chatwoot failure",
    });
  }

  const teamId = job.binding.escalationTeamId;
  if (teamId !== undefined) {
    try {
      await runGuardedWrite(writeDeps, writes, WRITE.escalateAssignment, () =>
        deps.chatwoot.assignTeam(target, teamId),
      );
    } catch (err) {
      deps.logger.error({
        ...base,
        event: "escalate",
        outcome: "assignment_failed",
        teamId,
        detail: err instanceof Error ? err.message : "unknown chatwoot failure",
      });
    }
  }

  deps.logger.warn({ ...base, event: "escalate", outcome: "escalated", failure: outcome });
  await annotate(deps, job, target, writeDeps, writes, outcome);
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
