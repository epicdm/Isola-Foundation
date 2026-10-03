/**
 * Restart recovery.
 *
 * A delivery is reserved in the ledger BEFORE it is acknowledged. If the container dies between
 * the ACK and the reply, the reservation survives but nothing is working it -- Chatwoot will
 * never re-offer a delivery it already saw acknowledged. Without this sweeper, that customer is
 * never answered by anyone.
 *
 * WHAT RECOVERY DOES NOW (Codex R5; Lane A direction): it does NOT resume the delivery.
 * It used to rebuild the inbound message from Chatwoot and run the pipeline again, which depended
 * on what a Chatwoot message window can show an AgentBot; four review rounds in a row found a new
 * defect in that dependence. The sweeper now takes the lease on a delivery whose lease expired
 * and hands it to `recoverDelivery` (src/recovery-escalation.ts): a delivery that cannot be
 * PROVEN complete gets exactly ONE recorded escalation to a human, and never a model call or a
 * customer message. A delivery the ledger already proves complete is closed without one.
 *
 * CUSTOMER-VISIBLE COST: a delivery interrupted by a crash or a lease expiry is not answered
 * automatically afterwards; a person answers it. The rate is unmeasured.
 */
import { isRoutableLifecycle } from "./bindings.js";
import type { Binding, BindingStore } from "./bindings.js";
import type { ChatwootApi } from "./chatwoot.js";
import type { GatewayConfig } from "./config.js";
import type { CustomerScopeResolver } from "./customer-scope.js";
import { bindingIdentity, type LedgerIdentity } from "./deliveryref.js";
import type { Failpoint } from "./failpoint.js";
import type { Ledger, RecoverableDelivery } from "./ledger.js";
import type { OwnershipGate } from "./ownership.js";
import type { Logger } from "./log.js";
import { abandonDelivery, loggerAlertSink, recoverDelivery, type AlertSink } from "./recovery-escalation.js";
import type { AgentRuntime } from "./runtime.js";

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
   * The same ownership gate the live path uses: recovery records its escalation as an ownership
   * hold, and never touches a conversation a person (or another delivery's hold) already has.
   */
  ownership: OwnershipGate;
  /**
   * Kept for wiring compatibility. Recovery no longer re-runs the pipeline, so it no longer
   * resolves a customer scope: an interrupted delivery is escalated to a person, not answered.
   */
  customerScope?: CustomerScopeResolver;
  bindingStore: BindingStore;
  chatwoot: ChatwootApi;
  /** Kept for wiring compatibility. Recovery NEVER calls the runtime. */
  runtime: AgentRuntime;
  logger: Logger;
  /** Where a recovery alert goes. Default: a loud ERROR log line (NOT out-of-band; see recovery-escalation.ts). */
  alertSink?: AlertSink;
  /** Test-only; `DISARMED` in every production deployment. */
  failpoint: Failpoint;
  now: () => number;
}

export interface Sweeper {
  /** Run one pass. Returns how many deliveries were closed. */
  sweep(): Promise<number>;
  start(): void;
  stop(): void;
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
  const alertSink: AlertSink = deps.alertSink ?? loggerAlertSink(deps.logger);

  async function resume(row: RecoverableDelivery): Promise<boolean> {
    const identity: LedgerIdentity = {
      tenantId: row.tenantId,
      bindingId: row.bindingId,
      chatwootAccountId: row.chatwootAccountId,
      chatwootInboxId: row.chatwootInboxId,
      eventId: row.eventId,
    };

    // A delivery that cannot be completed must eventually STOP being retried.
    //
    // A delivery is deliberately left open when its escalation did not become visible in
    // Chatwoot, so the next sweep can finish it. If the cause is permanent -- a deleted
    // conversation, a revoked token, an inbox that no longer accepts writes -- that would be a
    // delivery swept once per lease period forever, quietly, with nobody looking at it. Past the
    // cap it is abandoned and ALERTED instead (never silent), every open action recorded as
    // abandoned. The conversation is left suppressed for the AI on purpose: a human still needs
    // to answer it, and the alert is the handle a person picks it up by.
    if (row.attempts >= MAX_RECOVERY_ATTEMPTS) {
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
      await abandonDelivery(
        { ledger: deps.ledger, logger: deps.logger, alertSink },
        row,
        identity,
        "recovery_attempts_exhausted",
        "this delivery was retried to the cap without completing; it needs a person",
      );
      return false;
    }

    const binding = findBinding(deps.bindingStore.list(), row);
    if (binding === null) {
      // The binding is gone or has been re-pointed. Do not guess: close the row out as failed so
      // it stops being swept, and say so loudly.
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
      await abandonDelivery(
        { ledger: deps.ledger, logger: deps.logger, alertSink },
        row,
        identity,
        "binding_missing",
        "the binding for this delivery no longer exists, so there is no token to reach the conversation with; it needs a person",
      );
      return false;
    }

    // Lifecycle is enforced here as well as in resolveBinding(). Recovery is a SECOND entry point
    // into delivery: a message admitted while the agent was accepted could otherwise be touched
    // after it was un-accepted, so gating only the webhook path would leave the sweeper as a bypass.
    const lifecycleBlocked = !isRoutableLifecycle(binding.lifecycle);
    if (binding.status !== "active" || lifecycleBlocked || row.conversationId === null) {
      await abandonDelivery(
        { ledger: deps.ledger, logger: deps.logger, alertSink },
        row,
        identity,
        // Same precedence as resolveBinding: status -> lifecycle -> conversation. A retired
        // binding keeps reporting `binding_retired`, so an operator's deliberate disposition is
        // never masked by a derived platform state.
        binding.status !== "active"
          ? "binding_retired"
          : lifecycleBlocked
            ? "binding_not_accepted"
            : "no_conversation",
        "this delivery's binding is not routable (or it has no conversation); the gateway will not touch the conversation",
      );
      return false;
    }

    // Take the lease. If another instance beat us to it, `reserve` reports a live claim and we
    // leave it alone.
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

    const startedAtMs = deps.now();
    const target = {
      accountId: binding.chatwootAccountId,
      conversationId: row.conversationId,
      accessToken: binding.agentBotAccessToken,
      // The tenant's own Chatwoot, when the binding names one.
      ...(binding.chatwootBaseUrl === undefined ? {} : { baseUrl: binding.chatwootBaseUrl }),
    };

    deps.logger.warn({
      event: "recovery",
      outcome: "recovering",
      correlationId: row.correlationId,
      tenantId: row.tenantId,
      accountId: row.chatwootAccountId,
      inboxId: row.chatwootInboxId,
      conversationId: row.conversationId,
      priorState: row.state,
      attempts: row.attempts,
      mode: row.mode,
    });

    const outcome = await recoverDelivery(
      {
        config: deps.config,
        ledger: deps.ledger,
        ownership: deps.ownership,
        chatwoot: deps.chatwoot,
        logger: deps.logger,
        alertSink,
        failpoint: deps.failpoint,
        now: deps.now,
      },
      { row, binding, identity, target, conversationId: row.conversationId, startedAtMs },
    );
    return outcome === "completed";
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
