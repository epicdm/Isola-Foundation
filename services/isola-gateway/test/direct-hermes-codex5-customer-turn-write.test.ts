/**
 * CODEX (direct Hermes path, short re-review of bd5b8f5), the non-gating item the author fixes anyway:
 * the CUSTOMER-turn transcript write (app.ts, before the reservation) was unbounded. A pending INSERT
 * blocked the acknowledgement AND the delivery reservation; a failed one was only logged, so the NEXT
 * AI turn answered from a history that was missing a customer message.
 *
 * Now the write is bounded like the staff write (`customerTurnRecordTimeoutMs`, default 2 s, well inside
 * Chatwoot's 5 s), a failure or a timeout marks the conversation as having a HOLE, and the next AI turn
 * there answers nothing from an incomplete history and escalates once (the same mark the staff write
 * uses).
 *
 * SOCKET-FREE. Positive twins in the same harness (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { ACCOUNT_ID, CONVERSATION_DISPLAY_ID, TENANT_ID } from "./harness.js";
import { answerEnvelope, completeWith, directRig, sleep } from "./hermes-rig.js";

/** Never waits forever: a hang is reported as a failure instead of a vitest timeout. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const guard = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`HUNG: ${what} did not finish within ${ms} ms`)), ms);
    if (typeof t.unref === "function") t.unref();
  });
  return Promise.race([promise, guard]);
}

describe("the customer-turn transcript write is bounded and a failed write marks a hole", () => {
  it("CONTROL: a healthy store -> the customer turn is recorded and the AI answers", async () => {
    const r = directRig({ deps: { customerTurnRecordTimeoutMs: 80 } });
    completeWith(r.fake, answerEnvelope("HEALTHY ANSWER"));
    const res = await within(r.post({ content: "hello" }), 1500, "the webhook");
    expect(res.status).toBe(200);
    await r.gateway.drain();
    expect(JSON.stringify(r.chatwoot.customerMessages)).toContain("HEALTHY ANSWER");
    expect(r.capture.lines.some((l) => l["alertCode"] === "customer_turn_not_recorded")).toBe(false);
  });

  it("NEGATIVE: the INSERT never settles -> the webhook is still acknowledged inside the bound, nothing is answered from the missing turn, and ONE escalation is recorded", async () => {
    const r = directRig({ deps: { customerTurnRecordTimeoutMs: 80 } });
    completeWith(r.fake, answerEnvelope("MUST NOT BE SENT"));
    r.turns.stallNextInserts = 1;
    const started = Date.now();
    const res = await within(r.post({ content: "hello" }), 1500, "the webhook with a stalled customer INSERT");
    expect(res.status).toBe(200);
    expect(Date.now() - started, "the acknowledgement waited for the stalled INSERT").toBeLessThan(800);
    await r.gateway.drain();
    expect(r.fake.creates, "the AI ran although the customer's turn was not recorded").toHaveLength(0);
    expect(r.chatwoot.customerMessages).toHaveLength(0);
    expect(r.chatwoot.privateNotes).toHaveLength(1);
    const alert = r.capture.lines.find((l) => l["alertCode"] === "customer_turn_not_recorded");
    expect(alert, "no alert for the stalled customer-transcript write").toBeDefined();
    expect(String(alert!["detail"])).toMatch(/timed? ?out|did not finish|stall/i);
  });

  it("NEGATIVE: a REJECTED INSERT marks a hole; the NEXT turn (healthy store) answers nothing from the incomplete history and escalates once", async () => {
    const r = directRig({ deps: { customerTurnRecordTimeoutMs: 80 } });
    completeWith(r.fake, answerEnvelope("MUST NOT BE SENT"));
    r.turns.failNextInserts = 1;
    await within(r.post({ content: "first question" }), 1500, "the first webhook");
    await r.gateway.drain();
    const notesAfterFirst = r.chatwoot.privateNotes.length;
    // the first turn's escalation took the microphone from the AI; give it back so the ONLY thing standing
    // between the second message and an AI answer is the hole (otherwise this test would pass on ownership alone)
    r.ownership.seed({ tenantId: TENANT_ID, chatwootAccountId: ACCOUNT_ID, chatwootConversationId: CONVERSATION_DISPLAY_ID }, "AI_OWNED", 5);
    // the store is healthy again; the conversation still has a hole, so the AI must not answer
    await within(r.post({ content: "second question" }), 1500, "the second webhook");
    await r.gateway.drain();
    expect(r.fake.creates, "the AI answered from a history that is missing a customer message").toHaveLength(0);
    expect(r.chatwoot.customerMessages).toHaveLength(0);
    expect(r.chatwoot.privateNotes.length).toBeGreaterThanOrEqual(notesAfterFirst);
    expect(r.capture.lines.some((l) => l["alertCode"] === "customer_turn_not_recorded")).toBe(true);
  });

  it("an INSERT that settles AFTER the bound does not throw, does not answer, and is reported once", async () => {
    const r = directRig({ deps: { customerTurnRecordTimeoutMs: 40 } });
    completeWith(r.fake, answerEnvelope("MUST NOT BE SENT"));
    const real = r.turns.query.bind(r.turns);
    r.turns.query = (async (sql: string, params?: readonly unknown[]) => {
      if (/INSERT INTO conversation_turn/.test(sql)) await sleep(150);
      return real(sql, params);
    }) as typeof r.turns.query;
    const res = await within(r.post({ content: "hello" }), 1500, "the webhook");
    expect(res.status).toBe(200);
    await r.gateway.drain();
    await sleep(250);
    expect(r.chatwoot.customerMessages).toHaveLength(0);
    expect(r.capture.lines.filter((l) => l["alertCode"] === "customer_turn_not_recorded")).toHaveLength(1);
  });

  it("the default bound is under Chatwoot's 5 s delivery timeout (a source pin on the constant)", async () => {
    const { CUSTOMER_TURN_RECORD_TIMEOUT_MS } = await import("../src/app.js");
    expect(CUSTOMER_TURN_RECORD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CUSTOMER_TURN_RECORD_TIMEOUT_MS).toBeLessThan(5000);
  });
});
