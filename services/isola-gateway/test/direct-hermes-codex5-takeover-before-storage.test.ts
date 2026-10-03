/**
 * CODEX DH9 (direct Hermes path, short re-review of bd5b8f5) - P2, BLOCKING.
 *
 * The staff-transcript INSERT was BOUNDED, but `recordHumanReply()` (the takeover) still started only
 * AFTER that bound. Codex's independent probe: start an AI turn, deliver a signed staff reply, stall its
 * transcript INSERT, complete Hermes DURING the storage wait -> ONE customer-facing AI reply, because
 * ownership had not changed yet. (With healthy storage the same answer was suppressed.)
 *
 * The takeover must start BEFORE the transcript write is awaited. The bounded write and the hole marker
 * stay. These tests STALL the INSERT and prove that no AI reply is produced DURING the wait.
 *
 * SOCKET-FREE. A spy `ownershipExec` seeds the in-memory ownership gate the pipeline reads, so the
 * takeover has the same visible effect the real SQL transition has. Positive twins in the same file
 * (Laws 11, 19, 23, 28).
 */
import { describe, expect, it, vi } from "vitest";

import { answerEnvelope, directRig, sleep } from "./hermes-rig.js";
import { ACCOUNT_ID, CONVERSATION_DISPLAY_ID, InMemoryOwnershipGate, TENANT_ID } from "./harness.js";
import type { ConversationRef } from "../src/ownership.js";

const REF: ConversationRef = { tenantId: TENANT_ID, chatwootAccountId: ACCOUNT_ID, chatwootConversationId: CONVERSATION_DISPLAY_ID };
const conversation = { id: CONVERSATION_DISPLAY_ID, status: "pending", meta: { assignee: null }, custom_attributes: {} };
const staffReply = (id: number) => ({
  id,
  content: "Hi, this is Ann from EPIC.",
  message_type: "outgoing",
  sender: { type: "user", id: 7, name: "Ann" },
  conversation,
});

/** An ownership executor whose transition has the effect the real one has: the conversation becomes HUMAN_OWNED. */
function takeoverExec(ownership: InMemoryOwnershipGate) {
  const calls: number[] = [];
  const exec = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    transaction: vi.fn(async () => {
      calls.push(Date.now());
      ownership.seed(REF, "HUMAN_OWNED", 2);
      return { status: "applied", state: "HUMAN_OWNED", episode: 2 };
    }),
  };
  return { exec: exec as never, calls };
}

describe("DH9 (round 5): the takeover starts BEFORE the transcript write is awaited", () => {
  it("NEGATIVE (Codex's probe): the staff INSERT is stalled, Hermes completes DURING the wait -> NO customer-facing AI reply", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { exec, calls } = takeoverExec(ownership);
    // a bound far longer than the whole scenario, so everything below happens INSIDE the storage wait
    const r = directRig({ ownership, deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 1200 } });
    r.fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(answerEnvelope("AI ANSWER THAT MUST NOT BE SENT")), 250);
    };
    await r.post({ content: "Do you sell calling plans?", conversation });
    await sleep(40);
    expect(r.fake.creates, "the AI turn is under way").toHaveLength(1);

    r.turns.stallNextInserts = 1;
    const staffPost = r.post(staffReply(9900), "00000000-0000-4000-8000-000000009900");
    // inside the storage wait: the takeover has ALREADY started and the run finishes under HUMAN ownership
    await sleep(120);
    expect(r.turns.insertAttempts, "the staff INSERT is the stalled one").toBeGreaterThanOrEqual(1);
    expect(calls, "the takeover did not start while the transcript write was pending").toHaveLength(1);
    await sleep(400); // Hermes completed at ~250 ms, still inside the 1200 ms bound
    expect(JSON.stringify(r.chatwoot.customerMessages), "an AI reply reached the customer during the storage wait").not.toContain("MUST NOT BE SENT");
    expect(r.chatwoot.customerMessages).toHaveLength(0);

    await staffPost;
    await r.gateway.drain();
    expect(r.chatwoot.customerMessages).toHaveLength(0);
    expect(r.capture.lines.some((l) => l["outcome"] === "suppressed_in_flight")).toBe(true);
  });

  it("the stalled write is still bounded: the webhook is acknowledged inside the bound, a hole is marked and the alert is logged", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { exec, calls } = takeoverExec(ownership);
    const r = directRig({ ownership, deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 150 } });
    r.turns.stallNextInserts = 1;
    const started = Date.now();
    const res = await r.post(staffReply(9901), "00000000-0000-4000-8000-000000009901");
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(900);
    await sleep(30);
    expect(calls).toHaveLength(1);
    expect(r.capture.lines.some((l) => l["alertCode"] === "human_reply_turn_not_recorded")).toBe(true);
  });

  it("a REJECTED write: the takeover has started anyway and the hole is marked (unchanged contract)", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { exec, calls } = takeoverExec(ownership);
    const r = directRig({ ownership, deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 150 } });
    r.turns.failNextInserts = 1;
    const res = await r.post(staffReply(9902), "00000000-0000-4000-8000-000000009902");
    expect(res.status).toBe(200);
    await sleep(30);
    expect(calls).toHaveLength(1);
    expect(r.capture.lines.some((l) => l["alertCode"] === "human_reply_turn_not_recorded")).toBe(true);
  });

  it("POSITIVE CONTROL: a conversation with NO staff reply -> the same AI turn is answered normally", async () => {
    const r = directRig({ deps: { staffTurnRecordTimeoutMs: 1200 } });
    r.fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(answerEnvelope("NORMAL ANSWER")), 120);
    };
    await r.post({ content: "Do you sell calling plans?", conversation });
    await r.gateway.drain();
    expect(JSON.stringify(r.chatwoot.customerMessages)).toContain("NORMAL ANSWER");
  });

  it("HEALTHY storage: the takeover still suppresses the in-flight answer (the case that already worked)", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { exec } = takeoverExec(ownership);
    const r = directRig({ ownership, deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 1200 } });
    r.fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(answerEnvelope("AI ANSWER THAT MUST NOT BE SENT")), 250);
    };
    await r.post({ content: "Do you sell calling plans?", conversation });
    await sleep(40);
    await r.post(staffReply(9903), "00000000-0000-4000-8000-000000009903");
    await r.gateway.drain();
    expect(r.chatwoot.customerMessages).toHaveLength(0);
  });

  it("a signed human reply with NO ownership executor configured keeps its loud alert (the wiring check moved with the takeover)", async () => {
    const r = directRig();
    const res = await r.post(staffReply(9904), "00000000-0000-4000-8000-000000009904");
    expect(res.status).toBe(200);
    expect(res.json["outcome"]).toBe("human_reply");
    expect(r.capture.lines.some((l) => l["alertCode"] === "ownership_exec_not_configured")).toBe(true);
  });
});
