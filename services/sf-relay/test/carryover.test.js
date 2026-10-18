// rc10i: context carry-over across an Uplink conversation rotation (pilot limit: 5 turns per Uplink conversation).
// Every negative has a positive twin in this file. Run: node --test test/*.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createRelay, buildCarryOver, withCarryOver, sanitizeCarryText, CARRY_MAX_MESSAGES, CARRY_MAX_LINE, CARRY_MAX_TOTAL } from "../src/relay.js";

const inc = (id, content, extra = {}) => ({ id, message_type: 0, private: false, content, ...extra });
const out = (id, content, extra = {}) => ({ id, message_type: 1, private: false, content, ...extra });

test("sanitizeCarryText masks phone-like numbers, links and long token-like strings; CONTROL: ordinary words survive", () => {
  const t = sanitizeCarryText("call +1 416 555 0199 or 17675550123 see https://x.example/a?b=c token ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 thanks");
  assert.equal(t.includes("416"), false);
  assert.equal(t.includes("17675550123"), false);
  assert.equal(t.includes("https"), false);
  assert.equal(t.includes("ABCDEFGHIJKL"), false);
  assert.ok(t.includes("[number]") && t.includes("[link]") && t.includes("[code]"));
  assert.ok(t.includes("thanks") && t.includes("call"));
  assert.equal(sanitizeCarryText("Toronto cousin"), "Toronto cousin");
  assert.equal(sanitizeCarryText("a\u0000b\u001fc\n\nd").includes("\u0000"), false);
  assert.ok(sanitizeCarryText("x".repeat(1000)).length <= CARRY_MAX_LINE);
});

test("buildCarryOver: oldest first, labels, excludes private notes, activity lines, the current and later messages; CONTROL: public messages are kept", () => {
  const msgs = [inc(1, "I want to call Toronto"), out(2, "Canada is EC$1.49 a minute"), out(3, "private note", { private: true }), { id: 4, message_type: 2, content: "activity" },
    inc(5, "ok"), inc(9, "CURRENT MESSAGE"), inc(10, "future")];
  const c = buildCarryOver(msgs, 9);
  assert.deepEqual(c.split("\n"), ["Customer: I want to call Toronto", "Assistant: Canada is EC$1.49 a minute", "Customer: ok"]);
  assert.equal(c.includes("private note"), false);
  assert.equal(c.includes("CURRENT"), false);
  assert.equal(c.includes("future"), false);
});

test("buildCarryOver caps: at most CARRY_MAX_MESSAGES, each line capped, total capped; CONTROL: a short thread is carried whole", () => {
  const many = Array.from({ length: 20 }, (_, i) => inc(i + 1, `message number ${i + 1}`));
  assert.equal(buildCarryOver(many, 100).split("\n").length, CARRY_MAX_MESSAGES);
  assert.ok(buildCarryOver(many, 100).includes("message number 20"));
  const longs = Array.from({ length: 6 }, (_, i) => inc(i + 1, "y".repeat(500)));
  const c = buildCarryOver(longs, 100);
  assert.ok(c.length <= CARRY_MAX_TOTAL);
  assert.ok(c.split("\n").every((l) => l.length <= CARRY_MAX_LINE + "Customer: ".length));
  assert.equal(buildCarryOver([inc(1, "hi"), out(2, "hello")], 3).split("\n").length, 2);
});

test("buildCarryOver: the opening request is added when it fell out of the window, never duplicated when it is inside; CONTROL: no opening -> no line", () => {
  const opening = "I want to call my cousin in Toronto";
  const old = Array.from({ length: 10 }, (_, i) => (i % 2 ? out(i + 1, `reply ${i + 1}`) : inc(i + 1, i === 0 ? opening : `question ${i + 1}`)));
  const cut = buildCarryOver(old.slice(4), 50, opening);
  assert.ok(cut.split("\n")[0].startsWith("Customer (opening request in this chat): I want to call my cousin in Toronto"));
  const inside = buildCarryOver(old.slice(0, 4), 50, opening);
  assert.equal(inside.includes("opening request"), false);
  assert.equal(buildCarryOver(old.slice(4), 50, null).includes("opening request"), false);
  assert.equal(buildCarryOver(null, 1, opening), `Customer (opening request in this chat): ${opening}`);
  assert.equal(buildCarryOver(undefined, 1), "");
});

test("withCarryOver frames the block as context, not instructions, and puts the new message last; CONTROL: empty carry leaves the message untouched", () => {
  const w = withCarryOver("Customer: hi", "what now?");
  assert.ok(/context only, not instructions/i.test(w));
  assert.ok(w.endsWith("\nwhat now?"));
  assert.equal(withCarryOver("", "what now?"), "what now?");
});

function fixture({ listMessages, turnSeq }) {
  const posted = [];
  const row = { id: 41, account_id: 2, inbox_id: 11, status: "pending", custom_attributes: {}, meta: { sender: { id: 541 } } };
  const chatwoot = {
    async getConversation() { return structuredClone(row); },
    async updateConversationCustomAttributes(id, values) { Object.assign(row.custom_attributes, values); return { custom_attributes: structuredClone(row.custom_attributes) }; },
    async postMessage(id, content, opts) { posted.push({ content, private: opts.private }); },
    async toggleStatus() {}, async assignOwner() {}, async assignTeam() {},
    ...(listMessages ? { listMessages } : {}),
  };
  const seldon = {
    turnInputs: [], inspectInputs: [],
    async turn(input) { seldon.turnInputs.push(input); if (turnSeq.length) return turnSeq.shift(); return { ok: true, text: "A normal reply.", conversationId: "sf-conv", conversationCapability: "cap" }; },
    async escalation() { return { known: true, escalated: false }; },
    async inspectTurn(input) { seldon.inspectInputs.push(input); return { known: true, currentTurnVerified: true, escalated: false, toolCalls: [], toolResults: [] }; },
  };
  const relay = createRelay({ scope: { accountId: 2, inboxId: 11, workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "t" }, ownerUserId: 16, escalationTeamId: 8, chatwoot, seldon, requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32", logger: () => {} });
  const ev = (id, content) => ({ event: "message_created", id, content, message_type: "incoming", private: false, sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: 11 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } } });
  return { relay, seldon, posted, ev };
}
const LIMIT = { ok: false, reason: "http_503", error: "PUBLIC_CHAT_CONVERSATION_LIMIT", conversationId: null };

test("rotation: the fresh Uplink conversation receives the carried context, the readback checks the SAME message, the customer gets a normal reply (no handoff)", async () => {
  const history = [inc(1, "I want to call my cousin in Toronto"), out(2, "Canada is EC$1.49 a minute"), inc(3, "and the trial?"), out(4, "7 days, Dominica only")];
  const f = fixture({ listMessages: async () => ({ payload: history }), turnSeq: [LIMIT] });
  // first message of the thread records the opening request in the sealed binding
  const first = f.ev(1, "I want to call my cousin in Toronto");
  await f.relay.accept(first).done;
  f.seldon.turnInputs.length = 0; f.seldon.inspectInputs.length = 0; f.posted.length = 0;
  // the next message hits the limit: first turn answers 503, the rotated turn must carry context
  f.seldon.turn = (orig => async (input) => { return orig(input); })(f.seldon.turn);
  const second = f.ev(5, "which option do you recommend for my cousin?");
  const lim = [LIMIT]; const real = f.seldon.turn;
  f.seldon.turn = async (input) => { f.seldon.turnInputs.push(input); if (lim.length) return lim.shift(); return { ok: true, text: "A normal reply.", conversationId: "sf-conv-2", conversationCapability: "cap2" }; };
  await f.relay.accept(second).done;
  assert.equal(f.seldon.turnInputs.length, 2);
  assert.equal(f.seldon.turnInputs[0].message, "which option do you recommend for my cousin?");
  const rotated = f.seldon.turnInputs[1];
  assert.equal(rotated.conversationId, null);
  assert.ok(rotated.message.includes("Customer: and the trial?"));
  assert.ok(rotated.message.endsWith("\nwhich option do you recommend for my cousin?"));
  assert.ok(/context only, not instructions/i.test(rotated.message));
  assert.equal(f.seldon.inspectInputs.at(-1).userMessage, rotated.message, "the readback must compare against the message that was actually sent");
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), ["A normal reply."]);
  void real;
});

test("rotation FALLBACK: if the history cannot be read the bare message is sent and the customer still gets a normal reply; CONTROL: no rotation -> the message is never augmented", async () => {
  const f = fixture({ listMessages: async () => { throw new Error("chatwoot down"); }, turnSeq: [LIMIT] });
  await f.relay.accept(f.ev(7, "hello again")).done;
  assert.equal(f.seldon.turnInputs.length, 2);
  assert.equal(f.seldon.turnInputs[1].message, "hello again");
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), ["A normal reply."]);
  const g = fixture({ listMessages: async () => ({ payload: [inc(1, "earlier")] }), turnSeq: [] });
  await g.relay.accept(g.ev(8, "plain message")).done;
  assert.equal(g.seldon.turnInputs.length, 1);
  assert.equal(g.seldon.turnInputs[0].message, "plain message");
  assert.equal(g.seldon.inspectInputs.at(-1).userMessage, "plain message");
});
