// War room (owner 2026-10-15, dec-owner-build-the-war-room-2026-10-15): supervised 20 s hold with "@hold", and staff trace notes.
// Every "was NOT sent" assertion has a positive twin in this file proving the same harness DOES send when nobody intervenes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay, decide, readEvent, traceLine } from "../src/relay.js";
import { parseSupervisedHoldMs } from "../src/server.js";

const SCOPE = { accountId: 2, inboxId: 11, workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "pl-staging-test-agent" };
const MODEL_TEXT = "Your line is ready. Open Cloud Softphone to make your first call.";
const EVIDENCE = { known: true, currentTurnVerified: true, escalated: false,
  toolCalls: [{ name: "pl-action-adapter__pl_journey", input: {} }, { name: "pl-action-adapter__pl_next_step", input: {} }],
  toolResults: [{ ok: true }, { ok: false, isError: true }] };

function fixture({ holdMs = 0, traceNotes = false } = {}) {
  let t = 1_797_000_000_000;
  const posted = [], statuses = [], logs = [];
  const row = { id: 41, account_id: 2, inbox_id: 11, status: "pending", custom_attributes: {}, meta: { sender: { id: 541 }, assignee: { id: 16 } } };
  let release = null;
  const sleep = () => new Promise((r) => { release = r; });
  const chatwoot = {
    async getConversation() { return structuredClone(row); },
    async getContact() { return {}; },
    async updateConversationCustomAttributes(id, v) { Object.assign(row.custom_attributes, v); return { custom_attributes: structuredClone(row.custom_attributes) }; },
    async postMessage(id, content, opts) { posted.push({ content, private: opts.private === true }); },
    async toggleStatus(id, s) { statuses.push(s); row.status = s; }, async assignOwner() {}, async assignTeam() {},
  };
  const seldon = {
    async turn() { return { ok: true, text: MODEL_TEXT, conversationId: "sf-conv", conversationCapability: "cap" }; },
    async escalation() { return { known: true, escalated: false }; },
    async inspectTurn() { return structuredClone(EVIDENCE); },
  };
  const relay = createRelay({ scope: SCOPE, ownerUserId: 16, chatwoot, seldon, requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32",
    now: () => (t += 1000), logger: (o) => logs.push(o), supervisedHoldMs: holdMs, traceNotes, sleep });
  const customer = (id = 7001, content = "Hi") => ({ event: "message_created", id, content, message_type: "incoming", private: false, sender: { type: "contact", id: 541 },
    account: { id: 2 }, inbox: { id: 11 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } } });
  const staffNote = (id, content) => ({ event: "message_created", id, content, message_type: "outgoing", private: true, sender: { type: "user", id: 16 },
    account: { id: 2 }, inbox: { id: 11 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } } });
  const until = async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setImmediate(r)); assert.ok(pred(), "condition never became true"); };
  return { relay, posted, statuses, logs, row, customer, staffNote, until, release: () => release && release(), get waiting() { return release !== null; } };
}
const publicTexts = (f) => f.posted.filter((m) => !m.private).map((m) => m.content);
const drafts = (f) => f.posted.filter((m) => m.private && m.content.startsWith("DRAFT"));

test("CONTROL: hold OFF (the default) sends the model reply at once, with no draft - unchanged behaviour", async () => {
  const f = fixture();
  await f.relay.accept(f.customer()).done;
  assert.deepEqual(publicTexts(f), [MODEL_TEXT]);
  assert.equal(drafts(f).length, 0);
});

test("hold ON: staff first see a PRIVATE draft with the agent trace; the reply is NOT public until the hold ends", async () => {
  const f = fixture({ holdMs: 20000 });
  const run = f.relay.accept(f.customer()).done;
  await f.until(() => f.waiting);
  assert.equal(drafts(f).length, 1);
  assert.match(drafts(f)[0].content, /sends in 20 s unless you type @hold or reply yourself/);
  assert.ok(drafts(f)[0].content.includes(MODEL_TEXT));
  assert.match(drafts(f)[0].content, /Agent trace: pl_journey, pl_next_step \(failed\)/);
  assert.deepEqual(publicTexts(f), [], "nothing reaches the customer during the hold");
  f.release(); await run;
  assert.deepEqual(publicTexts(f), [MODEL_TEXT], "POSITIVE TWIN: with no intervention the draft is sent once");
});

test("@hold during the wait: the draft is NOT sent, the conversation goes to staff, and the customer is told nothing", async () => {
  const f = fixture({ holdMs: 20000 });
  const run = f.relay.accept(f.customer()).done;
  await f.until(() => f.waiting);
  const r = f.relay.accept(f.staffNote(8001, "@hold this price is wrong"));
  assert.equal(r.reason, "staff_hold");
  f.release(); await run;
  assert.deepEqual(publicTexts(f), [], "no customer-visible message at all");
  assert.ok(f.posted.some((m) => m.private && /Relay handoff: staff held the supervised draft/.test(m.content)));
  assert.ok(f.statuses.includes("open"), "staff now own the conversation");
  assert.ok(f.logs.some((l) => l.event === "reply_held_by_staff"));
});

test("a staff reply during the wait (conversation turns Open) discards the draft - the staff reply is the edit", async () => {
  const f = fixture({ holdMs: 20000 });
  const run = f.relay.accept(f.customer()).done;
  await f.until(() => f.waiting);
  f.row.status = "open";
  f.release(); await run;
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_discarded" && l.outcome === "takeover_during_supervised_hold"));
});

test("an OLD @hold (before this draft) does not block it; a customer typing @hold is not a hold", async () => {
  const f = fixture({ holdMs: 20000 });
  f.relay.accept(f.staffNote(8002, "@hold"));                      // before any draft exists
  const run = f.relay.accept(f.customer(7002, "@hold please")).done; // customer text, never a staff command
  await f.until(() => f.waiting);
  f.release(); await run;
  assert.deepEqual(publicTexts(f), [MODEL_TEXT]);
});

test("decide(): only a PRIVATE note from a staff USER starting with @hold is a hold", () => {
  const base = { event: "message_created", account: { id: 2 }, inbox: { id: 11 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } }, id: 1 };
  const d = (over) => decide(readEvent({ ...base, ...over }), SCOPE).act;
  assert.equal(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "user", id: 16 } }), "staff_hold");
  assert.equal(d({ content: "@HOLD now", message_type: 1, private: true, sender: { type: "user", id: 16 } }), "staff_hold");
  assert.notEqual(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "agent_bot", id: 20 } }), "staff_hold");
  assert.notEqual(d({ content: "@hold", message_type: "outgoing", private: false, sender: { type: "user", id: 16 } }), "staff_hold");
  assert.notEqual(d({ content: "please @hold", message_type: "outgoing", private: true, sender: { type: "user", id: 16 } }), "staff_hold");
  assert.notEqual(d({ content: "@hold", message_type: "incoming", private: false, sender: { id: 541 } }), "staff_hold");
});

test("trace notes (hold OFF): one private trace after the reply; OFF by default", async () => {
  const on = fixture({ traceNotes: true });
  await on.relay.accept(on.customer()).done;
  assert.deepEqual(publicTexts(on), [MODEL_TEXT]);
  assert.ok(on.posted.some((m) => m.private && /^Agent trace: pl_journey, pl_next_step \(failed\) · reply \d+ chars · 0 button\(s\)$/.test(m.content)));
  const off = fixture();
  await off.relay.accept(off.customer()).done;
  assert.equal(off.posted.filter((m) => m.private).length, 0, "CONTROL: no private notes when trace notes are off");
});

test("traceLine never includes tool inputs or outputs", () => {
  const line = traceLine({ toolCalls: [{ name: "pl-action-adapter__pl_balance", input: { secret: "x" } }], toolResults: [{ ok: true, content: "EC$10.00" }] }, null, "hi");
  assert.equal(line, "Agent trace: pl_balance · reply 2 chars · 0 button(s)");
  assert.equal(traceLine(null, null, ""), "Agent trace: no tools · reply 0 chars · 0 button(s)");
});

test("RELAY_SUPERVISED_HOLD_MS parsing is never boot-fatal; bad values mean OFF and are logged", () => {
  const logs = []; const lg = (o) => logs.push(o);
  assert.equal(parseSupervisedHoldMs(undefined, lg), 0);
  assert.equal(parseSupervisedHoldMs("", lg), 0);
  assert.equal(parseSupervisedHoldMs("20000", lg), 20000);
  assert.equal(parseSupervisedHoldMs(" 0 ", lg), 0);
  assert.equal(logs.length, 0, "valid values log nothing");
  assert.equal(parseSupervisedHoldMs("20s", lg), 0);
  assert.equal(parseSupervisedHoldMs("999999", lg), 0);
  assert.equal(parseSupervisedHoldMs("-5", lg), 0);
  assert.equal(logs.filter((l) => l.event === "config_ignored").length, 3);
});
