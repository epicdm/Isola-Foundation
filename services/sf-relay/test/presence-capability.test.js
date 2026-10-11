// rc10g corrections (PM 2026-10-11): presence only for a FRESH, ACCEPTED message on the production (capability) path; optional at
// boot; never delays the reply; redacted diagnostics. Every absence assertion has a positive twin in the same rig (Law 19).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "../src/relay.js";
import { buildPresence } from "../src/server.js";

const SCOPE = { accountId: 2, inboxId: 11, workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "uplinks-workspace-4816--default" };
const STATE_KEY = "synthetic-only-state-key-material-32-bytes-minimum";
const WAMID = (n) => `wamid.HBgLMTc2NzAwMDAwMDAVAgASGBQz${String(n).padStart(8, "0")}AA==`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ev({ id, status = "pending", content = "How do I make a call?", extra = {} }) {
  return { event: "message_created", id, content, message_type: "incoming", private: false, source_id: WAMID(id),
    sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: 11 },
    conversation: { id: 41, status, meta: { sender: { id: 541 } } }, ...extra };
}

function rig({ liveStatus = "pending", presenceImpl } = {}) {
  const logs = [], posts = [], marks = [];
  const row = { id: 41, account_id: 2, inbox_id: 11, status: liveStatus, custom_attributes: {}, meta: { sender: { id: 541 } } };
  const chatwoot = {
    getConversation: async () => structuredClone(row),
    updateConversationCustomAttributes: async (id, v) => { Object.assign(row.custom_attributes, v); return { custom_attributes: structuredClone(row.custom_attributes) }; },
    postMessage: async (id, content, { private: p }) => { posts.push({ content, private: p }); },
    toggleStatus: async (id, s) => { row.status = s; }, assignOwner: async () => {}, assignTeam: async () => {},
  };
  let n = 0;
  const seldon = {
    turn: async () => ({ ok: true, text: "Open Cloud Softphone and dial +1 767 and the number.", conversationId: "10000000-0000-4000-8000-000000000041", conversationCapability: `cap-${++n}` }),
    escalation: async () => ({ known: true, escalated: false }),
  };
  const presence = { markReadTyping: presenceImpl ?? (async (w) => { marks.push(w); return { ok: true }; }) };
  const relay = createRelay({ scope: SCOPE, ownerUserId: 5, escalationTeamId: 8, chatwoot, seldon, requireCapability: true, conversationStateKey: STATE_KEY, presence, logger: (o) => logs.push(o) });
  return { relay, logs, posts, marks, row };
}
const replies = (r) => r.posts.filter((p) => !p.private);

test("POSITIVE (capability path): an accepted fresh message is marked read + typing with ITS OWN wamid, then answered", async () => {
  const r = rig();
  await r.relay.accept(ev({ id: 7001 })).done;
  assert.deepEqual(r.marks, [WAMID(7001)]);
  assert.equal(replies(r).length, 1);
});

test("NEGATIVE twin: the payload says pending but the LIVE record says a person holds it (open) -> no typing, no answer", async () => {
  const r = rig({ liveStatus: "open" });
  await r.relay.accept(ev({ id: 7002 })).done;
  assert.deepEqual(r.marks, []);
  assert.equal(replies(r).length, 0);
  const c = rig(); await c.relay.accept(ev({ id: 7002 })).done; assert.equal(c.marks.length, 1, "control: same message, live pending -> marked");
});

test("NEGATIVE twin: a duplicate delivery (same message id again) gets no second presence call", async () => {
  const r = rig();
  await r.relay.accept(ev({ id: 7003 })).done;
  await r.relay.accept(ev({ id: 7003 })).done;
  assert.deepEqual(r.marks, [WAMID(7003)], "exactly one call for the message");
  assert.equal(replies(r).length, 1);
});

test("NEGATIVE twin: a durable duplicate (already completed per the stored binding, new relay process) gets no presence", async () => {
  const a = rig();
  await a.relay.accept(ev({ id: 7004 })).done;
  assert.equal(a.marks.length, 1, "control: first delivery marked");
  // a restarted relay sees the stored binding (same Chatwoot row) and the same message again
  const b = rig(); b.row.custom_attributes = structuredClone(a.row.custom_attributes);
  await b.relay.accept(ev({ id: 7004 })).done;
  assert.ok(b.logs.some((l) => l.reason === "durable_duplicate"), "the durable duplicate path ran");
  assert.deepEqual(b.marks, []);
});

test("NEGATIVE twin: rejected/ignored events (not incoming, private, wrong inbox) and an explicit person request get no presence", async () => {
  const r = rig();
  await r.relay.accept({ ...ev({ id: 7005 }), message_type: "outgoing" }).done;
  await r.relay.accept({ ...ev({ id: 7006 }), private: true }).done;
  await r.relay.accept({ ...ev({ id: 7007 }), inbox: { id: 99 } }).done;
  assert.deepEqual(r.marks, []);
  await r.relay.accept(ev({ id: 7009 })).done;
  assert.deepEqual(r.marks, [WAMID(7009)], "control: an ordinary message in the same rig IS marked");
  // A person request hands off (the conversation becomes open), so it gets its own rig and its own control.
  const h = rig();
  await h.relay.accept(ev({ id: 7008, content: "I want to talk to a person" })).done;
  assert.deepEqual(h.marks, []);
  assert.equal(h.row.status, "open", "the handoff really happened");
  const hc = rig(); await hc.relay.accept(ev({ id: 7008 })).done; assert.equal(hc.marks.length, 1, "control: the same id as an ordinary question IS marked");
});

test("a Meta call that hangs (timeout) never delays the customer reply", async () => {
  const r = rig({ presenceImpl: () => new Promise(() => {}) });
  const t0 = Date.now();
  await r.relay.accept(ev({ id: 7010 })).done;
  assert.ok(Date.now() - t0 < 500, `reply path took ${Date.now() - t0} ms`);
  assert.equal(replies(r).length, 1);
});

test("permission failure / invalid token / thrown error -> redacted log, reply unaffected, no relay_error", async () => {
  const token = "EAAG" + "z".repeat(60);
  for (const [i, impl] of [[11, async () => ({ ok: false, detail: "http_403", metaCode: 10 })], [12, async () => ({ ok: false, detail: "http_401", metaCode: 190 })], [13, async () => { throw new Error(`boom ${token}`); }]]) {
    const r = rig({ presenceImpl: impl });
    await r.relay.accept(ev({ id: 7000 + i * 10 })).done;
    assert.equal(replies(r).length, 1);
    assert.ok(!r.logs.some((l) => l.event === "relay_error"));
    assert.ok(!JSON.stringify(r.logs).includes(token), "the token never reaches a log line");
  }
});

test("buildPresence: not configured / missing / malformed / too short / bad phone id -> null with a fixed reason; valid -> client", () => {
  const dir = mkdtempSync(join(tmpdir(), "presence-"));
  const good = join(dir, "good"); writeFileSync(good, "EAAG" + "a".repeat(60) + "\n");
  const noisy = join(dir, "noisy"); writeFileSync(noisy, "I, [2026-10-11] INFO -- : booting\nEAAG" + "a".repeat(60));
  const empty = join(dir, "empty"); writeFileSync(empty, "");
  const short = join(dir, "short"); writeFileSync(short, "EAAGabc");
  const run = (env) => { const logs = []; const p = buildPresence({ env, logger: (o) => logs.push(o), fallbackPhoneNumberId: "1023804347491554" }); return { p, logs }; };
  const cases = [
    [{}, "not_configured"], [{ WA_PRESENCE_TOKEN_FILE: join(dir, "absent") }, "token_file_missing"],
    [{ WA_PRESENCE_TOKEN_FILE: noisy }, "token_file_malformed"], [{ WA_PRESENCE_TOKEN_FILE: empty }, "token_file_malformed"],
    [{ WA_PRESENCE_TOKEN_FILE: short }, "token_invalid"], [{ WA_PRESENCE_TOKEN_FILE: good, WA_PRESENCE_PHONE_NUMBER_ID: "abc" }, "phone_number_id_invalid"],
  ];
  for (const [env, reason] of cases) {
    const { p, logs } = run(env);
    assert.equal(p, null, `${reason}: presence disabled`);
    assert.deepEqual(logs, [{ event: "presence_config", enabled: false, reason }]);
    assert.ok(!JSON.stringify(logs).includes("aaaa") && !JSON.stringify(logs).includes(dir), "no token or path content in the log");
  }
  const ok = run({ WA_PRESENCE_TOKEN_FILE: good });
  assert.ok(ok.p && typeof ok.p.markReadTyping === "function", "control: a well-formed token builds a client");
  assert.deepEqual(ok.logs, [{ event: "presence_config", enabled: true, tokenLength: 64 }]);
});
