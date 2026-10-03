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
import { DISARMED, type Failpoint } from "./failpoint.js";
import type { Ledger } from "./ledger.js";
import { LedgerUnavailableError } from "./ledger.js";
import type { Logger } from "./log.js";

export interface WriteDeps {
  chatwoot: ChatwootApi;
  ledger: Ledger;
  logger: Logger;
  leaseMs: number;
  /** Test-only; `DISARMED` everywhere else. See src/failpoint.ts. */
  failpoint: Failpoint;
}

export { DISARMED };

/**
 * Who may write to this conversation RIGHT NOW, shared by every guarded write of one
 * delivery (Codex R3). `heldEpisode` is null while the AI has the conversation; once
 * this delivery has itself recorded a human hold it is that hold's episode, and the
 * fence then asks "is it STILL our unanswered hold" rather than "is the AI still
 * authorised". `fenced` latches: after one denial this delivery writes nothing more.
 */
export interface WriteAuthority {
  heldEpisode: number | null;
  fenced: boolean;
}

/**
 * Thrown by `runGuardedWrite` when the fence denies a non-message write. Nothing was
 * sent. It is NOT a failed write: the conversation moved to a person and the rest of
 * this delivery's writes must stop.
 */
export class WriteFencedError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(`write fenced: ownership moved before "${action}"`);
    this.name = "WriteFencedError";
    this.action = action;
  }
}

export interface WriteContext {
  /**
   * Called IMMEDIATELY BEFORE each Chatwoot write, after the ledger claim and any
   * reconciliation (Codex R3: a reply plus its annotations is up to five HTTP
   * operations and an escalation up to seven, so ONE read before the first write goes
   * stale). Resolves false when the conversation is no longer ours to write to. A
   * rejection propagates, exactly as the pre-run gate's does: "I could not find out who
   * holds this" is never "nobody does". Absent = no fence (legacy callers and tests).
   */
  fence?: (action: string) => Promise<boolean>;
  authority?: WriteAuthority;
  identity: LedgerIdentity;
  /** The signed-body digest this delivery was reserved under. */
  digest: string;
  correlationId: string;
  /**
   * The INBOUND Chatwoot message id this delivery is answering. Reconciliation
   * pivots on it: message ids are monotonic within a conversation, so if the
   * newest real message is at or before this one, nothing of ours was sent.
   */
  pivotMessageId: number | null;
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
  /**
   * The fence denied the write: ownership moved to a person after the claim and before
   * the send. NOTHING was sent, the claim is released, and the caller must stop.
   */
  | { kind: "fenced" }
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
      context.pivotMessageId,
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
  // The last read before the wire: ownership is checked HERE, after the claim and any
  // reconciliation, so no ledger or Chatwoot read can age the decision (Codex R3).
  if (context.fence !== undefined && !(await context.fence(action))) {
    try {
      await deps.ledger.fail(context.identity, action, "fenced");
    } catch {
      // Releasing the claim is best effort; the delivery is closed as suppressed.
    }
    return { kind: "fenced" };
  }
  let messageId: number | null;
  try {
    messageId = await deps.chatwoot.postMessage(target, content, isPrivate, ref);
  } catch (err) {
    // 6. The response was lost, but Chatwoot may already have committed.
    //    Reconcile before concluding anything.
    const reconciled = await deps.chatwoot.reconcileDeliveryRef(
      target,
      ref,
      context.pivotMessageId,
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

  // ---- THE CRASH WINDOW --------------------------------------------------
  // Chatwoot has committed the message and returned its id; the ledger does
  // not know yet. Everything between here and `settle` is the ambiguity that
  // reconciliation exists to resolve, and it is far too narrow to hit with
  // wall-clock fault injection. The failpoint makes it deterministic.
  //
  // Disarmed in production, where this is a no-op call that returns
  // immediately. See src/failpoint.ts.
  await deps.failpoint.trip("after_chatwoot_commit_before_ledger_complete", {
    ...context.base,
    correlationId: context.correlationId,
    action,
    chatwootMessageId: messageId,
  });

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
    await fenceOrThrow(deps, context, action);
    await fn();
    return true;
  }

  if (claim.kind === "completed") return false;

  await fenceOrThrow(deps, context, action);
  await fn();
  await settle(deps, context, action, null);
  return true;
}

/** The last read before the wire for a non-message write; throws `WriteFencedError` when denied. */
async function fenceOrThrow(deps: WriteDeps, context: WriteContext, action: string): Promise<void> {
  if (context.fence === undefined) return;
  if (await context.fence(action)) return;
  try {
    await deps.ledger.fail(context.identity, action, "fenced");
  } catch {
    // Releasing the claim is best effort; the delivery is closed as suppressed.
  }
  throw new WriteFencedError(action);
}
