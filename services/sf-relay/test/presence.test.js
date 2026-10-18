// rc10g: WhatsApp read receipt + typing indicator. Every absence assertion has a positive twin in this file (Law 19).
// No real Meta request is made: the client is exercised with an injected fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay, readEvent } from "../src/relay.js";
import { waPresenceClient } from "../src/clients.js";

const SCOPE = { accountId: 3, inboxId: 16 };
const WAMID = "wamid.HBgLMTc2NzAwMDAwMDAVAgASGBQzQUY5RkE3QjE5MDg0QzQzRjhFOAA=";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (over = {}) => ({ event: "message_created", id: over.id ?? 100, content: over.content ?? "Hi", message_type: "incoming", private: false,
  sender: { type: "contact", id: 541 }, account: { id: 3 }, inbox: { id: 16 }, source_id: "source_id" in over ? over.source_id : WAMID,
  conversation: { id: 41, status: over.status ?? "pending", meta: { sender: { id: 541 } } }, ...(over.attachments ? { attachments: over.attachments } : {}) });

function rig({ presenceResult = { ok: true }, presenceThrows = false, turnDelay = 0, refreshMs = 20_000, maxRefresh = 4 } = {}) {
  const log = [], posts = [], marks = [];
  const chatwoot = {
    getConversation: async () => ({ status: "pending", meta: { sender: { id: 541 } } }),
    postMessage: async (id, content, { private: p }) => { posts.push({ content, private: p }); },
    toggleStatus: async () => {}, assignOwner: async () => {}, assignTeam: async () => {},
  };
  const seldon = { turn: async () => { if (turnDelay) await sleep(turnDelay); return { ok: true, text: "Hi there 👋", conversationId: "sf-1" }; }, escalation: async () => ({ known: true, escalated: false }) };
  const presence = { markReadTyping: async (w) => { marks.push(w); if (presenceThrows) throw new Error("boom"); return presenceResult; } };
  const relay = createRelay({ scope: SCOPE, ownerUserId: 5, chatwoot, seldon, presence, presenceRefreshMs: refreshMs, presenceMaxRefresh: maxRefresh, logger: (o) => log.push(o) });
  return { relay, log, posts, marks };
}

test("readEvent carries a well-formed wamid and rejects anything else", () => {
  assert.equal(readEvent(msg()).sourceId, WAMID);
  assert.equal(readEvent(msg({ source_id: "not-a-wamid" })).sourceId, null);
  assert.equal(readEvent(msg({ source_id: null })).sourceId, null);
});

test("POSITIVE: an answered customer message is marked read + typing once, with its own wamid, and the reply is still sent", async () => {
  const r = rig();
  await r.relay.accept(msg()).done;
  assert.deepEqual(r.marks, [WAMID]);
  assert.ok(r.log.some((l) => l.event === "presence" && l.outcome === "read_typing"));
  assert.equal(r.posts.filter((p) => !p.private).length, 1);
});

test("NEGATIVE twin: a person-held (open) conversation gets NO read receipt (nobody is about to answer)", async () => {
  const r = rig();
  await r.relay.accept(msg({ status: "open" })).done;
  assert.deepEqual(r.marks, []);
  const c = rig(); await c.relay.accept(msg()).done; assert.equal(c.marks.length, 1, "control: the same message while pending IS marked");
});

test("NEGATIVE twin: a handoff decision (attachment, no text) and a message without a wamid get NO presence call", async () => {
  const a = rig(); await a.relay.accept(msg({ content: "", attachments: [{ id: 1 }] })).done; assert.deepEqual(a.marks, []);
  const b = rig(); await b.relay.accept(msg({ source_id: null })).done; assert.deepEqual(b.marks, []);
  assert.equal(b.posts.filter((p) => !p.private).length, 1, "the answer is unaffected when there is no wamid");
});

test("a presence failure or exception is logged and NEVER blocks or changes the answer", async () => {
  const f = rig({ presenceResult: { ok: false, detail: "http_400", metaCode: 100 } });
  await f.relay.accept(msg()).done;
  assert.ok(f.log.some((l) => l.event === "presence" && l.outcome === "failed" && l.detail === "http_400" && l.metaCode === 100));
  assert.equal(f.posts.filter((p) => !p.private).length, 1);
  const t = rig({ presenceThrows: true });
  await t.relay.accept(msg({ id: 101 })).done;
  assert.equal(t.posts.filter((p) => !p.private).length, 1);
  assert.ok(!t.log.some((l) => l.event === "relay_error"));
});

test("typing is refreshed while a long turn runs, capped, and stops when the turn ends", async () => {
  const r = rig({ turnDelay: 130, refreshMs: 30, maxRefresh: 10 });
  await r.relay.accept(msg()).done;
  const atEnd = r.marks.length;
  assert.ok(atEnd >= 3, `expected the first call plus refreshes during a 130 ms turn, got ${atEnd}`);
  await sleep(120);
  assert.equal(r.marks.length, atEnd, "no refresh after the turn ended");
  const capped = rig({ turnDelay: 200, refreshMs: 20, maxRefresh: 2 });
  await capped.relay.accept(msg()).done;
  assert.equal(capped.marks.length, 3, "first call + at most maxRefresh refreshes");
});

test("waPresenceClient sends exactly Meta's read+typing body to the phone-number endpoint and never echoes the token", async () => {
  const seen = [];
  const token = "EAAG" + "x".repeat(40);
  const c = waPresenceClient({ token, phoneNumberId: "1023804347491554", fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => ({ success: true }) }; } });
  const r = await c.markReadTyping(WAMID);
  assert.deepEqual(r, { ok: true });
  assert.equal(seen[0].url, "https://graph.facebook.com/v21.0/1023804347491554/messages");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].init.body), { messaging_product: "whatsapp", status: "read", message_id: WAMID, typing_indicator: { type: "text" } });
  assert.equal(seen[0].init.headers.authorization, `Bearer ${token}`);
  const bad = waPresenceClient({ token, phoneNumberId: "1023804347491554", fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 131009 } }) }) });
  const br = await bad.markReadTyping(WAMID);
  assert.deepEqual(br, { ok: false, detail: "http_400", metaCode: 131009 });
  assert.ok(!JSON.stringify(br).includes(token));
  assert.throws(() => waPresenceClient({ token: "short", phoneNumberId: "1" }), /token_invalid/);
});
