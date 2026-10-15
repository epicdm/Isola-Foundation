// War room (owner 2026-10-15, dec-owner-build-the-war-room-2026-10-15): supervised 20 s hold with "@hold", and staff trace notes.
// Every "was NOT sent" assertion has a positive twin in this file proving the same harness DOES send when nobody intervenes.
// Revised after Codex review (DO NOT SHIP, 4 findings): staff-reply race at hold end, draft-post failure, staff identity, test gaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRelay, decide, readEvent, traceLine, parseAgentGuidance, withStaffGuidance, GUIDE_MAX_CHARS } from "../src/relay.js";
import { parseSupervisedHoldMs, resolveSelfUserId } from "../src/server.js";
import { openConversationBinding, CONVERSATION_BINDING_ATTRIBUTE } from "../src/conversation-binding.js";
const RELAY_USER = 20;
const PL_KEY = "synthetic-pl-assertion-key-material-32-bytes-minimum";
const PL_BRIDGE_KEY = "synthetic-relay-context-key-material-32-bytes-minimum";
const PL_CONTACT = { payload: { id: 541, phone_number: "+17670000000", contact_inboxes: [{ source_id: "17679990001", inbox: { id: 11, channel_type: "Channel::Whatsapp", provider: "whatsapp_cloud" } }] } };

const SCOPE = { accountId: 2, inboxId: 11, workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "pl-staging-test-agent" };
const MODEL_TEXT = "Your line is ready. Open Cloud Softphone to make your first call.";
const EVIDENCE = { known: true, currentTurnVerified: true, escalated: false,
  toolCalls: [{ name: "pl-action-adapter__pl_journey", input: {} }, { name: "pl-action-adapter__pl_next_step", input: {} }],
  toolResults: [{ ok: true }, { ok: false, isError: true }] };

function fixture({ holdMs = 0, traceNotes = false, failDraft = false, failThread = false, failOwnershipAfter = false, truncateTo = 0, beforePublicPost = null, dropCustomerFromFirstRead = false, stalePageWithoutDraft = false, dropSentFromSecondRead = false, frozenClock = false, duringDraftPost = null, duringModelTurn = null, selfUserId = RELAY_USER, texts = null, pl = false, turnSeq = null, evidenceSeq = null } = {}) {
  let reads = 0;
  let t = 1_797_000_000_000;
  const posted = [], statuses = [], logs = [], thread = [];
  let nextId = 9000;
  const row = { id: 41, account_id: 2, inbox_id: 11, status: "pending", custom_attributes: {}, meta: { channel: "Channel::Whatsapp", sender: { id: 541 }, assignee: { id: 16 } } };
  let release = null;
  let sleeps = 0;
  const sleep = () => new Promise((r) => { sleeps += 1; release = r; });
  const chatwoot = {
    async getConversation() { if (failOwnershipAfter && release !== null) throw new Error("chatwoot read timeout"); return structuredClone(row); },
    async getContact() { return pl ? structuredClone(PL_CONTACT) : {}; },
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
    turns: 0, turnInputs: [],
    async turn(input) {
      seldon.turns += 1; seldon.turnInputs.push(input);
      if (duringModelTurn) { const h = duringModelTurn; duringModelTurn = null; h(api); }
      if (turnSeq && turnSeq.length) return turnSeq.shift();
      return { ok: true, text: texts ? texts[Math.min(seldon.turns, texts.length) - 1] : MODEL_TEXT, conversationId: "sf-conv", conversationCapability: "cap" };
    },
    async escalation() { return { known: true, escalated: false }; },
    async inspectTurn() { return structuredClone(evidenceSeq ? evidenceSeq[Math.min(seldon.turns, evidenceSeq.length) - 1] : EVIDENCE); },
  };
  const relay = createRelay({ scope: SCOPE, ownerUserId: 16, chatwoot, seldon, requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32",
    plConcierge: pl ? { key: PL_KEY, kid: "uat1", bridgeKey: PL_BRIDGE_KEY, bridgeKid: "ctx1", phoneNumberId: "1023804347491554" } : null,
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
  const api = { relay, posted, statuses, logs, row, seldon, customer, staffMsg, storeStaff, storeSelf, selfMsg, until, release: () => release && release(), get waiting() { return release !== null; }, get sleeps() { return sleeps; } };
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
    assert.match(drafts(f)[0].content, /^DRAFT - sends in 20 s unless you type @hold, @agent <guidance>, or reply yourself/);
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// War room STEERING (owner 2026-10-15: "we could interject and steer the agents before the agent answers"): "@agent <guidance>" during the hold.
const REWRITE = "Top-ups are in your Cloud Softphone app: open the EPIC tab and tap Add credit.";
const sent = (f) => publicTexts(f);
async function steeredRun(f, actions) {   // actions[i] runs during hold i (null = do nothing); every hold is released in turn
  const run = f.relay.accept(f.customer(7001, "how do I top up?")).done;
  for (let i = 0; i < actions.length; i++) {
    await f.until(() => f.sleeps === i + 1);
    if (actions[i]) await actions[i]();
    f.release();
  }
  await run;
}

test("STEER: @agent on the webhook during the hold -> draft discarded, the agent answers the SAME message again with the guidance, the REWRITE gets its own hold, then only the rewrite is sent", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [
    async () => { assert.equal(f.relay.accept(f.staffMsg(8301, "@agent tell him top-up is in the Cloud Softphone app, Add credit")).reason, "staff_guide"); },
    async () => {
      assert.equal(drafts(f).length, 2);
      assert.match(drafts(f)[1].content, /^DRAFT \(rewritten with your @agent guidance\) - sends in 10 s/);
      assert.ok(drafts(f)[1].content.includes(REWRITE));
      assert.deepEqual(sent(f), [], "nothing public during either hold");
    },
  ]);
  assert.deepEqual(sent(f), [REWRITE], "only the rewritten reply reaches the customer; the first draft never does");
  assert.equal(f.seldon.turns, 2);
  const guided = f.seldon.turnInputs[1];
  assert.equal(guided.message, withStaffGuidance("tell him top-up is in the Cloud Softphone app, Add credit", "how do I top up?"));
  assert.ok(guided.message.endsWith("\nhow do I top up?"), "the customer's message is last");
  assert.equal(guided.conversationId, "sf-conv", "same Uplink conversation (continuation), not a new one");
  assert.equal(guided.conversationCapability, "cap");
  assert.ok(!f.logs.some((l) => JSON.stringify(l).includes("Add credit")), "guidance text is never logged");
  assert.ok(f.logs.some((l) => l.event === "guided_rewrite" && l.round === 1));
});

test("STEER CONTROL: an ordinary staff private note (not @agent, not @hold) during the hold changes nothing - one turn, the first draft is sent", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(8302, "looks fine to me")); f.storeStaff("agent: looks fine", true); }]);
  assert.deepEqual(sent(f), [MODEL_TEXT]);
  assert.equal(f.seldon.turns, 1);
});

test("STEER: an @agent note found ONLY in the thread (webhook lost) also steers; the rewrite is sent", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [async () => { f.storeStaff("@agent mention Add credit in the app", true); }, null]);
  assert.deepEqual(sent(f), [REWRITE]);
  assert.match(f.seldon.turnInputs[1].message, /mention Add credit in the app/);
});

test("STEER: an @agent typed while the MODEL is still working (after the customer spoke, before the draft) steers that draft", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE], duringModelTurn: (api) => api.relay.accept(api.staffMsg(9500, "@agent keep it short")) });
  await steeredRun(f, [null, null]);
  assert.deepEqual(sent(f), [REWRITE]);
  assert.equal(f.seldon.turns, 2);
});

test("STEER: an @agent OLDER than the customer message is not guidance for it (positive twin above); a customer typing @agent is not staff", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  f.relay.accept(f.staffMsg(6000, "@agent stale guidance for an earlier message"));
  await steeredRun(f, [null]);
  assert.deepEqual(sent(f), [MODEL_TEXT], "the first draft was sent unchanged");
  assert.ok(!f.seldon.turnInputs.some((t) => /stale guidance/.test(t.message)));
  assert.equal(decide(readEvent(f.customer(7003, "@agent do x")), { ...SCOPE, selfUserId: RELAY_USER }).act, "answer");
});

test("STEER + @hold: @hold wins over @agent in the same hold - nothing is sent, the conversation goes to staff, no second turn", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(8401, "@agent say X")); f.relay.accept(f.staffMsg(8402, "@hold")); }]);
  assert.deepEqual(sent(f), []);
  assert.equal(f.seldon.turns, 1);
  assert.ok(f.statuses.includes("open"));
});

test("STEER: @hold during the REWRITE's hold also stops it (the rewrite is never sent)", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(8501, "@agent say Y")); }, async () => { f.relay.accept(f.staffMsg(8502, "@hold")); }]);
  assert.deepEqual(sent(f), []);
  assert.equal(f.seldon.turns, 2);
});

test("STEER LIMIT: two rewrites are allowed; guidance a THIRD time withholds the draft and brings in a person (never an endless loop of paid turns)", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, "rewrite one", "rewrite two"] });
  await steeredRun(f, [
    async () => { f.relay.accept(f.staffMsg(8601, "@agent one")); },
    async () => { f.relay.accept(f.staffMsg(8602, "@agent two")); },
    async () => { f.relay.accept(f.staffMsg(8603, "@agent three")); },
  ]);
  assert.deepEqual(sent(f), []);
  assert.equal(f.seldon.turns, 3);
  assert.ok(f.posted.some((m) => m.private && /steered this reply 2 times/.test(m.content)));
});

test("STEER POSITIVE TWIN of the limit: two rewrites then silence -> the second rewrite is sent", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, "rewrite one", "rewrite two"] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(8701, "@agent one")); }, async () => { f.relay.accept(f.staffMsg(8702, "@agent two")); }, null]);
  assert.deepEqual(sent(f), ["rewrite two"]);
});

test("STEER: the rewrite goes through the SAME checks as any turn - a rewrite that claims a human takeover is withheld and handed off, not sent", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, "I've connected you with a person from our team."] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(8801, "@agent hand off")); }]);
  assert.deepEqual(sent(f).filter((t) => /connected you with/.test(t)), []);
  assert.ok(f.logs.some((l) => l.event === "unbacked_handoff_language"));
});

test("STEER: the guided turn hitting the Uplink conversation limit -> withheld, staff told to reply themselves (no rotation of a steered turn)", async () => {
  const f = fixture({ holdMs: 10000, turnSeq: [{ ok: true, text: MODEL_TEXT, conversationId: "sf-conv", conversationCapability: "cap" }, { ok: false, reason: "http_503", error: "PUBLIC_CHAT_CONVERSATION_LIMIT", conversationId: null }] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(8901, "@agent say Z")); }]);
  assert.deepEqual(sent(f), []);
  assert.ok(f.posted.some((m) => m.private && /could not take the staff guidance/.test(m.content)));
});

test("STEER, hold OFF: @agent is an ignored non-incoming event, logged exactly as before (no guidance state, no extra turn)", async () => {
  const f = fixture();
  const r = f.relay.accept(f.staffMsg(9001, "@agent say W"));
  assert.deepEqual([r.outcome, r.reason], ["ignored", "not_incoming"]);
  await f.relay.accept(f.customer()).done;
  assert.deepEqual(f.posted, [{ content: MODEL_TEXT, private: false }]);
  assert.equal(f.seldon.turns, 1);
});

test("STEER, signed context: the guided turn's context binds the text SENT (guidance + message) and still carries the customer's own message digest for the adapter; it verifies", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE], pl: true });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(9101, "@agent mention Add credit")); }, null]);
  const [first, guided] = f.seldon.turnInputs;
  assert.ok(first.relayContext && guided.relayContext, "both turns carry a signed context (positive control: PL identity resolved)");
  const claims = JSON.parse(Buffer.from(guided.relayContext.split(".")[1], "base64url").toString("utf8"));
  const sha = (x) => createHash("sha256").update(x).digest("hex");
  assert.equal(claims.messageSha256, sha(guided.message));
  assert.equal(claims.originalMessageSha256, sha("how do I top up?"));
  assert.deepEqual(sent(f), [REWRITE]);
});

test("parseAgentGuidance: only '@agent <text>' with real text; control characters collapsed; capped", () => {
  assert.equal(parseAgentGuidance("@agent  say  hi\n\nnow"), "say hi now");
  assert.equal(parseAgentGuidance("@Agent x"), "x");
  assert.equal(parseAgentGuidance("@agent"), null);
  assert.equal(parseAgentGuidance("@agents x"), null);
  assert.equal(parseAgentGuidance("hello @agent x"), null);
  assert.equal(parseAgentGuidance("@agent " + "a".repeat(900)).length, GUIDE_MAX_CHARS);
  const d = (content, priv = true, senderId = 16) => decide(readEvent({ event: "message_created", id: 1, content, message_type: "outgoing", private: priv, sender: { type: "user", id: senderId }, account: { id: 2 }, inbox: { id: 11 }, conversation: { id: 41 } }), { ...SCOPE, selfUserId: RELAY_USER }).act;
  assert.equal(d("@agent say hi"), "staff_guide");
  assert.equal(d("@agent say hi", false), "staff_reply", "a PUBLIC @agent is a staff reply, never guidance");
  assert.equal(d("@agent say hi", true, RELAY_USER), "ignore", "the relay's own note is never guidance");
  assert.equal(d("@agent"), "ignore", "empty guidance is not guidance");
});

// Codex steer pass 1 (DO NOT SHIP, 3 defects + test gap): staff actions visible only in the thread beat webhook guidance; the rewrite is
// durably marked in flight before Uplink sees it; a rewrite that cannot be signed is never sent.
test("STEER PASS-1: @agent on the webhook but an @hold visible ONLY in the thread -> no rewrite turn, nothing sent, conversation to staff", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(9201, "@agent say X")); f.storeStaff("@hold", true); }]);
  assert.deepEqual(sent(f), []);
  assert.equal(f.seldon.turns, 1, "the guidance never reached Uplink");
  assert.ok(f.statuses.includes("open"));
});

test("STEER PASS-1: @agent on the webhook but a staff PUBLIC reply visible ONLY in the thread -> no rewrite turn, the draft is dropped", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(9202, "@agent say X")); f.storeStaff("Eric here, I'll take this.", false); }]);
  assert.deepEqual(sent(f), [], "only the staff reply (stored directly, not via the relay) exists");
  assert.equal(f.seldon.turns, 1);
});

test("STEER PASS-1: the conversation turned Open during the hold beats @agent (ownership is read even when guidance is pending)", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(9203, "@agent say X")); f.row.status = "open"; }]);
  assert.deepEqual(sent(f), []);
  assert.equal(f.seldon.turns, 1);
});

test("STEER PASS-1: the rewrite is durably marked processing for THIS message BEFORE Uplink sees it; vet() returns it to ready with the new continuation", async () => {
  const f = fixture({ holdMs: 10000, turnSeq: [{ ok: true, text: MODEL_TEXT, conversationId: "sf-conv", conversationCapability: "cap" }, { ok: true, text: REWRITE, conversationId: "sf-conv", conversationCapability: "cap-2" }] });
  const atTurn = [];
  const orig = f.seldon.turn;
  f.seldon.turn = async (input) => { atTurn.push(openConversationBinding(f.row.custom_attributes[CONVERSATION_BINDING_ATTRIBUTE], "synthetic-state-key-material-long-enough-32")); return orig.call(f.seldon, input); };
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(9204, "@agent say X")); }, null]);
  assert.equal(atTurn.length, 2);
  assert.deepEqual([atTurn[1].phase, atTurn[1].pendingMessageId], ["processing", 7001], "in flight before the rewrite turn");
  const final = openConversationBinding(f.row.custom_attributes[CONVERSATION_BINDING_ATTRIBUTE], "synthetic-state-key-material-long-enough-32");
  assert.deepEqual([final.phase, final.conversationCapability, final.lastCompletedMessageId], ["ready", "cap-2", 7001]);
  assert.deepEqual(sent(f), [REWRITE]);
});

test("STEER PASS-1: guidance + customer message too long to sign -> the rewrite is NEVER sent unsigned; withheld, staff told; (positive twin: the signed-context test above)", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, REWRITE], pl: true });
  const long = "I need help with my line please. ".repeat(48).trim();   // ~1580 chars: signs alone, not with framing + 500 chars of guidance
  const run = f.relay.accept(f.customer(7001, long)).done;
  await f.until(() => f.sleeps === 1);
  f.relay.accept(f.staffMsg(9205, "@agent " + "be very kind and explain the Add credit steps in the app clearly. ".repeat(10)));
  f.release(); await run;
  assert.ok(f.seldon.turnInputs[0].relayContext, "CONTROL: the original turn was signed");
  assert.equal(f.seldon.turns, 1, "the unsigned rewrite never reached Uplink");
  assert.deepEqual(sent(f), []);
  assert.ok(f.logs.some((l) => l.event === "guided_rewrite_unsigned"));
});

// Codex steer pass 2 (DO NOT SHIP): two vet() outcomes post to the customer at once (agent asked for a person; verified plan offer).
// On a guided rewrite neither may go out unsupervised: withheld, staff reply themselves.
const OFFER_EVIDENCE = { known: true, currentTurnVerified: true, escalated: false,
  toolCalls: [{ id: "call-1", name: "pl-action-adapter__pl_present_offer", input: { offer_key: "trial" } }],
  toolResults: [{ toolCallId: "call-1", ok: true, output: { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "offer_issued", offer_key: "trial", confirm_with: "1", customer_message: "Free trial: 7 days with 60 minutes included. Reply 1 to start it now." }) }] } }] };
test("STEER PASS-2: a rewrite whose turn ESCALATES (agent asked for a person) is withheld - nothing public, staff reply themselves; CONTROL: the same escalation on the ORIGINAL turn still posts as before", async () => {
  const f = fixture({ holdMs: 10000, texts: [MODEL_TEXT, "Let me get someone."], evidenceSeq: [EVIDENCE, { ...EVIDENCE, escalated: true, reason: "customer upset" }] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(9301, "@agent apologise")); }]);
  assert.deepEqual(sent(f), []);
  assert.ok(f.logs.some((l) => l.event === "guided_rewrite_withheld" && l.reason === "agent_requested_person"));
  const c = fixture({ holdMs: 10000, evidenceSeq: [{ ...EVIDENCE, escalated: true, reason: "customer upset" }] });
  await c.relay.accept(c.customer()).done;
  assert.equal(sent(c).length, 1, "CONTROL: unchanged original-turn escalation still answers the customer");
});

test("STEER PASS-2: a rewrite that produces a verified plan OFFER is withheld (never posted without a hold); CONTROL: the same offer on the original turn still posts", async () => {
  const f = fixture({ holdMs: 10000, pl: true, texts: [MODEL_TEXT, "Here is the offer."], evidenceSeq: [EVIDENCE, OFFER_EVIDENCE] });
  await steeredRun(f, [async () => { f.relay.accept(f.staffMsg(9302, "@agent offer the trial")); }]);
  assert.deepEqual(sent(f), []);
  assert.ok(f.logs.some((l) => l.event === "guided_rewrite_withheld" && l.reason === "canonical_offer"));
  const c = fixture({ holdMs: 10000, pl: true, evidenceSeq: [OFFER_EVIDENCE] });
  await c.relay.accept(c.customer()).done;
  assert.deepEqual(sent(c), ["Free trial: 7 days with 60 minutes included. Reply 1 to start it now."], "CONTROL: the offer path itself works in this harness");
});
