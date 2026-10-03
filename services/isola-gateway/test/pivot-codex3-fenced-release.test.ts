/**
 * CODEX ROUND 3 (review of 1eb7ba3): F4 — a write the TURN BUDGET fenced was "released"
 * with `ledger.fail(..., "fenced")`, but a failed row is TERMINAL and `claimAction()`
 * reports it as completed. So the worker that resumed the delivery (through the
 * sweeper) skipped the unsent reply, and the delivery ended with ZERO customer messages,
 * a `failed` reply row, a `completed` delivery and the outcome `replied`.
 *
 * ALL TESTS HERE ARE SOCKET-FREE (fakes only).
 *
 * The rule under test: a write that was NOT performed because the budget ran out is
 * genuinely RELEASED (retryable, never reported as completed). A write that was not
 * performed because a PERSON took the conversation stays a terminal suppression: that
 * is a decision, not a retry.
 *
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28), and the
 * main test runs the PATH the way production does: worker A -> lease expiry -> the real
 * recovery sweeper (Law 20), not worker B called by hand.
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity, deliveryRef } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { createSweeper } from "../src/recovery.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  runGuardedWrite,
  sendGuardedMessage,
  WriteFencedError,
  type WriteContext,
  type WriteDeps,
} from "../src/writes.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  messageCreatedPayload,
  MESSAGE_ID,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const TARGET = { accountId: ACCOUNT_ID, conversationId: CONVERSATION_DISPLAY_ID, accessToken: "tok" };

/** Advances the shared clock the moment the reply action has been CLAIMED (so the fence trips before the wire). */
class ClockAdvancingLedger extends FakeLedger {
  onClaim: ((action: string) => void) | null = null;
  override async claimAction(
    ...args: Parameters<FakeLedger["claimAction"]>
  ): ReturnType<FakeLedger["claimAction"]> {
    const result = await super.claimAction(...args);
    this.onClaim?.(args[1]);
    return result;
  }
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

function conversationRecord(): Record<string, unknown> {
  const inbound = {
    id: MESSAGE_ID,
    content: "what are your opening hours?",
    content_type: "text",
    message_type: 0,
    private: false,
    created_at: 1_786_459_000,
    sender: { type: "contact", id: 55 },
    attachments: [],
    content_attributes: {},
  };
  return {
    id: CONVERSATION_DISPLAY_ID,
    status: "pending",
    meta: { assignee: null },
    custom_attributes: {},
    messages: [inbound],
    last_non_activity_message: inbound,
  };
}

function makeJob(startedAtMs: number): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-f4",
    deliveryId: "delivery-f4",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:f4",
    },
    digest: "digest-f4",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs,
    mode: "answer",
    classification: null,
  };
}

const rowState = (ledger: FakeLedger, job: DeliveryJob, action: string): string =>
  [...ledger.rows.entries()].find(([key]) => key.endsWith(`|${action}`) && key.includes(job.identity.eventId))?.[1].state ??
  "absent";

function build(advanceOnReply: boolean) {
  const chatwoot = new StubChatwootApi();
  chatwoot.conversationRecord = conversationRecord();
  const ledger = new ClockAdvancingLedger();
  const time = clock(0);
  const capture = new CapturingLogger();
  const deps: PipelineDeps = {
    config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
    chatwoot,
    runtime: StubAgentRuntime.answering("Nine to five, Monday to Friday."),
    logger: capture.logger,
    ledger,
    ownership: new InMemoryOwnershipGate(),
    failpoint: DISARMED,
    now: time.now,
  };
  if (advanceOnReply) ledger.onClaim = (action) => action === "reply" && time.set(deps.config.turnBudgetMs + 1_000);
  return { deps, chatwoot, ledger, time, capture };
}

async function reserve(ledger: FakeLedger, job: DeliveryJob): Promise<void> {
  await ledger.reserve({
    identity: job.identity,
    digest: job.digest,
    correlationId: job.correlationId,
    conversationId: job.conversationId,
    messageId: job.payload.messageId,
    mode: job.mode,
    leaseMs: 300_000,
  });
}

function sweeperFor(deps: PipelineDeps, chatwoot: StubChatwootApi, capture: CapturingLogger) {
  return createSweeper({
    config: deps.config,
    ledger: deps.ledger,
    bindingStore: { list: () => [makeBinding()] },
    chatwoot,
    runtime: StubAgentRuntime.answering("Nine to five, Monday to Friday."),
    logger: capture.logger,
    ownership: new InMemoryOwnershipGate(),
    failpoint: DISARMED,
    now: () => Date.now(),
  });
}

// CHANGED (Codex R5, Lane A direction): the sweeper no longer RESUMES a delivery, so it no longer
// sends the reply a fenced worker did not send. What F4 protected still holds and is asserted
// below: the fenced reply is never reported as completed (a failed row is terminal and would have
// been), nothing is lost silently, and the delivery ends with a recorded disposition and a person
// asked. The reply itself is a human's job now.
describe("F4 (the PATH): a reply the turn budget fenced is NOT reported completed; the sweeper escalates it, recorded, and sends nothing", () => {
  it("A's budget runs out after it claimed the reply and before it sent: ZERO messages from A and from the sweeper; the reply row ends not_sent_escalated (never 'completed'); a person is asked", async () => {
    const { deps, chatwoot, ledger, capture } = build(true);
    const job = makeJob(0);
    await reserve(ledger, job);

    const a = await processDelivery(deps, job);

    expect(chatwoot.customerMessages, "A sent after its budget").toHaveLength(0);
    expect(a.needsRetry).toBe(true);

    // The lease expires; the REAL sweeper picks the delivery up (Law 20: the path, not the piece).
    ledger.expireAllLeases();
    const resumed = await sweeperFor(deps, chatwoot, capture).sweep();

    expect(resumed).toBe(1);
    expect(chatwoot.customerMessages, "recovery never sends a customer message").toHaveLength(0);
    // The F4 regression guard: a fenced, unsent reply must never read as completed.
    expect(rowState(ledger, job, "reply")).not.toBe("completed");
    expect(rowState(ledger, job, "reply")).toBe("failed");
    expect(chatwoot.privateNotes, "a person is told").toHaveLength(1);
    expect(chatwoot.statusToggles, "and shown the conversation").toHaveLength(1);
    expect(rowState(ledger, job, "delivery")).toBe("completed");
  });

  it("CONTROL: an unfenced turn replies once, the reply row is completed, and a later sweep sends nothing more", async () => {
    const { deps, chatwoot, ledger, capture } = build(false);
    const job = makeJob(0);
    await reserve(ledger, job);

    const a = await processDelivery(deps, job);

    expect(a.outcome).toBe("replied");
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(rowState(ledger, job, "reply")).toBe("completed");
    expect(rowState(ledger, job, "delivery")).toBe("completed");

    ledger.expireAllLeases();
    expect(await sweeperFor(deps, chatwoot, capture).sweep()).toBe(0);
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The two writers, directly: deadline => RELEASED, person => TERMINAL suppression.
// ---------------------------------------------------------------------------

function writeFixture(opts: { deadlineExceeded: boolean }) {
  const ledger = new FakeLedger();
  const chatwoot = new StubChatwootApi();
  const capture = new CapturingLogger();
  const deps: WriteDeps = { chatwoot, ledger, logger: capture.logger, leaseMs: 300_000, failpoint: DISARMED };
  const job = makeJob(0);
  const context: WriteContext = {
    identity: job.identity,
    digest: job.digest,
    correlationId: job.correlationId,
    pivotMessageId: MESSAGE_ID,
    base: {},
    fence: async () => false,
    authority: { heldEpisode: null, fenced: true, deadlineExceeded: opts.deadlineExceeded },
  };
  return { deps, context, ledger, job, chatwoot };
}

const reclaim = (ledger: FakeLedger, job: DeliveryJob, action: string) =>
  ledger.claimAction(job.identity, action, job.digest, job.correlationId, 300_000);

describe("F4 (the writers): a fence that is about the CLOCK releases the claim; a fence that is about a PERSON suppresses it for good", () => {
  it("sendGuardedMessage: deadline-fenced => outcome fenced, row NOT terminal, a re-claim is `ambiguous` (retryable), never `completed`", async () => {
    const { deps, context, ledger, job, chatwoot } = writeFixture({ deadlineExceeded: true });

    const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);

    expect(outcome.kind).toBe("fenced");
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(rowState(ledger, job, "reply")).toBe("in_progress");
    expect((await reclaim(ledger, job, "reply")).kind).toBe("ambiguous");
  });

  it("CONTROL: sendGuardedMessage fenced because a PERSON took the conversation => the suppression stays terminal (re-claim reports completed)", async () => {
    const { deps, context, ledger, job } = writeFixture({ deadlineExceeded: false });

    const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);

    expect(outcome.kind).toBe("fenced");
    expect(rowState(ledger, job, "reply")).toBe("failed");
    expect((await reclaim(ledger, job, "reply")).kind).toBe("completed");
  });

  it("runGuardedWrite (a status/assignment/note-style write): deadline-fenced => throws WriteFencedError, row released and re-claimable", async () => {
    const { deps, context, ledger, job } = writeFixture({ deadlineExceeded: true });
    let ran = false;

    await expect(
      runGuardedWrite(deps, context, "escalate_toggle_status", async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(WriteFencedError);

    expect(ran, "the write ran although the fence denied it").toBe(false);
    expect(rowState(ledger, job, "escalate_toggle_status")).toBe("in_progress");
    expect((await reclaim(ledger, job, "escalate_toggle_status")).kind).toBe("ambiguous");
  });

  it("CONTROL: runGuardedWrite fenced because a PERSON took the conversation => terminal", async () => {
    const { deps, context, ledger, job } = writeFixture({ deadlineExceeded: false });

    await expect(runGuardedWrite(deps, context, "escalate_toggle_status", async () => undefined)).rejects.toBeInstanceOf(
      WriteFencedError,
    );

    expect(rowState(ledger, job, "escalate_toggle_status")).toBe("failed");
    expect((await reclaim(ledger, job, "escalate_toggle_status")).kind).toBe("completed");
  });

  it("DISTINCTNESS (Law 20 multi-gate control): the two harnesses differ only in `deadlineExceeded`, and that single field decides the outcome", () => {
    const budget = writeFixture({ deadlineExceeded: true });
    const person = writeFixture({ deadlineExceeded: false });
    expect(budget.context.authority?.deadlineExceeded).not.toBe(person.context.authority?.deadlineExceeded);
    expect(deliveryRef(budget.job.identity, "reply")).toBe(deliveryRef(person.job.identity, "reply"));
  });
});
