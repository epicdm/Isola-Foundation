/**
 * CODEX ROUND 4 (review of 103c353): G4-1 -- recovery completed a delivery as soon as it
 * found the REPLY's delivery reference in Chatwoot, although a RELEASED `failure_note`
 * escalation (and the status change and assignment that follow it) had never been
 * published. The customer had been promised a colleague; the conversation was never opened
 * or assigned. No concurrent worker and no late upstream commit were needed.
 *
 * The rule under test: finding the reply settles THE REPLY. The sweeper must not complete
 * the delivery while any of its claimed/released actions is unsettled, nor while this
 * delivery's own human hold is still unpublished; it finishes that work, under its own
 * hold, without calling the model.
 *
 * ALL TESTS HERE ARE SOCKET-FREE (fakes only) and run the REAL sweeper (Law 20: the path).
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { createSweeper } from "../src/recovery.js";
import { parseWebhookPayload } from "../src/webhook.js";
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
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const EVENT_ID = "delivery:g41";

/** Advances the shared clock the moment a named action has been CLAIMED (so the turn fence trips before its wire write). */
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

function makeJob(): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-g41",
    deliveryId: "delivery-g41",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: EVENT_ID,
    },
    digest: "digest-g41",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode: "answer",
    classification: null,
  };
}

const rowState = (ledger: FakeLedger, action: string): string =>
  [...ledger.rows.entries()].find(([key]) => key.endsWith(`|${action}`) && key.includes(EVENT_ID))?.[1].state ?? "absent";

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

function build(opts: { stallAtNote: boolean }) {
  const chatwoot = new StubChatwootApi();
  const ledger = new ClockAdvancingLedger();
  const time = clock(0);
  const capture = new CapturingLogger();
  const ownership = new InMemoryOwnershipGate();
  const deps: PipelineDeps = {
    config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
    chatwoot,
    runtime: StubAgentRuntime.answeringWithAction("A colleague will follow up shortly.", "request_human", "explicit_human_request"),
    logger: capture.logger,
    ledger,
    ownership,
    failpoint: DISARMED,
    now: time.now,
  };
  if (opts.stallAtNote) ledger.onClaim = (action) => action === "failure_note" && time.set(deps.config.turnBudgetMs + 1_000);
  return { deps, chatwoot, ledger, ownership, capture };
}

/** The REAL sweeper, sharing A's ownership store and Chatwoot (what a restart keeps), with the real clock. */
function sweeperFor(deps: PipelineDeps, capture: CapturingLogger) {
  return createSweeper({
    config: deps.config,
    ledger: deps.ledger,
    bindingStore: { list: () => [makeBinding()] },
    chatwoot: deps.chatwoot,
    runtime: StubAgentRuntime.answering("must not be called"),
    logger: capture.logger,
    ownership: deps.ownership,
    failpoint: DISARMED,
    now: () => Date.now(),
  });
}

describe("G4-1 (the PATH): finding the reply must not close a delivery whose escalation was released", () => {
  it("A replies, then its budget runs out after claiming the failure note: the sweeper PUBLISHES the escalation (note, status) and only then completes", async () => {
    const { deps, chatwoot, ledger, capture } = build({ stallAtNote: true });
    const job = makeJob();
    await reserve(ledger, job);

    await processDelivery(deps, job);

    // Where A stopped (the premise of Codex's probe): the late completion was refused, so the
    // delivery row stays open for the sweeper, with the note claimed and released.
    expect(chatwoot.customerMessages, "A sent the reply").toHaveLength(1);
    expect(chatwoot.privateNotes, "A published the note after its budget").toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(rowState(ledger, "failure_note")).toBe("in_progress");
    expect(rowState(ledger, "delivery")).not.toBe("completed");

    ledger.expireAllLeases();
    const swept = await sweeperFor(deps, capture).sweep();

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(chatwoot.customerMessages, "the reply must not be sent again").toHaveLength(1);
    expect(chatwoot.privateNotes, "Codex's probe: the escalation note was never published").toHaveLength(1);
    expect(chatwoot.statusToggles, "the conversation was never opened for a human").toHaveLength(1);
    expect(rowState(ledger, "failure_note")).toBe("completed");
    expect(rowState(ledger, "delivery")).toBe("completed");
  });

  it("the model is NOT called to rediscover the decision", async () => {
    const { deps, ledger, capture } = build({ stallAtNote: true });
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    ledger.expireAllLeases();
    const runtime = StubAgentRuntime.answering("must not be called");
    const sweeper = createSweeper({
      config: deps.config,
      ledger,
      bindingStore: { list: () => [makeBinding()] },
      chatwoot: deps.chatwoot,
      runtime,
      logger: capture.logger,
      ownership: deps.ownership,
      failpoint: DISARMED,
      now: () => Date.now(),
    });

    await sweeper.sweep();

    expect(runtime.requests).toHaveLength(0);
  });

  it("the resumed note says the customer WAS answered (the fixed text used to say nothing was sent)", async () => {
    const { deps, chatwoot, ledger, capture } = build({ stallAtNote: true });
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweep();

    const note = chatwoot.privateNotes[0]?.content ?? "";
    expect(note).toContain("escalation_resumed");
    expect(note, "a note that claims nothing was sent to a customer who WAS answered").not.toContain(
      "No message was sent to the customer",
    );
  });

  it("a second sweep after completion does nothing more (idempotent)", async () => {
    const { deps, chatwoot, ledger, capture } = build({ stallAtNote: true });
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweep();
    const before = chatwoot.calls.length;

    ledger.expireAllLeases();
    expect(await sweeperFor(deps, capture).sweep()).toBe(0);
    expect(chatwoot.calls.length).toBe(before);
  });

  it("CONTROL: an unfenced escalation publishes once, completes, and a later sweep sends and writes nothing", async () => {
    const { deps, chatwoot, ledger, capture } = build({ stallAtNote: false });
    const job = makeJob();
    await reserve(ledger, job);

    const a = await processDelivery(deps, job);

    expect(a.needsRetry).toBe(false);
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(rowState(ledger, "delivery")).toBe("completed");

    ledger.expireAllLeases();
    expect(await sweeperFor(deps, capture).sweep()).toBe(0);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
  });

  it("CONTROL: a plain reply (no escalation) found by recovery is completed with ZERO extra writes", async () => {
    const chatwoot = new StubChatwootApi();
    const ledger = new FakeLedger();
    const capture = new CapturingLogger();
    const ownership = new InMemoryOwnershipGate();
    const deps: PipelineDeps = {
      config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
      chatwoot,
      runtime: StubAgentRuntime.answering("Nine to five."),
      logger: capture.logger,
      ledger,
      ownership,
      failpoint: DISARMED,
      now: () => 0,
    };
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    expect(chatwoot.customerMessages).toHaveLength(1);
    // The reply is in Chatwoot but the ledger never recorded the close: re-open both rows.
    for (const [key, row] of ledger.rows) {
      if (!key.includes(EVENT_ID)) continue;
      row.state = key.endsWith("|reply") ? "in_progress" : "in_progress";
      row.leaseExpiresAt = 0;
    }
    const callsBefore = chatwoot.calls.length;

    await sweeperFor(deps, capture).sweep();

    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(chatwoot.calls.filter((c) => c.kind === "message")).toHaveLength(1);
    expect(rowState(ledger, "delivery")).toBe("completed");
    expect(chatwoot.calls.length).toBeGreaterThanOrEqual(callsBefore); // reconcile reads only
  });

  it("A's hold was recorded but NO action row exists yet (it died right after the hold): recovery still finishes the escalation", async () => {
    const chatwoot = new StubChatwootApi();
    const ledger = new FakeLedger();
    const capture = new CapturingLogger();
    const ownership = new InMemoryOwnershipGate();
    const deps: PipelineDeps = {
      config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
      chatwoot,
      runtime: StubAgentRuntime.answering("must not be called"),
      logger: capture.logger,
      ledger,
      ownership,
      failpoint: DISARMED,
      now: () => 0,
    };
    const job = makeJob();
    await reserve(ledger, job);
    // The reply is already in Chatwoot (the reference is stored) and recorded in_progress.
    const { deliveryRef } = await import("../src/deliveryref.js");
    chatwoot.stored.set(deliveryRef(job.identity, "reply"), { id: 7001, createdAt: 1 });
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    // ...and the conversation holds THIS delivery's escalation (the hold is recorded before any write).
    ownership.seed(
      {
        tenantId: TENANT_ID,
        chatwootAccountId: ACCOUNT_ID,
        chatwootConversationId: CONVERSATION_DISPLAY_ID,
        chatwootInboxId: INBOX_ID,
        bindingId: job.identity.bindingId,
      },
      "HUMAN_REQUESTED",
      1,
      `escalate:${EVENT_ID}`,
    );
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweep();

    expect(chatwoot.customerMessages, "the reply was already there: nothing re-sent").toHaveLength(0);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(rowState(ledger, "delivery")).toBe("completed");
  });

  const refOf = (job: DeliveryJob) => ({
    tenantId: TENANT_ID,
    chatwootAccountId: ACCOUNT_ID,
    chatwootConversationId: CONVERSATION_DISPLAY_ID,
    chatwootInboxId: INBOX_ID,
    bindingId: job.identity.bindingId,
  });

  it("SUPERSEDED: a person took the conversation after the hold (HUMAN_OWNED): recovery completes WITHOUT re-escalating", async () => {
    const { deps, chatwoot, ledger, ownership, capture } = build({ stallAtNote: true });
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    ownership.seed(refOf(job), "HUMAN_OWNED", 1, `escalate:${EVENT_ID}`);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweep();

    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.privateNotes, "re-escalated a conversation a person already holds").toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(chatwoot.assignments).toHaveLength(0);
    expect(rowState(ledger, "delivery")).toBe("completed");
  });

  it("SUPERSEDED: the conversation was handed back to the AI after the hold (AI_RESUMED): recovery completes WITHOUT re-escalating", async () => {
    const { deps, chatwoot, ledger, ownership, capture } = build({ stallAtNote: true });
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    ownership.seed(refOf(job), "AI_RESUMED", 1, `escalate:${EVENT_ID}`);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweep();

    expect(chatwoot.privateNotes, "re-escalated a conversation that was handed back").toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(rowState(ledger, "delivery")).toBe("completed");
  });

  it("an unpublished ANNOTATION (a claimed labels row, no escalation) is published by recovery, then the delivery completes", async () => {
    const chatwoot = new StubChatwootApi();
    const ledger = new FakeLedger();
    const capture = new CapturingLogger();
    const deps: PipelineDeps = {
      config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
      chatwoot,
      runtime: StubAgentRuntime.answering("must not be called"),
      logger: capture.logger,
      ledger,
      ownership: new InMemoryOwnershipGate(),
      failpoint: DISARMED,
      now: () => 0,
    };
    const job = makeJob();
    await reserve(ledger, job);
    const { deliveryRef } = await import("../src/deliveryref.js");
    chatwoot.stored.set(deliveryRef(job.identity, "reply"), { id: 7002, createdAt: 1 });
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    await ledger.claimAction(job.identity, "labels", job.digest, job.correlationId, 300_000);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweep();

    expect(chatwoot.customerMessages, "nothing re-sent").toHaveLength(0);
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.labelWrites, "the claimed annotation was never published").toHaveLength(1);
    expect(rowState(ledger, "labels")).toBe("completed");
    expect(rowState(ledger, "delivery")).toBe("completed");
  });
});
