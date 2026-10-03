/**
 * CODEX DH9 (direct Hermes path, review of d810455) - P2.
 *
 * The staff-transcript INSERT was awaited BEFORE the acknowledgement and BEFORE `recordHumanReply()` began.
 * If that INSERT waits on a lock, the signed staff reply has arrived but ownership stays unchanged, so an
 * AI turn already running keeps seeing AI ownership and can answer over the person who just took the
 * conversation. A rejected INSERT reached the catch and marked a hole; a PENDING one reached neither.
 *
 * Now the INSERT is BOUNDED (`staffTurnRecordTimeoutMs`, default 2 s, well inside Chatwoot's 5 s). On
 * timeout the takeover proceeds, the conversation is marked as having a HOLE (the next AI turn there
 * answers nothing from an incomplete history and escalates once) and an alert is logged. The INSERT that
 * eventually settles changes nothing it should not.
 *
 * SOCKET-FREE; real handler, real ownership wiring through a spy `ownershipExec`. Positive twins in the
 * same file (Laws 11, 19, 23, 28).
 */
import { describe, expect, it, vi } from "vitest";

import { answerEnvelope, completeWith, directRig, sleep } from "./hermes-rig.js";
import { CONVERSATION_DISPLAY_ID, CapturingLogger } from "./harness.js";

const BEARER_SAFE_GUARD_MS = 1500;

function fakeExec() {
  const calls: number[] = [];
  const exec = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    transaction: vi.fn(async () => {
      calls.push(Date.now());
      return { status: "applied", state: "HUMAN_OWNED", episode: 2 };
    }),
  };
  return { exec: exec as never, calls };
}

const conversation = { id: CONVERSATION_DISPLAY_ID, status: "pending", meta: { assignee: null }, custom_attributes: {} };
const staffReply = (id: number, content = "Hi, this is Ann from EPIC.") => ({
  id,
  content,
  message_type: "outgoing",
  sender: { type: "user", id: 7, name: "Ann" },
  conversation,
});

/** Never waits forever: a hang is reported as a failure instead of a vitest timeout. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const guard = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`HUNG: ${what} did not finish within ${ms} ms`)), ms);
    if (typeof t.unref === "function") t.unref();
  });
  return Promise.race([promise, guard]);
}

describe("DH9 the staff-transcript write is bounded and does not delay the takeover", () => {
  it("CONTROL: a healthy store -> the staff turn is recorded, the takeover is started, no hole, no alert", async () => {
    const { exec, calls } = fakeExec();
    const r = directRig({ deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 80 } });
    const res = await within(r.post(staffReply(9150)), BEARER_SAFE_GUARD_MS, "the staff webhook");
    expect(res.status).toBe(200);
    expect(res.json["outcome"]).toBe("human_reply");
    await sleep(30);
    expect(r.turns.rows.map((row) => String(row["content"]))).toEqual(["[A teammate replied]: Hi, this is Ann from EPIC."]);
    expect(calls).toHaveLength(1);
    expect(r.capture.lines.some((l) => l["alertCode"] === "human_reply_turn_not_recorded")).toBe(false);
  });

  it("NEGATIVE (Codex's trace): the INSERT never settles -> the webhook is still acknowledged inside the bound AND the takeover is started", async () => {
    const { exec, calls } = fakeExec();
    const r = directRig({ deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 80 } });
    r.turns.stallNextInserts = 1;
    const started = Date.now();
    const res = await within(r.post(staffReply(9150)), BEARER_SAFE_GUARD_MS, "the staff webhook with a stalled transcript INSERT");
    expect(res.status).toBe(200);
    expect(res.json["outcome"]).toBe("human_reply");
    expect(Date.now() - started, "the acknowledgement waited for the stalled INSERT").toBeLessThan(700);
    await sleep(60);
    expect(calls, "the takeover (recordHumanReply) never started although the staff reply had arrived").toHaveLength(1);
    expect(r.turns.insertAttempts, "the INSERT was tried").toBe(1);
  });

  it("the stalled write is reported and marks the conversation as having a hole (alert + the next AI turn answers nothing)", async () => {
    const { exec } = fakeExec();
    const r = directRig({ deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 80 } });
    // a first customer turn so the conversation exists, answered normally
    completeWith(r.fake, answerEnvelope("FIRST ANSWER"));
    await r.post({ content: "Do you sell calling plans?", conversation });
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(1);

    r.turns.stallNextInserts = 1;
    await within(r.post(staffReply(9250)), BEARER_SAFE_GUARD_MS, "the staff webhook");
    await sleep(120);
    const alert = r.capture.lines.find((l) => l["alertCode"] === "human_reply_turn_not_recorded");
    expect(alert, "no alert for the stalled staff-transcript write").toBeDefined();
    expect(String(alert!["detail"])).toMatch(/timed? ?out|did not finish|stall/i);

    // the person hands the conversation back (here: the gate simply allows the AI again); the next AI turn must not answer
    completeWith(r.fake, answerEnvelope("SECOND ANSWER"));
    await r.post({ content: "And on WhatsApp?", conversation });
    await r.gateway.drain();
    expect(r.fake.creates, "the AI answered from a history that is missing what the person said").toHaveLength(1);
    expect(JSON.stringify(r.chatwoot.customerMessages)).not.toContain("SECOND ANSWER");
    expect(r.capture.lines.some((l) => l["outcome"] === "history_gap_unrecorded_staff_turn")).toBe(true);
  });

  it("a REJECTED write still takes the existing path (alert + hole), unchanged by the bound", async () => {
    const { exec, calls } = fakeExec();
    const r = directRig({ deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 80 } });
    r.turns.failNextInserts = 1;
    const res = await within(r.post(staffReply(9150)), BEARER_SAFE_GUARD_MS, "the staff webhook");
    expect(res.status).toBe(200);
    await sleep(30);
    expect(calls).toHaveLength(1);
    expect(r.capture.lines.some((l) => l["alertCode"] === "human_reply_turn_not_recorded")).toBe(true);
  });

  it("an INSERT that settles AFTER the bound does not throw, change ownership handling or log a second alert", async () => {
    const { exec, calls } = fakeExec();
    const r = directRig({ deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 40 } });
    // a write that is merely SLOW (settles at 150 ms, after the 40 ms bound)
    const slow = r.turns.query.bind(r.turns);
    r.turns.query = (async (sql: string, params?: readonly unknown[]) => {
      if (/INSERT INTO conversation_turn/.test(sql)) await sleep(150);
      return slow(sql, params);
    }) as typeof r.turns.query;
    const res = await within(r.post(staffReply(9150)), BEARER_SAFE_GUARD_MS, "the staff webhook");
    expect(res.status).toBe(200);
    await sleep(250);
    expect(calls).toHaveLength(1);
    expect(r.capture.lines.filter((l) => l["alertCode"] === "human_reply_turn_not_recorded")).toHaveLength(1);
  });

  it("an INSERT that REJECTS after the bound is swallowed (no unhandled rejection) and is not reported a second time", async () => {
    const { exec, calls } = fakeExec();
    const r = directRig({ deps: { ownershipExec: exec, staffTurnRecordTimeoutMs: 40 } });
    const real = r.turns.query.bind(r.turns);
    r.turns.query = (async (sql: string, params?: readonly unknown[]) => {
      if (/INSERT INTO conversation_turn/.test(sql)) {
        await sleep(120);
        throw new Error("simulated: the abandoned write failed later");
      }
      return real(sql, params);
    }) as typeof r.turns.query;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await within(r.post(staffReply(9150)), BEARER_SAFE_GUARD_MS, "the staff webhook");
      expect(res.status).toBe(200);
      await sleep(300);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled, "the abandoned write's late rejection was not handled").toEqual([]);
    expect(calls).toHaveLength(1);
    expect(r.capture.lines.filter((l) => l["alertCode"] === "human_reply_turn_not_recorded")).toHaveLength(1);
  });
  it("the default bound is under Chatwoot's 5 s delivery timeout (a source pin on the constant)", async () => {
    const { STAFF_TURN_RECORD_TIMEOUT_MS } = await import("../src/app.js");
    expect(STAFF_TURN_RECORD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STAFF_TURN_RECORD_TIMEOUT_MS).toBeLessThan(5000);
  });
});

void CapturingLogger;
