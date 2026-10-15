// War room (owner 2026-10-15, dec-owner-build-the-war-room-2026-10-15): supervised 20 s hold with "@hold", and staff trace notes.
// Every "was NOT sent" assertion has a positive twin in this file proving the same harness DOES send when nobody intervenes.
// Revised after Codex review (DO NOT SHIP, 4 findings): staff-reply race at hold end, draft-post failure, staff identity, test gaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay, decide, readEvent, traceLine } from "../src/relay.js";
import { parseSupervisedHoldMs, resolveSelfUserId } from "../src/server.js";
const RELAY_USER = 20;

const SCOPE = { accountId: 2, inboxId: 11, workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "pl-staging-test-agent" };
const MODEL_TEXT = "Your line is ready. Open Cloud Softphone to make your first call.";
const EVIDENCE = { known: true, currentTurnVerified: true, escalated: false,
  toolCalls: [{ name: "pl-action-adapter__pl_journey", input: {} }, { name: "pl-action-adapter__pl_next_step", input: {} }],
  toolResults: [{ ok: true }, { ok: false, isError: true }] };

function fixture({ holdMs = 0, traceNotes = false, failDraft = false, failThread = false, failOwnershipAfter = false, truncateTo = 0, beforePublicPost = null, dropCustomerFromFirstRead = false, stalePageWithoutDraft = false, dropSentFromSecondRead = false, frozenClock = false, duringDraftPost = null, duringModelTurn = null, selfUserId = RELAY_USER } = {}) {
  let reads = 0;
  let t = 1_797_000_000_000;
  const posted = [], statuses = [], logs = [], thread = [];
  let nextId = 9000;
  const row = { id: 41, account_id: 2, inbox_id: 11, status: "pending", custom_attributes: {}, meta: { sender: { id: 541 }, assignee: { id: 16 } } };
  let release = null;
  const sleep = () => new Promise((r) => { release = r; });
  const chatwoot = {
    async getConversation() { if (failOwnershipAfter && release !== null) throw new Error("chatwoot read timeout"); return structuredClone(row); },
    async getContact() { return {}; },
    async listMessages() {
      if (failThread) throw new Error("chatwoot 500");
      reads += 1;
      let page = structuredClone(truncateTo > 0 ? thread.slice(-truncateTo) : thread);
      if (dropCustomerFromFirstRead && reads === 1) page = page.filter((m) => m.message_type !== 0);
      if (stalePageWithoutDraft && reads === 1) page = page.filter((m) => !(m.private && String(m.content).startsWith("DRAFT")) && m.sender_type !== "User");
      if (dropSentFromSecondRead && reads === 2) page = page.filter((m) => m.private || m.content !== MODEL_TEXT);
      return { payload: page };
    },
    async updateConversationCustomAttributes(id, v) { Object.assign(row.custom_attributes, v); return { custom_attributes: structuredClone(row.custom_attributes) }; },
    async postMessage(id, content, opts) {
      if (failDraft && opts.private === true && content.startsWith("DRAFT")) throw new Error("chatwoot 500");
      if (beforePublicPost && opts.private !== true) { const hook = beforePublicPost; beforePublicPost = null; hook(api); }
      if (duringDraftPost && opts.private === true && content.startsWith("DRAFT")) { const hook = duringDraftPost; duringDraftPost = null; hook(api); }
      // PRODUCTION SHAPE (measured 2026-10-15): the relay posts as a Chatwoot USER, id 20 "PL Relay Bot" - not as an AgentBot.
      const m = { id: ++nextId, content, private: opts.private === true, message_type: 1, sender_type: "User", sender_id: RELAY_USER, created_at: Math.floor(t / 1000) };
      posted.push({ content, private: opts.private === true }); thread.push(m); return m;
    },
    async toggleStatus(id, s) { statuses.push(s); row.status = s; }, async assignOwner() {}, async assignTeam() {},
  };
  const seldon = {
    turns: 0,
    async turn() { seldon.turns += 1; if (duringModelTurn) { const h = duringModelTurn; duringModelTurn = null; h(api); } return { ok: true, text: MODEL_TEXT, conversationId: "sf-conv", conversationCapability: "cap" }; },
    async escalation() { return { known: true, escalated: false }; },
    async inspectTurn() { return structuredClone(EVIDENCE); },
  };
  const relay = createRelay({ scope: SCOPE, ownerUserId: 16, chatwoot, seldon, requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32",
    now: () => (frozenClock ? t : (t += 1000)), logger: (o) => logs.push(o), supervisedHoldMs: holdMs, selfUserId, traceNotes, sleep });
  const conv = { id: 41, status: "pending", meta: { sender: { id: 541 } } };
  const customer = (id = 7001, content = "Hi") => {   // the incoming message is also in Chatwoot's thread, as in production
    if (!thread.some((m) => m.id === id)) thread.push({ id, content, private: false, message_type: 0, sender_type: "Contact", created_at: Math.floor(t / 1000) });
    return { event: "message_created", id, content, message_type: "incoming", private: false, sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: 11 }, conversation: conv };
  };
  const staffMsg = (id, content, priv = true) => ({ event: "message_created", id, content, message_type: "outgoing", private: priv, sender: { type: "user", id: 16 }, account: { id: 2 }, inbox: { id: 11 }, conversation: conv });
  // a staff message stored in Chatwoot's thread (what listMessages returns) WITHOUT its webhook having reached the relay
  const storeStaff = (content, priv) => thread.push({ id: ++nextId, content, private: priv, message_type: 1, sender_type: "User", sender_id: 16, created_at: Math.floor(t / 1000) });
  // the relay/adapter's OWN post stored in the thread (same Chatwoot user as the relay) - must never count as staff
  const storeSelf = (content) => thread.push({ id: ++nextId, content, private: false, message_type: 1, sender_type: "User", sender_id: RELAY_USER, created_at: Math.floor(t / 1000) });
  const selfMsg = (id, content) => ({ event: "message_created", id, content, message_type: "outgoing", private: false, sender: { type: "user", id: RELAY_USER }, account: { id: 2 }, inbox: { id: 11 }, conversation: conv });
  const until = async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setImmediate(r)); assert.ok(pred(), "condition never became true"); };
  const api = { relay, posted, statuses, logs, row, seldon, customer, staffMsg, storeStaff, storeSelf, selfMsg, until, release: () => release && release(), get waiting() { return release !== null; } };
  return api;
}
const publicTexts = (f) => f.posted.filter((m) => !m.private).map((m) => m.content);
const drafts = (f) => f.posted.filter((m) => m.private && m.content.startsWith("DRAFT"));
async function heldRun(f, during) {
  const run = f.relay.accept(f.customer()).done;
  await f.until(() => f.waiting);
  if (during) await during();
  f.release(); await run;
}

test("CONTROL: hold OFF (the default) - every observable call is the pre-war-room set: one public reply, no notes, no status change, staff messages ignored as before", async () => {
  const f = fixture();
  const s1 = f.relay.accept(f.staffMsg(8100, "@hold"));
  const s2 = f.relay.accept(f.staffMsg(8101, "hello from staff", false));
  assert.deepEqual([s1.outcome, s1.reason, s2.outcome, s2.reason], ["ignored", "not_incoming", "ignored", "not_incoming"]);
  await f.relay.accept(f.customer()).done;
  assert.deepEqual(f.posted, [{ content: MODEL_TEXT, private: false }]);
  assert.deepEqual(f.statuses, []);
  assert.ok(!f.logs.some((l) => /staff_hold|draft|held|thread_unreadable/.test(l.event)), "no war-room events at all");
  assert.ok(!f.logs.some((l) => "staffReplySeen" in l), "staff messages are logged exactly as before");
  assert.equal(f.logs.filter((l) => l.event === "ignored" && l.reason === "not_incoming").length, 2);
});

test("hold ON: staff first see a PRIVATE draft with the agent trace; the reply is NOT public until the hold ends", async () => {
  const f = fixture({ holdMs: 20000 });
  await heldRun(f, async () => {
    assert.equal(drafts(f).length, 1);
    assert.match(drafts(f)[0].content, /sends in 20 s unless you type @hold or reply yourself/);
    assert.ok(drafts(f)[0].content.includes(MODEL_TEXT));
    assert.match(drafts(f)[0].content, /Agent trace: pl_journey, pl_next_step \(failed\)/);
    assert.deepEqual(publicTexts(f), [], "nothing reaches the customer during the hold");
  });
  assert.deepEqual(publicTexts(f), [MODEL_TEXT], "POSITIVE TWIN: with no intervention the draft is sent once");
});

test("@hold on the webhook during the wait: NOT sent, the conversation goes to staff, the customer is told nothing", async () => {
  const f = fixture({ holdMs: 20000 });
  await heldRun(f, async () => { assert.equal(f.relay.accept(f.staffMsg(8001, "@hold this price is wrong")).reason, "staff_hold"); });
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.posted.some((m) => m.private && /Relay handoff: staff held the supervised draft/.test(m.content)));
  assert.ok(f.statuses.includes("open"));
});

test("a staff reply that turns the conversation Open during the wait discards the draft (the staff reply is the edit)", async () => {
  const f = fixture({ holdMs: 20000 });
  await heldRun(f, async () => { f.row.status = "open"; });
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_discarded" && l.outcome === "takeover_during_supervised_hold"));
});

test("FINDING 1: a staff reply seen on the webhook at the very end of the hold suppresses the draft even while Chatwoot still says pending", async () => {
  const f = fixture({ holdMs: 20000 });
  await heldRun(f, async () => { f.relay.accept(f.staffMsg(8200, "Hi, Eric here - let me help.", false)); });
  assert.equal(f.row.status, "pending", "the status lag is part of the scenario");
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_discarded" && l.outcome === "staff_replied_during_supervised_hold"));
});

test("FINDING 1: a staff reply in the THREAD whose webhook never arrived also suppresses the draft (status still pending)", async () => {
  const f = fixture({ holdMs: 20000 });
  await heldRun(f, async () => { f.storeStaff("Eric here, I have this one.", false); });
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_discarded" && l.via === "thread_read"));
});

test("FINDING 1: an @hold found only in the thread holds the draft; an ordinary staff private note does not (positive twin)", async () => {
  const f = fixture({ holdMs: 20000 });
  await heldRun(f, async () => { f.storeStaff("@hold wrong plan name", true); });
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_held_by_staff" && l.via === "thread_read"));
  const g = fixture({ holdMs: 20000 });
  await heldRun(g, async () => { g.storeStaff("looks fine to me", true); });
  assert.deepEqual(publicTexts(g), [MODEL_TEXT]);
});

test("FINDING 1: the thread cannot be read after the hold -> withheld (fail closed), the conversation goes to staff", async () => {
  const f = fixture({ holdMs: 20000, failThread: true });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "thread_unreadable"));
  assert.ok(f.statuses.includes("open"));
});

test("FINDING 3: the draft cannot be posted -> the model reply is withheld and a person is brought in (never sent unsupervised)", async () => {
  const f = fixture({ holdMs: 20000, failDraft: true });
  await f.relay.accept(f.customer()).done;
  assert.ok(!publicTexts(f).includes(MODEL_TEXT));
  assert.ok(f.posted.some((m) => m.private && /Relay handoff: the supervised draft could not be shown to staff/.test(m.content)));
  assert.ok(f.statuses.includes("open"));
});

test("PASS-2 FINDING 1: a thread page that no longer contains the draft (truncated, busy thread) -> coverage unknown -> withheld", async () => {
  const f = fixture({ holdMs: 20000, truncateTo: 3 });
  await heldRun(f, async () => { for (let i = 0; i < 5; i++) f.storeStaff(`private ${i}`, true); });
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "thread_coverage_unknown"));
  const g = fixture({ holdMs: 20000, truncateTo: 20 });
  await heldRun(g, async () => { for (let i = 0; i < 5; i++) g.storeStaff(`private ${i}`, true); });
  assert.deepEqual(publicTexts(g), [MODEL_TEXT], "POSITIVE TWIN: the same notes inside a page that still holds the draft do not block the send");
});

test("PASS-2 FINDING 2 (best effort): a staff reply stored between the final read and the send is made visible to staff, nothing is retracted or re-sent", async () => {
  const f = fixture({ holdMs: 20000, beforePublicPost: (fx) => fx.storeStaff("Eric: hi!", false) });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), [MODEL_TEXT], "the draft went out once (the race happened)");
  assert.ok(f.posted.some((m) => m.private && /a staff reply and the agent's draft went out at the same moment/.test(m.content)));
  const g = fixture({ holdMs: 20000 });
  await heldRun(g);
  assert.ok(!g.posted.some((m) => m.private && /same moment/.test(m.content)), "CONTROL: no overlap note without an overlap");
});

test("PASS-3/5: a page that no longer holds the CUSTOMER message being answered is not coverage -> withheld", async () => {
  const f = fixture({ holdMs: 20000, dropCustomerFromFirstRead: true });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "thread_coverage_unknown"));
});

test("PASS-3 FINDING 2: when the post-send page cannot confirm the overlap check, staff are told privately (the send already happened, nothing silent)", async () => {
  const f = fixture({ holdMs: 20000, dropSentFromSecondRead: true });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), [MODEL_TEXT]);
  assert.ok(f.posted.some((m) => m.private && /could not confirm nobody replied at the same moment/.test(m.content)));
  const g = fixture({ holdMs: 20000 });
  await heldRun(g);
  assert.ok(!g.posted.some((m) => m.private && /could not confirm/.test(m.content)), "CONTROL: a complete page raises no note");
});

test("PASS-3 FINDING 3: with a frozen clock, an @hold sent BEFORE the draft (same millisecond) does not suppress it; one sent DURING the hold does", async () => {
  const f = fixture({ holdMs: 20000, frozenClock: true });
  f.relay.accept(f.staffMsg(6300, "@hold"));   // older than the customer message
  await heldRun(f);
  assert.deepEqual(publicTexts(f), [MODEL_TEXT], "the pre-draft hold has no target");
  const g = fixture({ holdMs: 20000, frozenClock: true });
  await heldRun(g, async () => { g.relay.accept(g.staffMsg(8301, "@hold")); });
  assert.deepEqual(publicTexts(g), [], "POSITIVE TWIN: a hold during the wait still works on a frozen clock");
});

test("PASS-4 FINDING: an @hold or staff reply arriving WHILE the draft post is in flight counts (its marker is not cleared afterwards)", async () => {
  const f = fixture({ holdMs: 20000, failThread: false, duringDraftPost: (fx) => fx.relay.accept(fx.staffMsg(8400, "@hold")) });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_held_by_staff" && l.via === undefined), "caught by the webhook marker, before any thread read");
  const g = fixture({ holdMs: 20000, duringDraftPost: (fx) => fx.relay.accept(fx.staffMsg(8401, "Eric here", false)) });
  await heldRun(g);
  assert.deepEqual(publicTexts(g), []);
  assert.ok(g.logs.some((l) => l.event === "reply_discarded" && l.outcome === "staff_replied_during_supervised_hold" && l.via === undefined));
});

test("ownership read fails after the hold -> withheld + handoff, nothing customer-visible", async () => {
  const f = fixture({ holdMs: 20000, failOwnershipAfter: true });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "ownership_unreadable" && l.stage === "after_supervised_hold"));
});

test("an OLD @hold (before this draft) does not block it; a customer typing @hold is not a hold", async () => {
  const f = fixture({ holdMs: 20000 });
  f.relay.accept(f.staffMsg(6002, "@hold"));   // an id OLDER than the customer message (7002)
  const run = f.relay.accept(f.customer(7002, "@hold please")).done;
  await f.until(() => f.waiting);
  f.release(); await run;
  assert.deepEqual(publicTexts(f), [MODEL_TEXT]);
});

test("a duplicate delivery of the same customer message during the hold never produces a second draft, turn or reply", async () => {
  const f = fixture({ holdMs: 20000 });
  const run = f.relay.accept(f.customer(7010, "Hi")).done;
  await f.until(() => f.waiting);
  const dup = f.relay.accept(f.customer(7010, "Hi"));
  assert.deepEqual([dup.outcome, dup.reason], ["ignored", "duplicate"]);
  f.release(); await run;
  assert.equal(drafts(f).length, 1);
  assert.deepEqual(publicTexts(f), [MODEL_TEXT]);
  assert.equal(f.seldon.turns, 1);
});

test("decide(): only a PRIVATE note from a staff USER with a real id that starts with @hold is a hold (FINDING 2)", () => {
  const base = { event: "message_created", account: { id: 2 }, inbox: { id: 11 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } }, id: 1 };
  const d = (over) => decide(readEvent({ ...base, ...over }), SCOPE).act;
  assert.equal(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "user", id: 16 } }), "staff_hold");
  assert.equal(d({ content: "@HOLD now", message_type: 1, private: true, sender: { type: "user", id: 16 } }), "staff_hold");
  assert.notEqual(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "user" } }), "staff_hold");
  assert.notEqual(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "user", id: 0 } }), "staff_hold");
  assert.notEqual(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "agent_bot", id: 20 } }), "staff_hold");
  assert.notEqual(d({ content: "please @hold", message_type: "outgoing", private: true, sender: { type: "user", id: 16 } }), "staff_hold");
  assert.notEqual(d({ content: "@hold", message_type: "incoming", private: false, sender: { id: 541 } }), "staff_hold");
  assert.equal(d({ content: "hi", message_type: "outgoing", private: false, sender: { type: "user", id: 16 } }), "staff_reply");
  assert.equal(d({ content: "hi", message_type: "outgoing", private: false, sender: { type: "agent_bot", id: 20 } }), "ignore", "the relay's own bot replies are not staff replies");
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

test("PASS-5 FINDING: a staff reply that lands while the MODEL is still working (before the draft exists) suppresses the draft - webhook view", async () => {
  const f = fixture({ holdMs: 20000, duringModelTurn: (fx) => fx.relay.accept(fx.staffMsg(8500, "Eric here - I've got this.", false)) });
  await heldRun(f);
  assert.equal(f.row.status, "pending", "status deliberately still lagging");
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_discarded" && l.outcome === "staff_replied_during_supervised_hold" && l.via === undefined));
});

test("PASS-5 FINDING: the same pre-draft staff reply found ONLY in the thread (webhook lost) also suppresses the draft; a staff reply OLDER than the customer message does not (positive twin)", async () => {
  const f = fixture({ holdMs: 20000, duringModelTurn: (fx) => fx.storeStaff("Eric here.", false) });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "reply_discarded" && l.via === "thread_read"));
  const g = fixture({ holdMs: 20000 });
  g.relay.accept(g.staffMsg(6500, "earlier staff reply", false));
  await heldRun(g);
  assert.deepEqual(publicTexts(g), [MODEL_TEXT]);
});

test("PASS-6 FINDING: a STALE page (holds the customer message but not the draft, and misses a newer staff reply) is not coverage -> withheld", async () => {
  const f = fixture({ holdMs: 20000, stalePageWithoutDraft: true });
  await heldRun(f, async () => { f.storeStaff("Eric here.", false); });
  assert.deepEqual(publicTexts(f), []);
  assert.ok(f.logs.some((l) => l.event === "thread_coverage_unknown"));
  const g = fixture({ holdMs: 20000 });
  await heldRun(g);
  assert.deepEqual(publicTexts(g), [MODEL_TEXT], "POSITIVE TWIN: a fresh page that holds the draft lets the send through");
});

test("PRODUCTION SHAPE: the relay's OWN posts (Chatwoot user 20) during a turn never suppress the draft - webhook and thread views", async () => {
  const f = fixture({ holdMs: 20000, duringModelTurn: (fx) => { fx.relay.accept(fx.selfMsg(8600, "Your setup button is above")); fx.storeSelf("Your setup button is above"); } });
  await heldRun(f);
  assert.deepEqual(publicTexts(f), [MODEL_TEXT], "the agent reply still goes out");
  assert.ok(!f.logs.some((l) => l.event === "reply_discarded"));
  const g = fixture({ holdMs: 20000, duringModelTurn: (fx) => fx.storeStaff("Eric here.", false) });
  await heldRun(g);
  assert.deepEqual(publicTexts(g), [], "POSITIVE TWIN: a real staff user's reply in the same place still suppresses it");
});

test("decide(): the relay's own user id is never staff, even for a private @hold", () => {
  const base = { event: "message_created", account: { id: 2 }, inbox: { id: 11 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } }, id: 1 };
  const d = (over) => decide(readEvent({ ...base, ...over }), { ...SCOPE, selfUserId: RELAY_USER }).act;
  assert.notEqual(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "user", id: RELAY_USER } }), "staff_hold");
  assert.notEqual(d({ content: "hi", message_type: "outgoing", private: false, sender: { type: "user", id: RELAY_USER } }), "staff_reply");
  assert.equal(d({ content: "@hold", message_type: "outgoing", private: true, sender: { type: "user", id: 16 } }), "staff_hold", "CONTROL: a staff user still counts");
});

test("the hold REFUSES to run when the relay does not know its own user id (behaves exactly like hold OFF)", async () => {
  const f = fixture({ holdMs: 20000, selfUserId: null });
  await f.relay.accept(f.customer()).done;
  assert.deepEqual(f.posted, [{ content: MODEL_TEXT, private: false }], "no draft, immediate reply");
});

test("resolveSelfUserId: the profile id when readable; otherwise null with a logged warning (never boot-fatal)", async () => {
  const logs = [];
  assert.equal(await resolveSelfUserId({ getProfile: async () => ({ id: 20, name: "PL Relay Bot" }) }, (o) => logs.push(o)), 20);
  assert.equal(logs.length, 0);
  assert.equal(await resolveSelfUserId({ getProfile: async () => { throw new Error("HTTP 401"); } }, (o) => logs.push(o)), null);
  assert.equal(await resolveSelfUserId({ getProfile: async () => ({}) }, (o) => logs.push(o)), null);
  assert.equal(logs.filter((l) => l.event === "config_ignored").length, 2);
});
