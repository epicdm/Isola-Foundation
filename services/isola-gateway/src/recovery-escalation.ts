/**
 * Fail-closed recovery: ONE recorded escalation to a human (Codex R5; Lane A direction).
 *
 * WHY THIS REPLACES RESUMPTION
 * ----------------------------
 * Four review rounds in a row found new defects in the recovery path that tried to RESUME a
 * half-finished delivery: it rebuilt the inbound message from Chatwoot, reconciled the reply by
 * reading a message window, pivoted a note off the inbound id. Every one of those depends on
 * what a Chatwoot message window can show an AgentBot (two messages, newest first; a newer
 * message HIDES an older one), so each fix exposed the next hole: a private note hid the reply
 * (G5-1), a newer reply made a released note unprovable (G5-2), an unreadable record became an
 * abandonment (G5-4).
 *
 * THE RULE (permanent for this slice; revisited only after fenced leases are authorised AND
 * proven on a real Postgres): a delivery that recovery finds and cannot PROVE complete gets
 * exactly ONE recorded escalation to a human, by a mechanism that does not depend on reply
 * visibility or on rebuilding the inbound message:
 *
 *   1. the durable INTENT: the ownership hold (operation id `escalate:<event>`), recorded
 *      before any Chatwoot write. It is idempotent: a replay finds the same hold.
 *   2. the PUBLICATION: the private note, the status change and the assignment, each claimed
 *      under the delivery's ledger key and fenced before the wire (`writes.ts`). A note that
 *      cannot be proven absent is NOT resent (an uncertain write is never repeated blindly).
 *   3. a DISPOSITION on every action row, so nothing stays in_progress beneath a closed
 *      delivery: completed (performed), or a `failed` row whose failure_code says why not.
 *   4. an ALERT through `AlertSink`.
 *
 * What it never does: call the model, send a customer message, rebuild the inbound message, or
 * touch a conversation a person already holds.
 *
 * CUSTOMER-VISIBLE COST: a delivery interrupted by a crash or a lease expiry is NOT answered
 * automatically afterwards. A human answers it. The rate is unmeasured.
 *
 * PROVABLY COMPLETE is deliberately narrow: the reply (or a handoff acknowledgement) is a
 * COMPLETED ledger row, no other action is in flight, and this delivery holds no escalation.
 * Positive evidence only: a reply row left in_progress counts only if the reply is FOUND in
 * Chatwoot; "not found" or "cannot tell" is never evidence of completion.
 * KNOWN LIMIT: a reply that promised a colleague whose hold was never recorded leaves no
 * durable trace of the promise (the reply text is not stored), so it cannot be detected here.
 */
import type { Binding } from "./bindings.js";
import type { ChatwootApi, ChatwootTarget } from "./chatwoot.js";
import type { GatewayConfig } from "./config.js";
import { deliveryRef, DELIVERY_ACTION, type LedgerIdentity } from "./deliveryref.js";
import type { Failpoint } from "./failpoint.js";
import type { DeliveryActionRow, Ledger, RecoverableDelivery } from "./ledger.js";
import type { Logger } from "./log.js";
import { suppressesAutomatedReply, type ConversationRef, type OwnershipGate } from "./ownership.js";
import { renderFailureNote, WRITE } from "./pipeline.js";
import {
  runGuardedWrite,
  sendGuardedMessage,
  WriteFencedError,
  type WriteContext,
  type WriteDeps,
} from "./writes.js";

/**
 * How a claimed action ended when it was NOT performed (or could not be proven performed).
 * A performed action is a `completed` row; these are recorded in `failure_code` of a `failed`
 * row, so nothing stays `in_progress` beneath a closed delivery. No schema change: the column
 * already exists and holds text.
 */
export const DISPOSITION = {
  /** Not confirmed sent and never re-sent; a person was asked to read the conversation. */
  notSentEscalated: "disposition_not_sent_escalated",
  /** A person (or another delivery's hold) has the conversation: this action is moot. */
  superseded: "disposition_superseded",
  /** Given up on: nothing more will be done for this action (a non-essential annotation, a step not needed once a person is asked, or a delivery that could not be recovered). */
  abandoned: "disposition_abandoned",
} as const;

export type RecoveryAlertCode =
  | "recovery_escalated_to_human"
  | "recovery_escalation_not_visible"
  | "recovery_abandoned"
  /** A disposition could not be recorded, so the delivery was left open to be swept again (Codex R6 G6-2). */
  | "recovery_disposition_not_recorded";

export interface RecoveryAlert {
  alertCode: RecoveryAlertCode;
  correlationId: string;
  tenantId: string;
  accountId: number;
  inboxId: number;
  conversationId: number | null;
  attempts: number;
  /** action -> how it ended (`completed`, or one of the DISPOSITION codes, or `in_progress`). */
  dispositions: Record<string, string>;
  detail: string;
}

/**
 * Where a recovery alert goes. The default writes a loud, structured, ERROR-level log line with
 * a stable event name (recovery_escalation) and alertCode: that is NOT an out-of-band alert.
 * Nothing in this gateway reaches a person outside Chatwoot; that needs an owner decision (see
 * BRANCH-NOTES). The in-product alert is the private note on the conversation.
 */
export interface AlertSink {
  raise(alert: RecoveryAlert): void;
}

export function loggerAlertSink(logger: Logger): AlertSink {
  return {
    raise(alert: RecoveryAlert): void {
      logger.error({
        event: "recovery_escalation",
        alert: true,
        alertCode: alert.alertCode,
        correlationId: alert.correlationId,
        tenantId: alert.tenantId,
        accountId: alert.accountId,
        inboxId: alert.inboxId,
        conversationId: alert.conversationId,
        attempts: alert.attempts,
        dispositions: alert.dispositions,
        detail: alert.detail,
      });
    },
  };
}

/**
 * Raise an alert and say whether the sink took it (Codex R6 G6-5). A sink that throws is logged
 * at ERROR (the log line is the only trace) and reported as `false`, so the caller can keep the
 * delivery OPEN and let the next sweep raise the alert again, instead of closing a delivery whose
 * required alert was never seen. The alert is therefore AT-LEAST-ONCE: a crash between a
 * successful alert and the close raises it again.
 */
function raiseAlert(deps: Pick<RecoveryEscalationDeps, "alertSink" | "logger">, alert: RecoveryAlert): boolean {
  try {
    deps.alertSink.raise(alert);
    return true;
  } catch (err) {
    deps.logger.error({
      event: "recovery",
      alert: true,
      alertCode: "recovery_alert_sink_failed",
      correlationId: alert.correlationId,
      tenantId: alert.tenantId,
      accountId: alert.accountId,
      inboxId: alert.inboxId,
      conversationId: alert.conversationId,
      failedAlertCode: alert.alertCode,
      detail: err instanceof Error ? err.message : "unknown alert sink failure",
    });
    return false;
  }
}

/** The reason code recorded on the ownership hold (a code, never prose; see ownership.ts). */
export const RECOVERY_REASON = "recovery_escalated";

/** Actions whose completion is the customer-facing outcome of a delivery. */
const ANCHOR_ACTIONS: readonly string[] = [WRITE.reply, WRITE.handoffAck];
/** Annotations: best-effort bookkeeping, never a reason to ask a person. */
const ANNOTATION_ACTIONS: readonly string[] = [WRITE.labels, WRITE.customAttributes];
/** Actions that put (or would put) a message in front of a customer or a colleague. */
const MESSAGE_ACTIONS: readonly string[] = [WRITE.reply, WRITE.failureNote, WRITE.handoffNote, WRITE.handoffAck];

export interface RecoveryEscalationDeps {
  config: GatewayConfig;
  ledger: Ledger;
  ownership: OwnershipGate;
  chatwoot: ChatwootApi;
  logger: Logger;
  alertSink: AlertSink;
  failpoint: Failpoint;
  now: () => number;
}

export interface RecoveryEscalationArgs {
  row: RecoverableDelivery;
  binding: Binding;
  identity: LedgerIdentity;
  target: ChatwootTarget;
  /** The conversation display id (non-null: the caller refused a delivery without one). */
  conversationId: number;
  startedAtMs: number;
}

/** "completed": the delivery row was closed. "left_open": it stays open and is swept again. */
export type RecoveryOutcome = "completed" | "left_open";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does Chatwoot's own state say a person has this conversation? Status other than `pending`
 * (open, resolved, snoozed) or an assignee. The same two signals the webhook path's suppression
 * predicate reads, taken from the top level of the conversation record, which does not depend
 * on any message window. Returns the reason, or null when nobody holds it OR it cannot be read.
 */
async function personHoldsInChatwoot(
  chatwoot: ChatwootApi,
  target: ChatwootTarget,
  ownHold: boolean,
): Promise<string | null> {
  let record: unknown;
  try {
    record = await chatwoot.getConversationRecord(target);
  } catch {
    return null;
  }
  if (!isRecord(record)) return null;
  const status = record["status"];
  const meta = record["meta"];
  const assigned = isRecord(meta) && meta["assignee"] !== null && meta["assignee"] !== undefined;
  if (ownHold) {
    // THIS delivery's own hold (Codex R6 G6-3). Its own escalation moves the conversation to
    // `open`, so a plain `open` proves nothing about a person. What a person leaves behind and
    // the gateway never does: an assignee, or a `resolved` / `snoozed` status. READABLE evidence
    // of that overrides the stale hold; an unreadable record changes nothing (fail-open).
    if (assigned) return "human_assigned";
    if (status === "resolved" || status === "snoozed") return `status_${status}`;
    return null;
  }
  if (typeof status === "string" && status !== "pending") return "status_not_pending";
  if (assigned) return "human_assigned";
  return null;
}

/** True only for a delivery whose customer-facing outcome is a COMPLETED row and nothing is in flight. */
export function provablyComplete(actions: readonly DeliveryActionRow[]): boolean {
  const anchored = actions.some((a) => ANCHOR_ACTIONS.includes(a.action) && a.state === "completed");
  if (!anchored) return false;
  return !actions.some((a) => a.state === "in_progress" && !ANNOTATION_ACTIONS.includes(a.action));
}

/**
 * A handoff whose PUBLICATION is durably complete (Codex R6 G6-4): the status change, the private
 * note and the customer acknowledgement are all COMPLETED rows. Such a delivery was interrupted
 * only at the close; recovery must close it, not escalate it again (its own hold is the handoff's
 * hold, not an unfinished escalation). Anything less than all three is an unfinished own hold and
 * is still escalated.
 */
export function handoffPublicationComplete(actions: readonly DeliveryActionRow[]): boolean {
  const done = (name: string): boolean => actions.some((a) => a.action === name && a.state === "completed");
  return done(WRITE.handoffStatus) && done(WRITE.handoffNote) && done(WRITE.handoffAck);
}

function summarise(actions: readonly DeliveryActionRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of actions) {
    out[a.action] = a.state === "failed" ? (a.failureCode ?? "failed") : a.state;
  }
  return out;
}

/** The actions of a delivery that still have NO recorded disposition (Codex R6 G6-2). */
function unsettled(actions: readonly DeliveryActionRow[]): string[] {
  return actions.filter((a) => a.state === "in_progress").map((a) => a.action);
}

/**
 * Close every action still in_progress with a disposition chosen by `codeFor`. Best effort per
 * row, and the RESULT IS THE CONTRACT: the caller must look at what is still unsettled
 * (`unsettled()`) before it closes the delivery, because the sweeper selects unfinished DELIVERY
 * rows, so an in_progress action beneath a closed delivery is never looked at again.
 */
async function settleOpenActions(
  deps: Pick<RecoveryEscalationDeps, "ledger" | "logger">,
  identity: LedgerIdentity,
  codeFor: (action: string) => string,
  base: Record<string, unknown>,
): Promise<DeliveryActionRow[]> {
  let actions = await deps.ledger.deliveryActions(identity);
  for (const a of actions) {
    if (a.state !== "in_progress") continue;
    try {
      await deps.ledger.fail(identity, a.action, codeFor(a.action));
    } catch (err) {
      deps.logger.error({
        ...base,
        event: "recovery",
        alert: true,
        alertCode: "recovery_disposition_not_recorded",
        action: a.action,
        detail: err instanceof Error ? err.message : "unknown ledger failure",
      });
    }
  }
  actions = await deps.ledger.deliveryActions(identity);
  return actions;
}

/**
 * Give up on a delivery that cannot be recovered at all (the attempt cap, a retired binding...).
 * Every open action ends `abandoned`, the delivery fails with a code, and an alert is raised.
 * NEVER silent: the alert is the handle a person picks it up by.
 *
 * Returns whether the delivery row was CLOSED. If any action's disposition cannot be recorded
 * (or the rows cannot be read back to prove they were), the delivery is NOT closed: it stays
 * recoverable and the next sweep tries again (Codex R6 G6-2).
 */
export async function abandonDelivery(
  deps: Pick<RecoveryEscalationDeps, "ledger" | "logger" | "alertSink">,
  row: RecoverableDelivery,
  identity: LedgerIdentity,
  failureCode: string,
  detail: string,
): Promise<boolean> {
  const base = {
    correlationId: row.correlationId,
    tenantId: row.tenantId,
    accountId: row.chatwootAccountId,
    inboxId: row.chatwootInboxId,
    conversationId: row.conversationId,
  };
  let dispositions: Record<string, string> = {};
  let settledOk = false;
  try {
    const settled = await settleOpenActions(deps, identity, () => DISPOSITION.abandoned, base);
    dispositions = summarise(settled);
    settledOk = unsettled(settled).length === 0;
  } catch {
    // The ledger is the thing that failed; the delivery is left open and the alert below says so.
  }
  const alertBase = {
    correlationId: row.correlationId,
    tenantId: row.tenantId,
    accountId: row.chatwootAccountId,
    inboxId: row.chatwootInboxId,
    conversationId: row.conversationId,
    attempts: row.attempts,
    dispositions,
  };
  if (!settledOk) {
    raiseAlert(deps, {
      ...alertBase,
      alertCode: "recovery_disposition_not_recorded",
      detail: `${detail}; an action's disposition could not be recorded, so the delivery is left open and swept again`,
    });
    return false;
  }
  // ALERT BEFORE CLOSE (Codex R6 G6-5): a sink that failed leaves the delivery open, so the next
  // sweep raises the alert again. Closing first would make the required alert un-retryable.
  if (!raiseAlert(deps, { ...alertBase, alertCode: "recovery_abandoned", detail })) return false;
  try {
    await deps.ledger.fail(identity, DELIVERY_ACTION, failureCode);
    return true;
  } catch {
    // The delivery stays open; the next sweep raises the alert again (at-least-once).
    return false;
  }
}

/**
 * Handle one delivery recovery has taken the lease on. Returns whether the delivery row was
 * closed. Never calls the model, never sends a customer message.
 */
export async function recoverDelivery(
  deps: RecoveryEscalationDeps,
  args: RecoveryEscalationArgs,
): Promise<RecoveryOutcome> {
  const { row, binding, identity, target, conversationId } = args;
  const base = {
    correlationId: row.correlationId,
    tenantId: row.tenantId,
    accountId: row.chatwootAccountId,
    inboxId: row.chatwootInboxId,
    conversationId,
  };
  const conversation: ConversationRef = {
    tenantId: binding.tenantId,
    chatwootAccountId: binding.chatwootAccountId,
    chatwootConversationId: conversationId,
    chatwootInboxId: binding.chatwootInboxId,
    bindingId: identity.bindingId,
  };
  const ownOperations = [`escalate:${identity.eventId}`, `handoff:${identity.eventId}`];
  const alertFor = (
    alertCode: RecoveryAlertCode,
    actions: readonly DeliveryActionRow[],
    detail: string,
  ): boolean =>
    raiseAlert(deps, {
      alertCode,
      correlationId: row.correlationId,
      tenantId: row.tenantId,
      accountId: row.chatwootAccountId,
      inboxId: row.chatwootInboxId,
      conversationId,
      attempts: row.attempts,
      dispositions: summarise(actions),
      detail,
    });

  // ---- 1. What does the ledger PROVE? -----------------------------------------------------
  let actions = await deps.ledger.deliveryActions(identity);

  // Positive evidence only: a reply row left in_progress is settled if (and only if) the reply
  // is FOUND. Not found, or cannot tell, proves nothing and changes nothing.
  const replyRow = actions.find((a) => a.action === WRITE.reply);
  if (replyRow !== undefined && replyRow.state === "in_progress" && row.mode !== "handoff") {
    const found = await deps.chatwoot.reconcileDeliveryRef(
      target,
      deliveryRef(identity, WRITE.reply),
      row.messageId,
    );
    if (found.kind === "found") {
      deps.logger.warn({
        ...base,
        event: "recovery",
        outcome: "resolved_already_delivered",
        chatwootMessageId: found.messageId,
        detail: "the reply was already in Chatwoot; the ledger had not recorded it. The reply is settled without sending.",
      });
      await deps.ledger.complete(identity, WRITE.reply, found.messageId);
      actions = await deps.ledger.deliveryActions(identity);
    }
  }

  const view = await deps.ownership.read(conversation);
  const ownHold =
    view.state === "HUMAN_REQUESTED" &&
    view.escalationOperationId !== null &&
    ownOperations.includes(view.escalationOperationId);

  // A disposition that could not be recorded keeps the delivery OPEN (Codex R6 G6-2): the sweeper
  // only ever looks at unfinished DELIVERY rows, so an in_progress action under a closed
  // delivery would be invisible forever. The next sweep tries again.
  const keepOpenUnsettled = (settled: readonly DeliveryActionRow[]): RecoveryOutcome => {
    alertFor(
      "recovery_disposition_not_recorded",
      settled,
      `the disposition of ${unsettled(settled).join(", ")} could not be recorded; the delivery is left open and swept again`,
    );
    return "left_open";
  };

  // An own hold stops a delivery counting as complete -- unless it is the HANDOFF's hold and the
  // handoff's publication is durably complete (Codex R6 G6-4).
  const handoffPublished =
    ownHold &&
    view.escalationOperationId === `handoff:${identity.eventId}` &&
    handoffPublicationComplete(actions);

  if ((!ownHold || handoffPublished) && !view.diverged && provablyComplete(actions)) {
    const settled = await settleOpenActions(deps, identity, () => DISPOSITION.abandoned, base);
    if (unsettled(settled).length > 0) return keepOpenUnsettled(settled);
    await deps.ledger.complete(identity, DELIVERY_ACTION, null);
    deps.logger.info({ ...base, event: "recovery", outcome: "provably_complete" });
    return "completed";
  }

  // ---- 2. SUPERSEDED: a person (or another delivery's hold) already has the conversation ----
  const supersede = async (why: string, suppressionReason?: string): Promise<RecoveryOutcome> => {
    const settled = await settleOpenActions(deps, identity, () => DISPOSITION.superseded, base);
    if (unsettled(settled).length > 0) return keepOpenUnsettled(settled);
    await deps.ledger.complete(identity, DELIVERY_ACTION, null);
    deps.logger.info({
      ...base,
      event: "recovery",
      outcome: "escalation_superseded",
      ...(suppressionReason === undefined ? {} : { suppressionReason }),
      detail: `${why}; nothing was written to the conversation and the open actions were closed as superseded`,
      dispositions: summarise(settled),
    });
    return "completed";
  };

  if (view.diverged) {
    // The stored ownership state was not a value this build recognises: who holds the
    // conversation is UNKNOWN. Do not guess; keep the delivery open and say so.
    alertFor("recovery_escalation_not_visible", actions, "the ownership state could not be read; the delivery is left open");
    return "left_open";
  }
  if (!ownHold && suppressesAutomatedReply(view.state)) {
    return supersede("a person or another delivery's escalation holds the conversation");
  }
  // Chatwoot's own state is a second signal, and it does NOT depend on any message window (status
  // and assignee are top-level fields of the record): a conversation that is no longer pending, or
  // is assigned to a person, is one a person has. Best effort -- an unreadable record is NOT a
  // reason to leave the customer unattended, so it changes nothing.
  {
    const heldBy = await personHoldsInChatwoot(deps.chatwoot, target, ownHold);
    if (heldBy !== null) {
      return supersede(`a person holds the conversation in Chatwoot (${heldBy})`, heldBy);
    }
  }

  // ---- 3. The durable INTENT: the ownership hold ---------------------------------------------
  let episode = view.episode;
  if (!ownHold) {
    let transition;
    try {
      transition = await deps.ownership.requestHuman({
        conversation,
        operationId: `escalate:${identity.eventId}`,
        reason: RECOVERY_REASON,
        actorRef: "gateway:recovery",
        correlationId: row.correlationId,
        expectedEpisode: view.episode,
      });
    } catch (err) {
      deps.logger.error({
        ...base,
        event: "recovery",
        alert: true,
        alertCode: "recovery_hold_not_recorded",
        detail: err instanceof Error ? err.name : "unknown ownership failure",
      });
      alertFor("recovery_escalation_not_visible", actions, "the escalation could not be recorded in the ownership store; the delivery is left open");
      return "left_open";
    }
    if (transition.status === "stale_episode" || transition.state !== "HUMAN_REQUESTED") {
      // The conversation moved to another episode, was taken by a person, or was handed back
      // to the AI after our earlier hold (a replay): there is no hold of ours to publish.
      return supersede("the conversation moved on before this delivery could record its hold");
    }
    episode = transition.episode;
  }

  // ---- 4. The PUBLICATION: note, status change, assignment -------------------------------------
  const turnDeadlineAt = args.startedAtMs + deps.config.turnBudgetMs;
  const turnExpired = (): boolean => deps.now() >= turnDeadlineAt;
  const timedTarget: ChatwootTarget = { ...target, remainingMs: () => Math.max(0, turnDeadlineAt - deps.now()) };
  const authority: NonNullable<WriteContext["authority"]> = {
    heldEpisode: episode,
    fenced: false,
    deadlineExceeded: false,
    episodeAtStart: view.episode,
  };
  const writeDeps: WriteDeps = {
    chatwoot: deps.chatwoot,
    ledger: deps.ledger,
    logger: deps.logger,
    leaseMs: deps.config.ledgerLeaseMs,
    failpoint: deps.failpoint,
  };
  const writes: WriteContext = {
    identity,
    digest: row.payloadDigest,
    correlationId: row.correlationId,
    pivotMessageId: row.messageId,
    base,
    authority,
    turnExpired,
    fence: async (): Promise<boolean> => {
      if (authority.fenced) return false;
      if (turnExpired()) {
        authority.fenced = true;
        authority.deadlineExceeded = true;
        return false;
      }
      const read = await deps.ownership.read(conversation);
      const mine = !read.diverged && read.episode === episode && read.state === "HUMAN_REQUESTED";
      if (!mine) authority.fenced = true;
      return mine;
    },
  };

  const note = renderFailureNote({
    outcome: RECOVERY_REASON,
    correlationId: row.correlationId,
    tenantId: row.tenantId,
  });
  const posted = await sendGuardedMessage(writeDeps, writes, WRITE.failureNote, timedTarget, note, true);
  if (posted.kind === "failed" || posted.kind === "ambiguous") {
    deps.logger.warn({
      ...base,
      event: "recovery",
      outcome: "note_unconfirmed",
      detail: posted.detail,
    });
  }

  let opened = false;
  if (!authority.fenced) {
    try {
      await runGuardedWrite(writeDeps, writes, WRITE.escalateStatus, () => deps.chatwoot.openConversation(timedTarget));
      opened = true;
    } catch (err) {
      if (!(err instanceof WriteFencedError)) {
        deps.logger.error({
          ...base,
          event: "recovery",
          outcome: "toggle_status_failed",
          detail: err instanceof Error ? err.message : "unknown chatwoot failure",
        });
      }
    }
  }

  let assigned = false;
  const teamId = binding.escalationTeamId;
  if (teamId !== undefined && !authority.fenced) {
    try {
      await runGuardedWrite(writeDeps, writes, WRITE.escalateAssignment, () => deps.chatwoot.assignTeam(timedTarget, teamId));
      assigned = true;
    } catch (err) {
      if (!(err instanceof WriteFencedError)) {
        deps.logger.error({
          ...base,
          event: "recovery",
          outcome: "assignment_failed",
          teamId,
          detail: err instanceof Error ? err.message : "unknown chatwoot failure",
        });
      }
    }
  }

  // ---- 5. Fenced: the budget ran out, or a person took the conversation meanwhile --------------
  if (authority.fenced) {
    if (authority.deadlineExceeded) {
      // Not a decision, a retry: the claims were released and the delivery stays open.
      deps.logger.warn({
        ...base,
        event: "recovery",
        outcome: "turn_budget_exhausted",
        detail: "the turn budget ran out during the escalation; the delivery is left open and swept again",
      });
      return "left_open";
    }
    return supersede("a person took the conversation while the escalation was being published");
  }

  // ---- 6. Visible? ----------------------------------------------------------------------------------
  const visible = opened || assigned;
  if (!visible) {
    alertFor(
      "recovery_escalation_not_visible",
      await deps.ledger.deliveryActions(identity),
      "the hold is recorded but neither the status change nor the assignment reached Chatwoot; nobody has been shown the conversation yet and the delivery is left open",
    );
    return "left_open";
  }

  // ---- 7. The DISPOSITIONS, then close ----------------------------------------------------------------
  const finalActions = await settleOpenActions(
    deps,
    identity,
    (action) => (MESSAGE_ACTIONS.includes(action) ? DISPOSITION.notSentEscalated : DISPOSITION.abandoned),
    base,
  );
  if (unsettled(finalActions).length > 0) return keepOpenUnsettled(finalActions);
  // ALERT BEFORE CLOSE (Codex R6 G6-5): a sink that failed leaves the delivery open and the next
  // sweep raises the alert again (publication is idempotent by claim, so nothing is re-sent).
  const alerted = alertFor(
    "recovery_escalated_to_human",
    finalActions,
    "a delivery that could not be proven complete was escalated to a person once; nothing was resent to the customer",
  );
  if (!alerted) return "left_open";
  await deps.ledger.complete(identity, DELIVERY_ACTION, null);
  return "completed";
}
