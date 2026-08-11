/**
 * The asynchronous half: everything that happens AFTER the webhook has been
 * acknowledged.
 *
 * Chatwoot's webhook open/read timeout is 5 seconds (GlobalConfig
 * WEBHOOK_TIMEOUT, default 5, confirmed live as 5). Nothing in this module may
 * ever run on the webhook request path. The handler ACKs first and then calls
 * `processDelivery`.
 *
 * Two invariants:
 *  1. A customer-facing message is sent ONLY when the runtime returned real
 *     answer text. Every failure path posts a PRIVATE note and escalates.
 *  2. No reply is ever invented. `runtime_no_text` is treated as a failure, not
 *     as an empty answer.
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
import type { Logger } from "./log.js";
import type { AgentRuntime } from "./runtime.js";
import type { WebhookPayload } from "./webhook.js";

export type DeliveryOutcome =
  /** The customer received the AI answer. */
  | "replied"
  /** No customer message was sent; a human now owns the conversation. */
  | "escalated";

/**
 * Why a delivery failed. `runtime_no_text` is the contract violation described
 * in `src/runtime.ts`: the runtime reported success but returned no text.
 */
export const FAILURE_EXPLANATIONS: Readonly<Record<string, string>> = Object.freeze({
  runtime_no_text:
    'the AI runtime reported success but returned no answer text (responseMode "inline" is not implemented upstream yet)',
  budget_exhausted: "the AI employee's monthly budget is fully committed; the model was not called",
  provider_error: "the model provider returned an error",
  model_timeout: "the model provider did not answer inside the deadline",
  exposure_mismatch:
    "the AI runtime refused this invocation: the credential is not authorised for this template's exposure class",
  unauthorized: "the AI runtime rejected this gateway's credential",
  runtime_unreachable: "the AI runtime could not be reached",
  runtime_error: "the AI runtime returned an unexpected error",
  reply_failed: "the answer could not be delivered to the customer",
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
  binding: Binding;
  payload: WebhookPayload;
  /** display_id, already known to be non-null by the suppression predicate. */
  conversationId: number;
  startedAtMs: number;
}

export interface PipelineDeps {
  config: GatewayConfig;
  chatwoot: ChatwootApi;
  runtime: AgentRuntime;
  logger: Logger;
  now: () => number;
}

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  runtimeOutcome: string;
  customerMessageSent: boolean;
  escalated: boolean;
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

  // The contract violation. `outcome: ok` with no text is NOT an empty answer.
  const failureOutcome =
    result.outcome !== "ok"
      ? result.outcome
      : result.text === null || result.text.trim().length === 0
        ? "runtime_no_text"
        : null;

  if (failureOutcome === null) {
    const answer = result.text as string;
    try {
      await deps.chatwoot.postMessage(target, answer, false);
    } catch (err) {
      // We cannot know whether the message landed, so it is never re-sent.
      deps.logger.error({
        ...base,
        event: "reply",
        outcome: "reply_failed",
        runtimeOutcome: result.outcome,
        runtimeCorrelationId: result.correlationId,
        durationMs: deps.now() - job.startedAtMs,
        detail: err instanceof Error ? err.message : "unknown chatwoot failure",
      });
      await escalate(deps, job, target, "reply_failed");
      return {
        outcome: "escalated",
        runtimeOutcome: "reply_failed",
        customerMessageSent: false,
        escalated: true,
      };
    }

    await annotate(deps, job, target, "replied");
    deps.logger.info({
      ...base,
      event: "delivery",
      outcome: "replied",
      runtimeOutcome: result.outcome,
      runtimeCorrelationId: result.correlationId,
      answerChars: answer.length,
      durationMs: deps.now() - job.startedAtMs,
    });
    return {
      outcome: "replied",
      runtimeOutcome: result.outcome,
      customerMessageSent: true,
      escalated: false,
    };
  }

  deps.logger.error({
    ...base,
    event: "delivery",
    outcome: failureOutcome,
    runtimeOutcome: result.outcome,
    runtimeCorrelationId: result.correlationId,
    customerMessageSent: false,
    durationMs: deps.now() - job.startedAtMs,
  });
  await escalate(deps, job, target, failureOutcome);
  return {
    outcome: "escalated",
    runtimeOutcome: failureOutcome,
    customerMessageSent: false,
    escalated: true,
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

  try {
    await deps.chatwoot.postMessage(target, note, true);
  } catch (err) {
    deps.logger.error({
      ...base,
      event: "escalate",
      outcome: "private_note_failed",
      detail: err instanceof Error ? err.message : "unknown chatwoot failure",
    });
  }

  try {
    await deps.chatwoot.openConversation(target);
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
      await deps.chatwoot.assignTeam(target, teamId);
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
  await annotate(deps, job, target, outcome);
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
            await deps.chatwoot.setLabels(target, merged);
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
      try {
        await deps.chatwoot.setCustomAttributes(
          target,
          mergeCustomAttributes(existing, additions),
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
