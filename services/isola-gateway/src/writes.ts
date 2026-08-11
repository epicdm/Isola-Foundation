/**
 * Guarded writes: the only place this service is allowed to change anything in
 * Chatwoot.
 *
 * Chatwoot v4.16.1 has NO database-enforced message idempotency. Verified
 * against the deployed source:
 *
 *   db/schema.rb        t.index ["source_id"], name: "index_messages_on_source_id"
 *                       -- indexed, NOT unique
 *   app/models/message.rb
 *                       -- no uniqueness validation on source_id in any scope
 *
 * So "exactly once" cannot be delegated to the destination, and this module
 * does NOT claim it. What it guarantees is weaker and honest:
 *
 *   a message is sent only after its absence has been PROVEN, and when absence
 *   cannot be proven nothing is sent at all.
 *
 * The mechanism is a deterministic opaque reference (`src/deliveryref.ts`)
 * stamped into `content_attributes` — passed through verbatim by Chatwoot's
 * `Messages::MessageBuilder` and never rendered to the customer — plus a
 * reconciliation read before any resend.
 */
import type { ChatwootApi, ChatwootTarget } from "./chatwoot.js";
import { deliveryRef, type LedgerIdentity } from "./deliveryref.js";
import type { Ledger } from "./ledger.js";
import { LedgerUnavailableError } from "./ledger.js";
import type { Logger } from "./log.js";

export interface WriteDeps {
  chatwoot: ChatwootApi;
  ledger: Ledger;
  logger: Logger;
  leaseMs: number;
}

export interface WriteContext {
  identity: LedgerIdentity;
  /** The signed-body digest this delivery was reserved under. */
  digest: string;
  correlationId: string;
  /** Epoch seconds at which the delivery was reserved. Bounds reconciliation. */
  reservedAtEpochSec: number;
  /** Structured fields carried onto every log line. Never customer content. */
  base: Record<string, unknown>;
}

export type SendOutcome =
  /** Sent now, for the first and only time. */
  | { kind: "sent"; messageId: number | null }
  /** Reconciliation found it already in Chatwoot. Nothing was sent. */
  | { kind: "already_present"; messageId: number | null }
  /** The ledger already recorded this write as finished. Nothing was sent. */
  | { kind: "skipped" }
  /** Proven NOT delivered. Safe for the caller to treat as a failed write. */
  | { kind: "failed"; detail: string }
  /**
   * Delivery state is genuinely unknown and could not be resolved. NOTHING was
   * sent. The operator has been alerted and the ledger row is left claimed so
   * a later sweep can re-attempt reconciliation.
   */
  | { kind: "ambiguous"; detail: string };

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : "unknown failure";
}

/**
 * The operator-facing alarm. A single stable `alertCode` per condition so
 * alerting can be wired to the code and not to prose.
 */
function alert(
  deps: WriteDeps,
  context: WriteContext,
  alertCode: string,
  fields: Record<string, unknown>,
): void {
  deps.logger.error({
    ...context.base,
    event: "write",
    alert: true,
    alertCode,
    correlationId: context.correlationId,
    ...fields,
  });
}

/**
 * Send exactly one Chatwoot message for `action`, or prove that it is already
 * there, or send nothing at all.
 *
 * The order is the one the owner specified:
 *   1. atomically claim the action
 *   2. if already completed, stop
 *   3. reconcile Chatwoot for the deterministic delivery reference
 *   4. send only when no matching delivery exists
 *   5. record the returned Chatwoot message id and the completed state
 *   6. on a timeout or lost response, reconcile BEFORE any resend
 *   7. fail closed and alert if delivery remains ambiguous
 */
export async function sendGuardedMessage(
  deps: WriteDeps,
  context: WriteContext,
  action: string,
  target: ChatwootTarget,
  content: string,
  isPrivate: boolean,
): Promise<SendOutcome> {
  const ref = deliveryRef(context.identity, action);

  // ---- 1. claim ----------------------------------------------------------
  let claim;
  try {
    claim = await deps.ledger.claimAction(
      context.identity,
      action,
      context.digest,
      context.correlationId,
      deps.leaseMs,
    );
  } catch (err) {
    // The ledger is the thing that stops a duplicate. Without it, sending is
    // exactly the risk we are here to remove.
    alert(deps, context, "ledger_unavailable_on_write", {
      action,
      outcome: "ambiguous",
      detail: detailOf(err),
    });
    return { kind: "ambiguous", detail: "ledger unavailable; nothing sent" };
  }

  // ---- 2. already finished ----------------------------------------------
  if (claim.kind === "completed") return { kind: "skipped" };

  // ---- 3. an earlier attempt claimed it and never recorded an outcome ----
  if (claim.kind === "ambiguous") {
    const reconciled = await deps.chatwoot.reconcileDeliveryRef(
      target,
      ref,
      context.reservedAtEpochSec,
    );
    if (reconciled.kind === "found") {
      await settle(deps, context, action, reconciled.messageId);
      return { kind: "already_present", messageId: reconciled.messageId };
    }
    if (reconciled.kind === "inconclusive") {
      alert(deps, context, "delivery_state_unresolved", {
        action,
        outcome: "ambiguous",
        attempts: claim.attempts,
        detail: reconciled.detail,
      });
      return { kind: "ambiguous", detail: reconciled.detail };
    }
    // `absent` is PROVEN absence — fall through and send.
  }

  // ---- 4. send -----------------------------------------------------------
  let messageId: number | null;
  try {
    messageId = await deps.chatwoot.postMessage(target, content, isPrivate, ref);
  } catch (err) {
    // 6. The response was lost, but Chatwoot may already have committed.
    //    Reconcile before concluding anything.
    const reconciled = await deps.chatwoot.reconcileDeliveryRef(
      target,
      ref,
      context.reservedAtEpochSec,
    );
    if (reconciled.kind === "found") {
      await settle(deps, context, action, reconciled.messageId);
      return { kind: "already_present", messageId: reconciled.messageId };
    }
    if (reconciled.kind === "absent") {
      try {
        await deps.ledger.fail(context.identity, action, "send_failed");
      } catch {
        // Recording the failure is best effort; the send provably did not land.
      }
      return { kind: "failed", detail: detailOf(err) };
    }
    // 7. Neither proven sent nor proven absent.
    alert(deps, context, "delivery_state_unresolved", {
      action,
      outcome: "ambiguous",
      detail: `${detailOf(err)}; reconciliation ${reconciled.detail}`,
    });
    return { kind: "ambiguous", detail: reconciled.detail };
  }

  // ---- 5. record ---------------------------------------------------------
  await settle(deps, context, action, messageId);
  return { kind: "sent", messageId };
}

/**
 * Record the completed state. If the ledger has died AFTER Chatwoot committed,
 * the row stays claimed — which is the safe direction: a later attempt
 * reconciles, finds the reference and completes, rather than sending again.
 */
async function settle(
  deps: WriteDeps,
  context: WriteContext,
  action: string,
  messageId: number | null,
): Promise<void> {
  try {
    await deps.ledger.complete(context.identity, action, messageId);
  } catch (err) {
    alert(deps, context, "ledger_write_lost_after_commit", {
      action,
      outcome: "sent_but_unrecorded",
      chatwootMessageId: messageId,
      detail: detailOf(err),
    });
  }
}

/**
 * Guard a non-message Chatwoot write — status toggle, assignment, labels,
 * custom attributes.
 *
 * These are all idempotent at the destination (setting `open` twice, assigning
 * the same team twice, replacing labels with the same list), so an ambiguous
 * claim simply re-runs rather than failing closed. That is the difference
 * between this and `sendGuardedMessage`: a repeated status toggle costs
 * nothing, a repeated customer message costs trust.
 *
 * Returns true when the operation ran, false when it was already recorded.
 * Errors from `fn` propagate, exactly as the previous in-memory guard did.
 */
export async function runGuardedWrite(
  deps: WriteDeps,
  context: WriteContext,
  action: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  let claim;
  try {
    claim = await deps.ledger.claimAction(
      context.identity,
      action,
      context.digest,
      context.correlationId,
      deps.leaseMs,
    );
  } catch (err) {
    if (!(err instanceof LedgerUnavailableError)) throw err;
    // An idempotent write with no ledger is still safe to perform, and getting
    // the conversation in front of a human matters more than the bookkeeping.
    alert(deps, context, "ledger_unavailable_on_idempotent_write", {
      action,
      outcome: "proceeding_unguarded",
      detail: detailOf(err),
    });
    await fn();
    return true;
  }

  if (claim.kind === "completed") return false;

  await fn();
  await settle(deps, context, action, null);
  return true;
}
