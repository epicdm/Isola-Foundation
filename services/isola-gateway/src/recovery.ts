/**
 * Restart recovery.
 *
 * A delivery is reserved in the ledger BEFORE it is acknowledged. If the
 * container dies between the ACK and the reply, the reservation survives but
 * nothing is working it — Chatwoot will never re-offer a delivery it already
 * saw acknowledged. Without this sweeper, that customer is never answered.
 *
 * The sweeper finds reservations whose lease has expired, takes them over and
 * runs the ordinary pipeline. Every write beneath them is still claimed and
 * every customer-visible message is still reconciled, so resuming a delivery
 * that was actually almost finished produces no second reply.
 *
 * WHY THE MESSAGE IS RE-READ FROM CHATWOOT
 * ----------------------------------------
 * The ledger deliberately holds no message body, so the text needed to invoke
 * the model is not in it. Rather than duplicate customer content into a second
 * store, recovery re-reads the conversation from Chatwoot, which already owns
 * it. That also means the suppression predicate is re-evaluated against the
 * CURRENT state: if a human took the conversation over while this service was
 * down, the delivery is closed out without an AI reply, which is the correct
 * outcome rather than a stale one.
 */
import { isRoutableLifecycle } from "./bindings.js";
import type { Binding, BindingStore } from "./bindings.js";
import type { ChatwootApi } from "./chatwoot.js";
import type { GatewayConfig } from "./config.js";
import type { CustomerScopeResolver } from "./customer-scope.js";
import {
  bindingIdentity,
  DELIVERY_ACTION,
  deliveryRef,
  type LedgerIdentity,
} from "./deliveryref.js";
import type { Failpoint } from "./failpoint.js";
import type { Ledger, RecoverableDelivery } from "./ledger.js";
import type { OwnershipGate } from "./ownership.js";
import type { Logger } from "./log.js";
import { processDelivery, type DeliveryJob } from "./pipeline.js";
import type { AgentRuntime } from "./runtime.js";
import {
  classifyNoText,
  evaluateSuppression,
  readAttachmentTypes,
  readContentType,
  readMessageType,
  REPLYABLE_EVENT,
  type WebhookPayload,
} from "./webhook.js";

/**
 * How many times the sweeper will re-attempt one delivery before abandoning it
 * and alerting. Chosen to span a real incident window at the default one-minute
 * lease without becoming an unbounded background loop.
 */
export const MAX_RECOVERY_ATTEMPTS = 8;

export interface RecoveryDeps {
  config: GatewayConfig;
  ledger: Ledger;
  /**
   * The same ownership gate the live path uses. A resumed delivery must be
   * subject to the identical authority check — a conversation a human took over
   * WHILE the original attempt was stalled must not be answered just because
   * the sweeper, rather than the webhook, is the one driving it.
   */
  ownership: OwnershipGate;
  /**
   * The same customer-scope resolver the live path uses (Law 21: a control on
   * one path and not the other is a moved problem). NOTE: a rebuilt payload has
   * `senderPhone: null` (see `rebuildPayload`), so with a resolver configured a
   * RESUMED delivery resolves `unresolved` and is escalated to a human rather
   * than answered — fail closed, by design, until the rebuild can carry a
   * signed sender.
   */
  customerScope?: CustomerScopeResolver;
  bindingStore: BindingStore;
  chatwoot: ChatwootApi;
  runtime: AgentRuntime;
  logger: Logger;
  /** Test-only; `DISARMED` in every production deployment. */
  failpoint: Failpoint;
  now: () => number;
}

export interface Sweeper {
  /** Run one pass. Returns how many deliveries were resumed. */
  sweep(): Promise<number>;
  start(): void;
  stop(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/**
 * Rebuild the delivery from the conversation as Chatwoot holds it NOW.
 *
 * This is the deliberate alternative to keeping message bodies in the ledger.
 * It has a second, better property: the conversation status and assignee are
 * the current ones, so `evaluateSuppression` will correctly refuse to answer a
 * conversation a human took over while this service was down.
 *
 * Returns null when the recorded message cannot be found — a message that is no
 * longer there must not be answered from a guess.
 */
export function rebuildPayload(
  record: unknown,
  row: RecoverableDelivery,
): WebhookPayload | null {
  if (!isRecord(record)) return null;

  const meta = isRecord(record["meta"]) ? record["meta"] : null;
  const attributes = isRecord(record["custom_attributes"])
    ? record["custom_attributes"]
    : {};

  // An AgentBot token can see exactly two messages on a conversation record —
  // `messages` (the single newest message, possibly an activity line) and
  // `last_non_activity_message`. The messages INDEX is not bot-accessible; see
  // the note in src/chatwoot.ts. So recovery works from these two and nothing
  // more, which is enough: a delivery that never produced a reply leaves the
  // customer's own message as the newest real one.
  const candidates: Record<string, unknown>[] = [];
  const list = record["messages"];
  if (Array.isArray(list)) for (const entry of list) if (isRecord(entry)) candidates.push(entry);
  const lastReal = record["last_non_activity_message"];
  if (isRecord(lastReal)) candidates.push(lastReal);

  const incoming = candidates.filter(
    (m) => readMessageType(m["message_type"]) === "incoming",
  );

  const message =
    row.messageId === null
      ? incoming[incoming.length - 1]
      : (candidates.find((m) => readInt(m["id"]) === row.messageId) ??
        // The recorded message is no longer the newest one. Only resume when
        // the newest real message IS the one we recorded; otherwise the
        // conversation has moved on and re-answering would be answering the
        // wrong thing.
        undefined);

  if (message === undefined) return null;
  if (readMessageType(message["message_type"]) !== "incoming") return null;

  const sender = isRecord(message["sender"]) ? message["sender"] : null;
  const privateRaw = message["private"];

  return {
    event: REPLYABLE_EVENT,
    messageId: readInt(message["id"]),
    content: typeof message["content"] === "string" ? message["content"] : null,
    messageType: readMessageType(message["message_type"]),
    attachmentTypes: readAttachmentTypes(message["attachments"]),
    contentType: readContentType(message["content_type"]),
    private: typeof privateRaw === "boolean" ? privateRaw : false,
    senderPhone: null,
    senderType: sender === null ? null : (typeof sender["type"] === "string" ? sender["type"] : null),
    accountId: row.chatwootAccountId,
    inboxId: row.chatwootInboxId,
    conversationDisplayId: row.conversationId,
    conversationStatus:
      typeof record["status"] === "string" ? (record["status"] as string) : null,
    assignee: meta === null ? null : (meta["assignee"] ?? null),
    customAttributes: attributes,
  };
}

function findBinding(
  bindings: readonly Binding[],
  row: RecoverableDelivery,
): Binding | null {
  for (const binding of bindings) {
    if (
      binding.tenantId === row.tenantId &&
      binding.chatwootAccountId === row.chatwootAccountId &&
      binding.chatwootInboxId === row.chatwootInboxId &&
      bindingIdentity(binding) === row.bindingId
    ) {
      return binding;
    }
  }
  return null;
}

export function createSweeper(deps: RecoveryDeps): Sweeper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function resume(row: RecoverableDelivery): Promise<boolean> {
    // A delivery that cannot be completed must eventually STOP being retried.
    //
    // Deliveries are now deliberately left open when their handover did not
    // become visible in Chatwoot, so the sweeper can finish them. If the cause
    // is permanent — a deleted conversation, a revoked token, an inbox that no
    // longer accepts writes — that turns into a delivery swept once per lease
    // period forever, quietly, with nobody looking at it.
    //
    // Past the cap it is abandoned and ALERTED instead. The conversation is
    // left suppressed for the AI on purpose: a human still needs to answer it,
    // and silently handing it back to the bot after repeated failures would be
    // the wrong repair. The alert is the handle a person picks it up by.
    if (row.attempts >= MAX_RECOVERY_ATTEMPTS) {
      const identity: LedgerIdentity = {
        tenantId: row.tenantId,
        bindingId: row.bindingId,
        chatwootAccountId: row.chatwootAccountId,
        chatwootInboxId: row.chatwootInboxId,
        eventId: row.eventId,
      };
      deps.logger.error({
        event: "recovery",
        alert: true,
        alertCode: "recovery_attempts_exhausted",
        outcome: "abandoned",
        correlationId: row.correlationId,
        tenantId: row.tenantId,
        accountId: row.chatwootAccountId,
        inboxId: row.chatwootInboxId,
        conversationId: row.conversationId,
        attempts: row.attempts,
        detail:
          "this delivery has been retried to the cap without completing; it needs a human. The AI stays suppressed for this conversation.",
      });
      await deps.ledger.fail(identity, DELIVERY_ACTION, "recovery_attempts_exhausted");
      return false;
    }

    const binding = findBinding(deps.bindingStore.list(), row);
    if (binding === null) {
      // The binding is gone or has been re-pointed. Do not guess: close the row
      // out as failed so it stops being swept, and say so loudly.
      deps.logger.error({
        event: "recovery",
        alert: true,
        alertCode: "recovery_binding_missing",
        outcome: "abandoned",
        correlationId: row.correlationId,
        tenantId: row.tenantId,
        accountId: row.chatwootAccountId,
        inboxId: row.chatwootInboxId,
      });
      const identity: LedgerIdentity = {
        tenantId: row.tenantId,
        bindingId: row.bindingId,
        chatwootAccountId: row.chatwootAccountId,
        chatwootInboxId: row.chatwootInboxId,
        eventId: row.eventId,
      };
      await deps.ledger.fail(identity, DELIVERY_ACTION, "binding_missing");
      return false;
    }

    // Lifecycle is enforced here as well as in resolveBinding(). Recovery is a
    // SECOND entry point into delivery: a message admitted while the agent was
    // accepted could otherwise be replayed after it was un-accepted, so gating
    // only the webhook path would leave the sweeper as a bypass.
    const lifecycleBlocked = !isRoutableLifecycle(binding.lifecycle);
    if (binding.status !== "active" || lifecycleBlocked || row.conversationId === null) {
      const identity: LedgerIdentity = {
        tenantId: row.tenantId,
        bindingId: row.bindingId,
        chatwootAccountId: row.chatwootAccountId,
        chatwootInboxId: row.chatwootInboxId,
        eventId: row.eventId,
      };
      await deps.ledger.fail(
        identity,
        DELIVERY_ACTION,
        // Same precedence as resolveBinding: status -> lifecycle -> conversation.
        // A retired binding keeps reporting `binding_retired`, so an operator's
        // deliberate disposition is never masked by a derived platform state.
        binding.status !== "active"
          ? "binding_retired"
          : lifecycleBlocked
            ? "binding_not_accepted"
            : "no_conversation",
      );
      return false;
    }

    const identity: LedgerIdentity = {
      tenantId: row.tenantId,
      bindingId: row.bindingId,
      chatwootAccountId: row.chatwootAccountId,
      chatwootInboxId: row.chatwootInboxId,
      eventId: row.eventId,
    };

    // Take the lease. If another instance beat us to it, `reserve` reports a
    // live claim and we leave it alone.
    const claimed = await deps.ledger.reserve({
      identity,
      digest: row.payloadDigest,
      correlationId: row.correlationId,
      conversationId: row.conversationId,
      messageId: row.messageId,
      mode: row.mode ?? "answer",
      leaseMs: deps.config.ledgerLeaseMs,
    });
    if (claimed.kind !== "resumed" && claimed.kind !== "reserved") return false;

    const startedAt = deps.now();
    const target = {
      accountId: binding.chatwootAccountId,
      conversationId: row.conversationId,
      accessToken: binding.agentBotAccessToken,
    // The tenant's own Chatwoot, when the binding names one.
    ...(binding.chatwootBaseUrl === undefined ? {} : { baseUrl: binding.chatwootBaseUrl }),
    };

    // ---- Did this delivery already answer? --------------------------------
    //
    // Ask FIRST, before trying to rebuild the inbound message. If the process
    // died between Chatwoot committing the reply and the ledger recording it,
    // the reply is already in the conversation and the delivery is done — it
    // must be closed out, not re-run.
    //
    // Asking first is also the only thing that works: a bot can see just the
    // newest message and the newest non-activity message, so once our own
    // reply is the newest, the inbound message it answered is no longer
    // visible and `rebuildPayload` would abandon the row. Reconciling first
    // resolves that case correctly instead of losing it.
    if (row.mode !== "handoff") {
      const already = await deps.chatwoot.reconcileDeliveryRef(
        target,
        deliveryRef(identity, "reply"),
        row.messageId,
      );
      if (already.kind === "found") {
        deps.logger.warn({
          event: "recovery",
          outcome: "resolved_already_delivered",
          correlationId: row.correlationId,
          tenantId: row.tenantId,
          conversationId: row.conversationId,
          chatwootMessageId: already.messageId,
          detail:
            "the reply was already in Chatwoot; the ledger had not recorded it. Completed without sending.",
        });
        await deps.ledger.complete(identity, "reply", already.messageId);
        await deps.ledger.complete(identity, DELIVERY_ACTION, null);
        return true;
      }
    }

    // Re-read the conversation from the system that owns it.
    let record: unknown;
    try {
      record = await deps.chatwoot.getConversationRecord(target);
    } catch (err) {
      // Leave the row claimed with an expired lease; the next sweep retries.
      deps.logger.warn({
        event: "recovery",
        outcome: "conversation_read_failed",
        correlationId: row.correlationId,
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        detail: err instanceof Error ? err.message : "unknown chatwoot failure",
      });
      return false;
    }

    const payload = rebuildPayload(record, row);
    if (payload === null) {
      deps.logger.error({
        event: "recovery",
        alert: true,
        alertCode: "recovery_message_missing",
        outcome: "abandoned",
        correlationId: row.correlationId,
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        messageId: row.messageId,
      });
      await deps.ledger.fail(identity, DELIVERY_ACTION, "message_missing");
      return false;
    }

    // Re-evaluate against the CURRENT conversation. A human who took over while
    // this service was down must not be talked over by a resumed delivery.
    const verdict = evaluateSuppression(payload);

    // EXCEPT for a delivery that was reserved as a HANDOFF.
    //
    // A handoff records the ownership transfer BEFORE it opens and assigns the
    // conversation in Chatwoot. If it died between those, the conversation is
    // now `open` and possibly assigned — which is precisely what
    // `evaluateSuppression` reads as "a human has this, stay out". Completing
    // the row on that reading closes the delivery for good and leaves its own
    // half-finished handoff forever: the AI is suppressed by the store and the
    // note and acknowledgement were never written. Nobody answers.
    //
    // `row.mode` is what this delivery was RESERVED as, recorded before any of
    // that happened, so it is the honest question to ask. Re-running is safe:
    // every write is claimed under this delivery's ledger key and reconciled,
    // and the customer acknowledgement is claimed per episode with this
    // delivery as the claimant.
    const resumingHandoff = row.mode === "handoff";

    if (verdict.action === "suppress" && !resumingHandoff) {
      deps.logger.info({
        event: "recovery",
        outcome: "suppressed_on_resume",
        suppressionReason: verdict.reason,
        correlationId: row.correlationId,
        tenantId: row.tenantId,
        conversationId: row.conversationId,
      });
      await deps.ledger.complete(identity, DELIVERY_ACTION, null);
      return false;
    }

    const job: DeliveryJob = {
      correlationId: row.correlationId,
      deliveryId: null,
      identity,
      digest: row.payloadDigest,
      binding,
      payload,
      conversationId: row.conversationId,
      startedAtMs: startedAt,
      resumed: true,
      // A resumed handoff stays a handoff even when the CURRENT verdict no
      // longer says so, because the current state is the one its own first
      // attempt produced.
      mode: resumingHandoff || verdict.action === "handoff" ? "handoff" : "answer",
      classification:
        resumingHandoff || verdict.action === "handoff" ? classifyNoText(payload) : null,
    };

    deps.logger.warn({
      event: "recovery",
      outcome: "resuming",
      correlationId: row.correlationId,
      tenantId: row.tenantId,
      accountId: row.chatwootAccountId,
      inboxId: row.chatwootInboxId,
      conversationId: row.conversationId,
      priorState: row.state,
      attempts: row.attempts,
      mode: job.mode,
    });

    await processDelivery(
      {
        config: deps.config,
        chatwoot: deps.chatwoot,
        runtime: deps.runtime,
        logger: deps.logger,
        ledger: deps.ledger,
        ownership: deps.ownership,
        ...(deps.customerScope === undefined ? {} : { customerScope: deps.customerScope }),
        failpoint: deps.failpoint,
        now: deps.now,
      },
      job,
    );
    return true;
  }

  async function sweep(): Promise<number> {
    if (running) return 0;
    running = true;
    let resumed = 0;
    try {
      const due = await deps.ledger.dueForRecovery(deps.config.ledgerRecoveryBatch);
      for (const row of due) {
        try {
          if (await resume(row)) resumed += 1;
        } catch (err) {
          deps.logger.error({
            event: "recovery",
            alert: true,
            alertCode: "recovery_failed",
            outcome: "error",
            correlationId: row.correlationId,
            tenantId: row.tenantId,
            detail: err instanceof Error ? err.message : "unknown recovery failure",
          });
        }
      }
      if (resumed > 0) {
        deps.logger.info({ event: "recovery", outcome: "swept", resumed, due: due.length });
      }
    } catch (err) {
      // A sweep that cannot read the ledger is not fatal; the next one retries.
      deps.logger.warn({
        event: "recovery",
        outcome: "sweep_failed",
        detail: err instanceof Error ? err.name : "unknown ledger failure",
      });
    } finally {
      running = false;
    }
    return resumed;
  }

  return {
    sweep,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void sweep();
      }, deps.config.ledgerRecoveryIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
