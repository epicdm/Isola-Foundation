/**
 * CODEX ROUND 5 (review of e5dbea9): G5-1, G5-2, G5-4 -- four rounds in a row found new defects
 * in the recovery RESUMPTION logic, because it depended on what a Chatwoot message window can
 * show (reply visibility, rebuilding the inbound message, pivoting a note off the inbound id).
 *
 * LANE A's direction, and the rule under test: STOP RESUMING CLEVERLY. Any delivery that is not
 * PROVABLY COMPLETE when recovery finds it gets exactly ONE durable, RECORDED escalation to a
 * human, by a mechanism that does NOT depend on reply visibility or on rebuilding the inbound
 * message: the ownership hold (the durable intent), then the note, the status change and the
 * assignment performed idempotently, then an explicit DISPOSITION on every action row so nothing
 * stays in_progress beneath a closed delivery, then an alert. An uncertain customer message is
 * NEVER re-sent. A person who already holds the conversation is never re-escalated.
 *
 * Every test runs the REAL sweeper (Law 20: the path, not the pieces) against the stub Chatwoot
 * in its WINDOW model (`useVisibilityWindow`): what an AgentBot can really see, where a newer
 * message HIDES an older one. (The old stub searched an unrestricted map, which is how G4's
 * tests passed while the production client could not prove a released note absent.)
 *
 * ALL TESTS HERE ARE SOCKET-FREE. Every refusal has its positive twin in the same harness
 * (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity, deliveryRef } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { createSweeper } from "../src/recovery.js";
import { DISPOSITION, type RecoveryAlert } from "../src/recovery-escalation.js";
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
  MESSAGE_ID,
  messageCreatedPayload,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const EVENT_ID = "delivery:g5";

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

function makeJob(mode: "answer" | "handoff" = "answer"): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-g5",
    deliveryId: "delivery-g5",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: EVENT_ID,
    },
    digest: "digest-g5",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode,
    classification: null,
  };
}

const refOf = (job: DeliveryJob) => ({
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
  chatwootInboxId: INBOX_ID,
  bindingId: job.identity.bindingId,
});

interface RowInfo {
  state: string;
  failureCode: string | null;
}

function row(ledger: FakeLedger, action: string): RowInfo | null {
  const found = [...ledger.rows.entries()].find(([key]) => key.endsWith(`|${action}`) && key.includes(EVENT_ID));
  if (found === undefined) return null;
  return { state: found[1].state, failureCode: found[1].failureCode ?? null };
}

const stateOf = (ledger: FakeLedger, action: string): string => row(ledger, action)?.state ?? "absent";

/** Every action row beneath the delivery that is still in_progress (must be none under a closed delivery). */
function inProgressActions(ledger: FakeLedger): string[] {
  return [...ledger.rows.entries()]
    .filter(([key, r]) => key.includes(EVENT_ID) && !key.endsWith("|delivery") && r.state === "in_progress")
    .map(([key]) => key.slice(key.lastIndexOf("|") + 1))
    .sort();
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

function build(opts: { stallAt?: string; answer?: "reply" | "escalating_reply" } = {}) {
  const chatwoot = new StubChatwootApi();
  chatwoot.useVisibilityWindow(MESSAGE_ID);
  const ledger = new ClockAdvancingLedger();
  const time = clock(0);
  const capture = new CapturingLogger();
  const ownership = new InMemoryOwnershipGate();
  const deps: PipelineDeps = {
    config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
    chatwoot,
    runtime:
      opts.answer === "reply"
        ? StubAgentRuntime.answering("Nine to five.")
        : StubAgentRuntime.answeringWithAction("A colleague will follow up shortly.", "request_human", "explicit_human_request"),
    logger: capture.logger,
    ledger,
    ownership,
    failpoint: DISARMED,
    now: time.now,
  };
  if (opts.stallAt !== undefined) {
    const at = opts.stallAt;
    ledger.onClaim = (action) => action === at && time.set(deps.config.turnBudgetMs + 1_000);
  }
  return { deps, chatwoot, ledger, ownership, capture };
}

/** The REAL sweeper, sharing the ownership store and Chatwoot (what a restart keeps), with the real clock. */
function sweeperFor(
  deps: PipelineDeps,
  capture: CapturingLogger,
  extra: { alertSink?: { raise(alert: RecoveryAlert): void }; bindings?: () => ReturnType<typeof makeBinding>[] } = {},
) {
  const runtime = StubAgentRuntime.answering("must not be called");
  const sweeper = createSweeper({
    config: deps.config,
    ledger: deps.ledger,
    bindingStore: { list: extra.bindings ?? (() => [makeBinding()]) },
    chatwoot: deps.chatwoot,
    runtime,
    logger: capture.logger,
    ownership: deps.ownership,
    ...(extra.alertSink === undefined ? {} : { alertSink: extra.alertSink }),
    failpoint: DISARMED,
    now: () => Date.now(),
  });
  return { sweeper, runtime };
}

function collectingSink() {
  const alerts: RecoveryAlert[] = [];
  return { alerts, sink: { raise: (a: RecoveryAlert) => void alerts.push(a) } };
}

// ---------------------------------------------------------------------------
// The harness itself: a control that it models the REAL window (Laws 11, 23)
// ---------------------------------------------------------------------------

describe("the stub models the REAL visibility window (the instrument is part of the system under test)", () => {
  it("a reply is FOUND while it is the newest message; a later PRIVATE NOTE hides it (inconclusive), and an activity line does not", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.useVisibilityWindow(MESSAGE_ID);
    const target = { accountId: ACCOUNT_ID, conversationId: CONVERSATION_DISPLAY_ID, accessToken: "t" };
    const replyRef = "ref-reply";
    await chatwoot.postMessage(target, "hello", false, replyRef);
    expect((await chatwoot.reconcileDeliveryRef(target, replyRef, MESSAGE_ID)).kind).toBe("found");

    await chatwoot.openConversation(target); // an activity line: the newest message, but not a real one
    expect((await chatwoot.reconcileDeliveryRef(target, replyRef, MESSAGE_ID)).kind, "an activity line must not hide it").toBe("found");

    await chatwoot.postMessage(target, "internal note", true, "ref-note");
    const hidden = await chatwoot.reconcileDeliveryRef(target, replyRef, MESSAGE_ID);
    expect(hidden.kind, "a newer private note hides the reply from the bot's window").toBe("inconclusive");
    // ...and the unrestricted map still holds it: that is exactly the stronger visibility the old stub had.
    expect(chatwoot.stored.has(replyRef)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G5-1: a published private note hides the reply; recovery must still escalate
// ---------------------------------------------------------------------------

describe("G5-1 (the PATH): recovery escalates even when the reply is hidden and the inbound message is gone", () => {
  it("reply landed, hold + note landed, the budget ran out before the status change: the sweeper OPENS the conversation, completes, re-sends nothing", async () => {
    const { deps, chatwoot, ledger, capture } = build({ stallAt: "escalate_toggle_status" });
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);

    await processDelivery(deps, job);

    // The premise of Codex's probe.
    expect(chatwoot.customerMessages, "A sent the reply").toHaveLength(1);
    expect(chatwoot.privateNotes, "the note landed and now HIDES the reply from the window").toHaveLength(1);
    expect(chatwoot.statusToggles, "the status change never happened").toHaveLength(0);
    expect(stateOf(ledger, "delivery")).not.toBe("completed");

    ledger.expireAllLeases();
    const { sweeper, runtime } = sweeperFor(deps, capture, { alertSink: sink });
    await sweeper.sweep();

    expect(chatwoot.statusToggles, "Codex's probe: ZERO opening requests, the unfinished hold remained").toHaveLength(1);
    expect(chatwoot.customerMessages, "nothing re-sent").toHaveLength(1);
    expect(chatwoot.privateNotes, "the note had already landed: not posted again").toHaveLength(1);
    expect(stateOf(ledger, "delivery"), "the delivery must NOT go failed (recovery_message_missing)").toBe("completed");
    expect(inProgressActions(ledger), "nothing may stay in_progress beneath a closed delivery").toEqual([]);
    expect(runtime.requests, "the model is never re-driven").toHaveLength(0);
    expect(capture.lines.filter((l) => l["alertCode"] === "recovery_message_missing")).toHaveLength(0);
    expect(alerts.map((a) => a.alertCode)).toEqual(["recovery_escalated_to_human"]);
  });
});

// ---------------------------------------------------------------------------
// G5-2: a released note cannot be proven absent; it gets a recorded disposition
// ---------------------------------------------------------------------------

describe("G5-2 (the PATH): a released note that cannot be proven absent is NOT blindly resent and is NOT left in_progress", () => {
  it("reply landed, the failure note was claimed then released: no second note, the conversation is opened, the note row ends with an explicit disposition", async () => {
    const { deps, chatwoot, ledger, capture } = build({ stallAt: "failure_note" });
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(stateOf(ledger, "failure_note")).toBe("in_progress");

    ledger.expireAllLeases();
    const { sweeper } = sweeperFor(deps, capture);
    await sweeper.sweep();

    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.privateNotes, "the reply is newer than the inbound message: the note's absence is unprovable, so it is not resent").toHaveLength(0);
    expect(chatwoot.statusToggles, "a person is still shown the conversation").toHaveLength(1);
    expect(row(ledger, "failure_note")).toEqual({ state: "failed", failureCode: DISPOSITION.notSentEscalated });
    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(inProgressActions(ledger)).toEqual([]);
  });

  it("CONTROL: when the note's absence IS provable (it was claimed on a delivery whose reply never landed), the note is posted exactly once", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.useVisibilityWindow(MESSAGE_ID);
    const ledger = new FakeLedger();
    const capture = new CapturingLogger();
    const deps: PipelineDeps = {
      config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
      chatwoot,
      runtime: StubAgentRuntime.answering("unused"),
      logger: capture.logger,
      ledger,
      ownership: new InMemoryOwnershipGate(),
      failpoint: DISARMED,
      now: () => 0,
    };
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "failure_note", job.digest, job.correlationId, 300_000);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.privateNotes, "nothing is newer than the inbound message: absence is provable").toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(stateOf(ledger, "failure_note")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// G5-4: an unreadable recovery response is not an abandonment
// ---------------------------------------------------------------------------

describe("G5-4 (the PATH): an unreadable conversation record (200 {}) produces the SAME one recorded escalation, never a silent abandonment", () => {
  for (const [label, body] of [
    ["an empty object", {}],
    ["null", null],
  ] as Array<[string, unknown]>) {
    it(`a reserved delivery with an ambiguous reply and ${label} as the conversation: one note, one opening, zero customer messages, delivery COMPLETED`, async () => {
      const chatwoot = new StubChatwootApi();
      chatwoot.servedRecord = body;
      const ledger = new FakeLedger();
      const capture = new CapturingLogger();
      const { alerts, sink } = collectingSink();
      const deps: PipelineDeps = {
        config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
        chatwoot,
        runtime: StubAgentRuntime.answering("unused"),
        logger: capture.logger,
        ledger,
        ownership: new InMemoryOwnershipGate(),
        failpoint: DISARMED,
        now: () => 0,
      };
      const job = makeJob();
      await reserve(ledger, job);
      await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
      ledger.expireAllLeases();

      await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();

      expect(stateOf(ledger, "delivery"), "Codex's probe: terminally FAILED with no human asked").toBe("completed");
      expect(chatwoot.privateNotes).toHaveLength(1);
      expect(chatwoot.statusToggles).toHaveLength(1);
      expect(chatwoot.customerMessages, "an uncertain customer message is never re-sent").toHaveLength(0);
      expect(row(ledger, "reply")).toEqual({ state: "failed", failureCode: DISPOSITION.notSentEscalated });
      expect(capture.lines.filter((l) => l["alertCode"] === "recovery_message_missing")).toHaveLength(0);
      expect(alerts.map((a) => a.alertCode)).toEqual(["recovery_escalated_to_human"]);
    });
  }
});

// ---------------------------------------------------------------------------
// The rule: any delivery that is not provably complete is escalated exactly once
// ---------------------------------------------------------------------------

describe("the fail-closed recovery rule", () => {
  it("a delivery that never started (reserved, no action rows) is escalated ONCE: hold, note, opening; no model call, no customer message", async () => {
    const { deps, chatwoot, ledger, ownership, capture } = build();
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    ledger.expireAllLeases();

    const { sweeper, runtime } = sweeperFor(deps, capture, { alertSink: sink });
    await sweeper.sweep();

    expect(runtime.requests).toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(inProgressActions(ledger)).toEqual([]);
    const held = await ownership.read(refOf(job));
    expect(held.state, "the durable intent: the conversation is held for a person").toBe("HUMAN_REQUESTED");
    expect(held.escalationOperationId).toBe(`escalate:${EVENT_ID}`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alertCode: "recovery_escalated_to_human", correlationId: "corr-g5", tenantId: TENANT_ID });
  });

  it("is IDEMPOTENT: a second sweep after completion does nothing, and an escalation that was not visible is finished by the next sweep with ONE note in total", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    ledger.expireAllLeases();
    chatwoot.openConversationFailure = new (await import("../src/errors.js")).ChatwootApiError("returned HTTP 500", 500);

    // First sweep: the status change fails. Nothing shows the conversation to a person.
    await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();
    expect(stateOf(ledger, "delivery"), "left open for the next sweep").not.toBe("completed");
    expect(alerts.map((a) => a.alertCode)).toContain("recovery_escalation_not_visible");
    expect(chatwoot.privateNotes).toHaveLength(1);

    // The failure clears: the next sweep finishes it with ONE note in total.
    chatwoot.openConversationFailure = null;
    ledger.expireAllLeases();
    await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();
    expect(chatwoot.statusToggles.length).toBeGreaterThanOrEqual(1);
    expect(chatwoot.privateNotes, "exactly ONE escalation note across both sweeps").toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(inProgressActions(ledger)).toEqual([]);

    // A third sweep is a no-op.
    const before = chatwoot.calls.length;
    ledger.expireAllLeases();
    expect(await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep()).toBe(0);
    expect(chatwoot.calls.length).toBe(before);
  });

  it("a HANDOFF-mode delivery is escalated by the same rule; its unsent acknowledgement ends not_sent_escalated and no customer message is sent", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const job = makeJob("handoff");
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "handoff_customer_message", job.digest, job.correlationId, 300_000);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(row(ledger, "handoff_customer_message")).toEqual({ state: "failed", failureCode: DISPOSITION.notSentEscalated });
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("a claimed ANNOTATION (labels) is not re-driven: it ends 'abandoned' and the delivery still completes", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "labels", job.digest, job.correlationId, 300_000);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.labelWrites, "annotations are not resumed").toHaveLength(0);
    expect(row(ledger, "labels")).toEqual({ state: "failed", failureCode: DISPOSITION.abandoned });
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Superseded: a person (or another delivery) already holds the conversation
// ---------------------------------------------------------------------------

describe("superseded escalations are RECORDED, never re-opened", () => {
  it("a PERSON took the conversation (HUMAN_OWNED): no note, no opening, no assignment; the unpublished note ends 'superseded'", async () => {
    const { deps, chatwoot, ledger, ownership, capture } = build({ stallAt: "failure_note" });
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    ownership.seed(refOf(job), "HUMAN_OWNED", 2, `escalate:${EVENT_ID}`);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(chatwoot.assignments).toHaveLength(0);
    expect(row(ledger, "failure_note")).toEqual({ state: "failed", failureCode: DISPOSITION.superseded });
    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(inProgressActions(ledger)).toEqual([]);
  });

  it("ANOTHER delivery's hold (HUMAN_REQUESTED under a different operation id) is not ours: no writes; recorded 'superseded' (cross-delivery hold control)", async () => {
    const { deps, chatwoot, ledger, ownership, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "failure_note", job.digest, job.correlationId, 300_000);
    ownership.seed(refOf(job), "HUMAN_REQUESTED", 1, "escalate:some-OTHER-delivery");
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.privateNotes, "wrote into a conversation held by another delivery's escalation").toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(row(ledger, "failure_note")).toEqual({ state: "failed", failureCode: DISPOSITION.superseded });
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("CONTROL: this delivery's OWN hold (escalate:<event>) is exactly the case that is finished: the writes happen", async () => {
    const { deps, chatwoot, ledger, ownership, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    ownership.seed(refOf(job), "HUMAN_REQUESTED", 1, `escalate:${EVENT_ID}`);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.statusToggles, "our own unfinished escalation must be finished").toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Provably complete: no escalation, no writes, no alert
// ---------------------------------------------------------------------------

describe("a PROVABLY COMPLETE delivery completes with no escalation", () => {
  it("every action settled (the reply completed; only the delivery row was left open): zero Chatwoot writes, no alert", async () => {
    const { deps, chatwoot, ledger, capture } = build({ answer: "reply" });
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    expect(chatwoot.customerMessages).toHaveLength(1);
    // Only the delivery row is left open (the process died before closing it).
    for (const [key, r] of ledger.rows) {
      if (key.includes(EVENT_ID) && key.endsWith("|delivery")) {
        r.state = "in_progress";
        r.leaseExpiresAt = 0;
      }
    }
    const callsBefore = chatwoot.calls.length;

    await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();

    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(chatwoot.calls.length, "no Chatwoot call of any kind").toBe(callsBefore);
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it("positive evidence only: a reply row left in_progress whose reply IS visible is settled and the delivery completes without escalating", async () => {
    const { deps, chatwoot, ledger, capture } = build({ answer: "reply" });
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    for (const [key, r] of ledger.rows) {
      if (key.includes(EVENT_ID) && (key.endsWith("|reply") || key.endsWith("|delivery"))) {
        r.state = "in_progress";
        r.leaseExpiresAt = 0;
      }
    }

    await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();

    expect(chatwoot.customerMessages, "never re-sent").toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "reply")).toBe("completed");
    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(alerts).toHaveLength(0);
  });

  it("CONTROL: the SAME state but the reply is HIDDEN behind a newer private note is NOT provable: it is escalated, and still never re-sent", async () => {
    const { deps, chatwoot, ledger, capture } = build({ answer: "reply" });
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    await processDelivery(deps, job);
    // Something posts a private note after the reply (hiding it from the bot's window).
    await chatwoot.postMessage(
      { accountId: ACCOUNT_ID, conversationId: CONVERSATION_DISPLAY_ID, accessToken: "t" },
      "staff note",
      true,
      "ref-staff-note",
    );
    for (const [key, r] of ledger.rows) {
      if (key.includes(EVENT_ID) && (key.endsWith("|reply") || key.endsWith("|delivery"))) {
        r.state = "in_progress";
        r.leaseExpiresAt = 0;
      }
    }

    await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();

    expect(chatwoot.customerMessages, "an unprovable reply is NEVER re-sent").toHaveLength(1);
    expect(chatwoot.statusToggles, "but a person is asked to look").toHaveLength(1);
    expect(row(ledger, "reply")).toEqual({ state: "failed", failureCode: DISPOSITION.notSentEscalated });
    expect(alerts.map((a) => a.alertCode)).toEqual(["recovery_escalated_to_human"]);
  });
});

// ---------------------------------------------------------------------------
// Abandonment is recorded and alerted, never silent
// ---------------------------------------------------------------------------

describe("abandonment is never silent", () => {
  it("past the attempt cap: the delivery fails with a code, every open action ends 'abandoned', an alert is raised, Chatwoot is not touched", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    for (const [key, r] of ledger.rows) if (key.includes(EVENT_ID) && key.endsWith("|delivery")) r.attempts = 8;
    ledger.expireAllLeases();

    await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();

    expect(stateOf(ledger, "delivery")).toBe("failed");
    expect(row(ledger, "reply")).toEqual({ state: "failed", failureCode: DISPOSITION.abandoned });
    expect(chatwoot.calls).toHaveLength(0);
    expect(alerts.map((a) => a.alertCode)).toEqual(["recovery_abandoned"]);
  });

  it("a binding that no longer exists: abandoned with dispositions and an alert (no token to touch Chatwoot with)", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture, { alertSink: sink, bindings: () => [] }).sweeper.sweep();

    expect(stateOf(ledger, "delivery")).toBe("failed");
    expect(row(ledger, "reply")).toEqual({ state: "failed", failureCode: DISPOSITION.abandoned });
    expect(chatwoot.calls).toHaveLength(0);
    expect(alerts.map((a) => a.alertCode)).toEqual(["recovery_abandoned"]);
  });
});

// ---------------------------------------------------------------------------
// The alert path
// ---------------------------------------------------------------------------

describe("the alert path", () => {
  it("DEFAULT (no sink supplied): a loud ERROR-level log line with the stable event name and alertCode; the private note is the in-product alert", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture).sweeper.sweep();

    const alertLines = capture.lines.filter((l) => l["event"] === "recovery_escalation");
    expect(alertLines).toHaveLength(1);
    expect(alertLines[0]).toMatchObject({ level: "error", alert: true, alertCode: "recovery_escalated_to_human" });
    expect(chatwoot.privateNotes, "the in-product alert").toHaveLength(1);
  });

  it("the alert carries identifiers and dispositions only: no customer message text", async () => {
    const { deps, ledger, capture } = build();
    const { alerts, sink } = collectingSink();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    ledger.expireAllLeases();

    await sweeperFor(deps, capture, { alertSink: sink }).sweeper.sweep();

    expect(JSON.stringify(alerts)).not.toContain("invoice");
    expect(alerts[0]?.dispositions["reply"]).toBe(DISPOSITION.notSentEscalated);
    // And the reply reference exists in the ledger identity space (sanity: the alert names the action, not a ref).
    expect(deliveryRef(job.identity, "reply")).toBeTruthy();
  });
});
