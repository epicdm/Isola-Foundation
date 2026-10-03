/**
 * CODEX DH3 + DH8 (direct Hermes path, review of d810455).
 *
 * DH3 (P2): the CURRENT message was found in the transcript by TEXT. An older identical "hello" stood in
 * for a current one whose transcript INSERT had failed, so a second Hermes run and an answer happened
 * although the current row was missing. The current message is now identified by its CHATWOOT MESSAGE ID,
 * carried through the transcript read, and a missing current row is FAIL CLOSED (no run, one escalation).
 *
 * DH8 (test defect): replacing the production history WHERE scope with one that admits every row left all
 * 222 tests green, because the fake filtered by account/conversation on its own. The fake now EVALUATES the
 * WHERE clause of the production SQL text it is given, and refuses a statement it cannot evaluate, so a
 * widened scope fails these tests.
 *
 * SOCKET-FREE. Every refusal has its positive twin in the same file (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { buildHermesHistory } from "../src/hermes-input.js";
import { readTurnHistory, recordTurn } from "../src/turns.js";
import { answerEnvelope, completeWith, directRig } from "./hermes-rig.js";
import { FakeTurnSql } from "./hermes-inproc.js";

const CAPS = { maxTurns: 20, maxChars: 8000 };
const t = (role: "customer" | "business", content: string) => ({ role, content });

// ---------------------------------------------------------------------------
// A. The pure function: the current message is found by ID, never by text
// ---------------------------------------------------------------------------

describe("DH3 buildHermesHistory: the current message is identified by its message id", () => {
  it("CONTROL: the current id is present -> ok, an earlier IDENTICAL line stays in the history as a prior turn", () => {
    const r = buildHermesHistory([t("customer", "hello"), t("business", "Hi!"), t("customer", "hello")], "hello", CAPS, {
      currentMessageId: 9200,
      historyMessageIds: [9100, 9110, 9200],
    });
    expect(r).toEqual({
      ok: true,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi!" },
      ],
      droppedForCaps: false,
    });
  });

  it("NEGATIVE: an older identical 'hello' does NOT stand in for a current message that is missing from the transcript", () => {
    // message 9200 ("hello") never made it into the store; only the older 9100 "hello" is there
    const r = buildHermesHistory([t("customer", "hello")], "hello", CAPS, { currentMessageId: 9200, historyMessageIds: [9100] });
    expect(r).toEqual({ ok: false, reason: "current_message_not_in_history" });
  });

  it("an id that points at a BUSINESS turn is not the customer's current message", () => {
    const r = buildHermesHistory([t("customer", "hello"), t("business", "hello")], "hello", CAPS, {
      currentMessageId: 9110,
      historyMessageIds: [9100, 9110],
    });
    expect(r).toEqual({ ok: false, reason: "current_message_not_in_history" });
  });

  it("turns recorded AFTER the current message (a newer message that raced in) are still dropped with it", () => {
    const r = buildHermesHistory([t("customer", "a"), t("customer", "b"), t("business", "c")], "b", CAPS, {
      currentMessageId: 20,
      historyMessageIds: [10, 20, 30],
    });
    expect(r).toEqual({ ok: true, messages: [{ role: "user", content: "a" }], droppedForCaps: false });
  });

  it.each([
    ["no current message id (the webhook carried none)", { currentMessageId: null, historyMessageIds: [1] }],
    ["no ids from the transcript read", { currentMessageId: 1, historyMessageIds: undefined }],
    ["ids of a different length than the turns", { currentMessageId: 1, historyMessageIds: [1, 2] }],
    ["a non-integer id", { currentMessageId: 1.5, historyMessageIds: [1.5] }],
    ["a zero id", { currentMessageId: 0, historyMessageIds: [0] }],
  ] as const)("FAIL CLOSED when identity cannot be established: %s", (_name, ids) => {
    const r = buildHermesHistory([t("customer", "hello")], "hello", CAPS, { ...ids, historyMessageIds: ids.historyMessageIds as readonly number[] | undefined });
    expect(r.ok).toBe(false);
  });

  it("CONTROL for the table above: the same turns with a proper identity are ok", () => {
    expect(buildHermesHistory([t("customer", "hello")], "hello", CAPS, { currentMessageId: 1, historyMessageIds: [1] }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. The route: a failed transcript INSERT for the current message
// ---------------------------------------------------------------------------

describe("DH3 the route: a current message whose transcript INSERT failed is never answered from an older identical line", () => {
  it("CONTROL: two identical 'hello' messages, both recorded -> two runs, two replies", async () => {
    const r = directRig();
    completeWith(r.fake, answerEnvelope("FIRST ANSWER"));
    expect((await r.post({ content: "hello" })).status).toBe(200);
    await r.gateway.drain();
    completeWith(r.fake, answerEnvelope("SECOND ANSWER"));
    expect((await r.post({ content: "hello" })).status).toBe(200);
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(2);
    expect(JSON.stringify(r.chatwoot.customerMessages)).toContain("SECOND ANSWER");
  });

  it("NEGATIVE: the second 'hello' arrives while the transcript store is down -> NO second run, NO model text, a human is asked", async () => {
    const r = directRig();
    completeWith(r.fake, answerEnvelope("FIRST ANSWER"));
    await r.post({ content: "hello" });
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(1);

    r.turns.failNextInserts = 1; // the INSERT of the second 'hello' fails
    completeWith(r.fake, answerEnvelope("SECOND ANSWER"));
    const res = await r.post({ content: "hello" });
    expect(res.status).toBe(200);
    await r.gateway.drain();

    expect(r.turns.insertAttempts, "the insert of the current message was tried").toBe(2);
    expect(r.fake.creates, "an older identical line stood in for the missing current one").toHaveLength(1);
    expect(JSON.stringify(r.chatwoot.customerMessages)).not.toContain("SECOND ANSWER");
    // the failure is recorded as the history problem it is, and a human is shown the conversation
    const context = r.capture.lines.filter((l) => l["event"] === "delivery" || l["event"] === "escalate" || l["event"] === "handoff");
    expect(JSON.stringify(context)).toMatch(/hermes_history_unavailable/);
  });
});

// ---------------------------------------------------------------------------
// C. DH8: the fake evaluates the PRODUCTION where clause
// ---------------------------------------------------------------------------

async function seed(store: FakeTurnSql): Promise<void> {
  const base = { tenantId: "tenant-acme", role: "customer" as const, author: "customer" as const };
  await recordTurn(store, { ...base, accountId: 1, conversationId: 42, messageId: 1, content: "mine 1" });
  await recordTurn(store, { ...base, accountId: 1, conversationId: 99, messageId: 2, content: "OTHER CONVERSATION" });
  await recordTurn(store, { ...base, accountId: 2, conversationId: 42, messageId: 3, content: "OTHER ACCOUNT, SAME CONVERSATION ID" });
  await recordTurn(store, { ...base, accountId: 1, conversationId: 42, messageId: 4, content: "mine 2" });
}

describe("DH8 the transcript read is scoped to ONE account + ONE conversation, proven against the production SQL text", () => {
  it("CONTROL: the production read returns this conversation's rows only, with their message ids, oldest first", async () => {
    const store = new FakeTurnSql();
    await seed(store);
    const h = await readTurnHistory(store, 1, 42);
    expect(h.turns.map((x) => x.content)).toEqual(["mine 1", "mine 2"]);
    expect(h.messageIds).toEqual([1, 4]);
    const text = JSON.stringify(h);
    expect(text).not.toContain("OTHER");
  });

  it("INSTRUMENT CONTROL: the fake evaluates the WHERE it is given -> a statement whose scope was widened is REFUSED, not answered with every row", async () => {
    const store = new FakeTurnSql();
    await seed(store);
    const widened = `SELECT role, content, chatwoot_message_id
       FROM conversation_turn
      WHERE chatwoot_account_id = $1 AND 1 = 1
      ORDER BY chatwoot_message_id DESC
      LIMIT $3`;
    await expect(store.query(widened, [1, 42, 21])).rejects.toThrow(/predicate/i);
    const missingConversation = `SELECT role, content, chatwoot_message_id
       FROM conversation_turn
      WHERE chatwoot_account_id = $1
      ORDER BY chatwoot_message_id DESC
      LIMIT $2`;
    await expect(store.query(missingConversation, [1, 21])).rejects.toThrow(/predicate/i);
  });

  it("the exact production statement is evaluated: the account and the conversation predicates both filter (distinct fixtures)", async () => {
    const store = new FakeTurnSql();
    await seed(store);
    expect((await readTurnHistory(store, 2, 42)).turns.map((x) => x.content)).toEqual(["OTHER ACCOUNT, SAME CONVERSATION ID"]);
    expect((await readTurnHistory(store, 1, 99)).turns.map((x) => x.content)).toEqual(["OTHER CONVERSATION"]);
    expect((await readTurnHistory(store, 3, 42)).turns).toEqual([]);
  });
});
