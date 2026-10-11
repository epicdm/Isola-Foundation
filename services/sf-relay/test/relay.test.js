import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { chatwootClient } from "../src/clients.js";
import { createRelay, verifySignature, HANDOFF_TEXT, NO_HANDOFF_TEXT, looksLikeToolMarkup, requestsHuman, claimsHandoff, decide, readEvent, holdFromRecord } from "../src/relay.js";
import { createHandler } from "../src/server.js";
import { seldonClient } from "../src/clients.js";

const SCOPE = { accountId: 3, inboxId: 16 };
const SECRET = randomBytes(16).toString("hex"); // generated per run: no secret-shaped literal in the repo
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The REAL Chatwoot 4.18 shape for a conversation the BOT owns: assignee = the bot, assignee_type AgentBot.
const BOT_OWNED = { sender: { id: 541 }, assignee: { id: 9, name: "bot", type: "agent_bot" }, assignee_type: "AgentBot" };
// ...and for an unassigned one, where `assignee` is OMITTED (not null).
const UNASSIGNED = { sender: { id: 541 }, channel: "Channel::Api" };

function msg(over = {}) {
  const { meta = BOT_OWNED, status = "pending", id = 100, content = "What does the receptionist cost?", conv = 41, ...rest } = over;
  return {
    event: "message_created", id, content, message_type: "incoming", private: false,
    sender: { type: "contact", id: 541 }, account: { id: 3 }, inbox: { id: 16 },
    conversation: { id: conv, status, meta }, ...rest,
  };
}

function rig(opts = {}) {
  const log = [];
  const posts = [];
  const calls = [];
  const turnArgs = [];
  const st = {
    chatwootStatus: "pending",
    assignedOwner: false,
    assignedTeam: null,
    turn: { ok: true, text: "It is EC$149 per month.", conversationId: "sf-1" },
    esc: { known: true, escalated: false },
    turnDelay: 0,
    ...opts,
  };
  const chatwoot = {
    getConversation: async () => {
      calls.push("get");
      const r = st.record === undefined
        ? { status: st.chatwootStatus, account_id: 3, inbox_id: 16, meta: { ...UNASSIGNED, assignee: st.assignedOwner ? { id: 5, type: "user" } : undefined, team: st.assignedTeam ? { id: st.assignedTeam } : undefined } }
        : typeof st.record === "function" ? st.record() : st.record;
      if (r instanceof Error) throw r;
      return r;
    },
    postMessage: async (id, content, { private: p }) => {
      calls.push(p ? "note" : "post");
      if (st.noteFails && p) throw new Error("note refused");
      if (st.postFails && !p) throw new Error("boom");
      posts.push({ id, content, private: p });
    },
    toggleStatus: async (id, s) => { calls.push(`status:${s}`); if (st.toggleFails) throw new Error("chatwoot said no"); st.chatwootStatus = s; if (st.nativeAssignOnOpen && s === "open") st.assignedOwner = true; },
    assignOwner: async (id, userId) => {
      calls.push(`assign:${userId}`);
      if (st.assignFails) throw new Error("assignment refused");
      st.assignedOwner = true;
    },
    assignTeam: async (id, teamId) => {
      calls.push(`assign-team:${teamId}`);
      if (st.assignFails) throw new Error("team assignment refused");
      st.assignedTeam = st.teamReadbackId ?? teamId;
    },
  };
  const seldon = {
    turn: async (a) => {
      calls.push("turn"); turnArgs.push(a);
      if (st.turnDelay) await sleep(st.turnDelay);
      if (st.turnThrows) throw new Error("sf exploded");
      return typeof st.turn === "function" ? st.turn() : st.turn;
    },
    escalation: async () => st.esc,
  };
  const relay = createRelay({ scope: SCOPE, ownerUserId: 5, escalationTeamId: opts.escalationTeamId ?? null, chatwoot, seldon, logger: (o) => log.push(o) });
  return { relay, log, posts, calls, turnArgs, st };
}

async function run(r, payload) {
  const res = r.relay.accept(payload);
  await res.done;
  return res;
}

// ---------- signature ----------
function sign(secret, ts, raw) { return "sha256=" + createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex"); }

test("signature: valid accepted; wrong secret, stale, missing and tampered body refused", () => {
  const raw = Buffer.from('{"a":1}');
  const ts = "1790000000";
  const good = { secret: SECRET, timestamp: ts, signature: sign(SECRET, ts, raw), raw, nowSec: 1790000010 };
  assert.equal(verifySignature(good), true); // POSITIVE CONTROL
  assert.equal(verifySignature({ ...good, secret: "other" }), false);
  assert.equal(verifySignature({ ...good, nowSec: 1790000000 + 301 }), false);
  assert.equal(verifySignature({ ...good, signature: undefined }), false);
  assert.equal(verifySignature({ ...good, timestamp: undefined }), false);
  assert.equal(verifySignature({ ...good, raw: Buffer.from('{"a":2}') }), false);
  assert.equal(verifySignature({ ...good, secret: "" }), false);
});

// ---------- the HTTP path (Law 20: through the route) ----------
// Every test server is closed even when an assertion fails first, so a failing run exits instead of hanging.
const openServers = new Set();
after(() => Promise.all([...openServers].map((s) => new Promise((ok) => { s.closeAllConnections?.(); s.close(ok); }))));
async function http(r, { secret = SECRET, body, ts = Math.floor(Date.now() / 1000), badSig = false }) {
  const server = createServer(createHandler({ secret: SECRET, relay: r.relay, logger: (o) => r.log.push(o) }));
  openServers.add(server);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const raw = Buffer.from(JSON.stringify(body));
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chatwoot/agent-bot`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-chatwoot-timestamp": String(ts), "x-chatwoot-signature": badSig ? "sha256=00" : sign(secret, ts, raw) },
    body: raw,
  });
  const ms = Date.now() - t0;
  const json = await res.json();
  return { status: res.status, json, ms, close: () => new Promise((ok) => server.close(ok)) };
}

test("route: a bad signature gets 401 and NOTHING else happens; a good one gets 200 (positive control)", async () => {
  const r = rig();
  const bad = await http(r, { body: msg(), badSig: true });
  assert.equal(bad.status, 401);
  await sleep(20);
  assert.deepEqual(r.calls, []);
  await bad.close();
  const good = await http(r, { body: msg() });
  assert.equal(good.status, 200);
  assert.equal(good.json.outcome, "accepted");
  await sleep(50);
  assert.ok(r.calls.includes("turn"));
  await good.close();
});

test("route: the 200 comes back fast even when the model turn is slow, and the reply still arrives after", async () => {
  const r = rig({ turnDelay: 400 });
  const x = await http(r, { body: msg() });
  assert.equal(x.status, 200);
  assert.ok(x.ms < 250, `ack took ${x.ms} ms`);
  assert.equal(r.posts.length, 0); // not yet
  await sleep(700);
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].private, false);
  await x.close();
});

// ---------- what is answered, from the signed payload ----------
test("a conversation OWNED BY THE BOT (4.18: assignee = the bot, AgentBot) is answered; so are Captain and unassigned", async () => {
  for (const meta of [BOT_OWNED, { sender: { id: 1 }, assignee: { id: 4 }, assignee_type: "Captain::Assistant" }, UNASSIGNED]) {
    const r = rig();
    await run(r, msg({ meta }));
    assert.equal(r.posts.filter((p) => !p.private).length, 1, JSON.stringify(meta));
  }
});

test("a LINGERING human assignee does not hold the conversation: status pending is answered (after Resolve Chatwoot re-pends it)", async () => {
  const people = [
    { sender: { id: 1 }, assignee: { id: 7 }, assignee_type: "User" },
    { sender: { id: 1 }, assignee: { id: 7 } },
    { sender: { id: 1 }, assignee: { id: 7 }, assignee_type: "SomethingNew" },
  ];
  for (const meta of people) {
    const r = rig({ record: { status: "pending", meta } });
    await run(r, msg({ meta }));
    assert.equal(r.posts.filter((p) => !p.private).length, 1, JSON.stringify(meta));
  }
});

test("NOT answered: status open (a person is talking), resolved, snoozed", async () => {
  for (const status of ["open", "resolved", "snoozed"]) {
    const r = rig();
    assert.equal((await run(r, msg({ status }))).outcome, "ignored");
    assert.deepEqual(r.calls, []);
  }
});

test("CONTROL (measured on 4.18): the real customer payload has NO sender.type and IS answered; typed staff/bot senders are not", async () => {
  const sender = { id: 541, name: "Customer", email: null, identifier: null, blocked: false, account: { id: 3 }, additional_attributes: {}, custom_attributes: {}, avatar: "" };
  const r = rig();
  await run(r, msg({ sender }));
  assert.equal(r.posts.filter((p) => !p.private).length, 1);
});

test("NOT answered: wrong inbox, wrong account, outgoing, private, staff or bot sender, other events", async () => {
  const cases = [
    msg({ inbox: { id: 4 } }), msg({ account: { id: 2 } }),
    msg({ message_type: "outgoing" }), msg({ private: true }),
    msg({ sender: { type: "user", id: 3 } }), msg({ sender: { type: "agent_bot", id: 9 } }), msg({ sender: undefined }),
    { ...msg(), event: "conversation_status_changed" }, { ...msg(), event: "message_updated" },
  ];
  for (const p of cases) {
    const r = rig();
    assert.equal((await run(r, p)).outcome, "ignored");
    assert.deepEqual(r.calls, []);
  }
});

// ---------- the answer path ----------
test("happy path: turn -> live ownership read -> reply, in that order; no handoff; context kept across turns", async () => {
  const r = rig();
  await run(r, msg({ id: 100 }));
  assert.deepEqual(r.calls, ["turn", "get", "post"]);
  assert.equal(r.posts[0].content, "It is EC$149 per month.");
  await run(r, msg({ id: 101, content: "and after hours?" }));
  assert.equal(r.turnArgs[0].conversationId, null);
  assert.equal(r.turnArgs[1].conversationId, "sf-1"); // the SeldonFrame conversation is reused
  assert.equal(r.turnArgs[0].sessionId, "cw3-41");
});

test("TAKEOVER DURING THE TURN: a person opens the conversation while the model runs -> the answer is discarded", async () => {
  const r = rig({ record: () => ({ status: "open", meta: UNASSIGNED }) });
  await run(r, msg());
  assert.deepEqual(r.calls, ["turn", "get"]);
  assert.equal(r.posts.length, 0);
  assert.ok(r.log.some((l) => l.event === "reply_discarded"));
});

test("HANDBACK: open is silent; after Resolve Chatwoot re-pends and the agent answers again, even with the person still assigned", async () => {
  const person = { sender: { id: 1 }, assignee: { id: 7 }, assignee_type: "User" };
  const r1 = rig({ record: { status: "open", meta: person } });
  assert.equal((await run(r1, msg({ status: "open", meta: person }))).outcome, "ignored");
  assert.equal(r1.posts.length, 0);
  const r2 = rig({ record: { status: "pending", meta: person } });
  await run(r2, msg({ status: "pending", meta: person }));
  assert.equal(r2.posts.filter((p) => !p.private).length, 1);
});

test("FAIL CLOSED: the live ownership read fails or is malformed -> nothing customer-visible; a private note and status open", async () => {
  for (const record of [new Error("HTTP 500"), null, { status: "pending" }, { status: "pending", meta: {} }, { meta: UNASSIGNED }]) {
    const r = rig({ record });
    await run(r, msg());
    assert.equal(r.posts.filter((p) => !p.private).length, 0, String(record));
    assert.ok(r.calls.includes("note") && r.calls.includes("status:open"), String(record));
  }
});

test("SeldonFrame degraded, empty, validator-failed, timeout or HTTP error -> its text is NOT sent; fixed handoff text + note + open", async () => {
  const bad = [
    { ok: false, reason: "llm_error", conversationId: "x" }, { ok: false, reason: "empty_reply" },
    { ok: false, reason: "validator_failed" }, { ok: false, reason: "timeout" }, { ok: false, reason: "http_500" },
  ];
  for (const turn of bad) {
    const r = rig({ turn });
    await run(r, msg());
    const customer = r.posts.filter((p) => !p.private);
    assert.equal(customer.length, 1);
    assert.equal(customer[0].content, HANDOFF_TEXT);
    assert.ok(r.calls.includes("status:open"));
    assert.deepEqual(r.calls, ["turn", "note", "status:open", "assign:5", "get", "post"]);
  }
});

test("the relay itself throwing mid-turn still ends in a handoff (never silence)", async () => {
  const r = rig({ turnThrows: true });
  await run(r, msg());
  assert.ok(r.calls.includes("status:open"));
  assert.equal(r.posts.filter((p) => !p.private)[0].content, HANDOFF_TEXT);
});

test("agent escalation: note, Open and owner assignment readback succeed FIRST, then the promise is sent", async () => {
  const r = rig({ esc: { known: true, escalated: true, reason: "wants a callback" } });
  await run(r, msg());
  const customer = r.posts.filter((p) => !p.private);
  assert.equal(customer.length, 1);
  assert.equal(customer[0].content, "It is EC$149 per month.");
  assert.deepEqual(r.calls, ["turn", "get", "note", "status:open", "assign:5", "get", "post"]);
  assert.match(r.posts.find((p) => p.private).content, /wants a callback/);
});

test("agent escalation cannot promise a person when owner assignment fails", async () => {
  const r = rig({ esc: { known: true, escalated: true, reason: "needs help" }, assignFails: true });
  await run(r, msg());
  assert.equal(r.posts.filter((p) => !p.private)[0].content, NO_HANDOFF_TEXT);
  assert.ok(r.log.some((l) => l.event === "chatwoot_write_failed" && l.step === "handoff_assign_owner"));
});

test("native Chatwoot assignment on Open is accepted only after the same owner is read back", async () => {
  const r = rig({ esc: { known: true, escalated: true, reason: "needs help" }, nativeAssignOnOpen: true, assignFails: true });
  await run(r, msg());
  assert.equal(r.posts.filter((p) => !p.private)[0].content, r.st.turn.text);
  assert.ok(r.calls.includes("assign:5"));
  assert.ok(r.log.some((l) => l.event === "chatwoot_write_failed" && l.step === "handoff_assign_owner"));
});

test("one synthetic conversation: escalation, owner reply, AI silence, Resolve handback", async () => {
  const r = rig({ esc: { known: true, escalated: true, reason: "human requested" } });
  await run(r, msg({ conv: 72, id: 100 }));
  assert.equal(r.st.chatwootStatus, "open");
  assert.equal(r.st.assignedOwner, true);
  assert.equal(r.posts.filter((p) => p.private).length, 1);

  await run(r, msg({ conv: 72, id: 101, status: "open", message_type: "outgoing", sender: { type: "user", id: 5 } }));
  await run(r, msg({ conv: 72, id: 102, status: "open", content: "Are you there?" }));
  assert.equal(r.turnArgs.length, 1);
  assert.equal(r.posts.filter((p) => !p.private).length, 1);

  r.st.chatwootStatus = "pending"; // Chatwoot re-pends after Resolve and the next customer message.
  r.st.esc = { known: true, escalated: false };
  await run(r, msg({ conv: 72, id: 103, status: "pending", content: "Thanks, I am back." }));
  assert.equal(r.turnArgs.length, 2);
  assert.equal(r.posts.filter((p) => !p.private).length, 2);
  assert.equal(r.turnArgs[1].conversationId, "sf-1");
});

test("a failed context note still opens and assigns for recovery, but does not send the agent's promise", async () => {
  const r = rig({ esc: { known: true, escalated: true, reason: "needs help" }, noteFails: true });
  await run(r, msg());
  assert.equal(r.st.chatwootStatus, "open");
  assert.equal(r.st.assignedOwner, true);
  assert.equal(r.posts.filter((p) => !p.private)[0].content, NO_HANDOFF_TEXT);
});

test("a person promise is routed through the configured team and verified before customer confirmation", async () => {
  for (const esc of [{ known: false }, { known: true, escalated: false }]) {
    const r = rig({ escalationTeamId: 27, esc, turn: { ok: true, text: "I'll bring in a teammate to help with this.", conversationId: "sf-1" } });
    await run(r, msg());
    assert.ok(r.calls.includes("note") && r.calls.includes("status:open") && r.calls.includes("assign-team:27"));
    assert.equal(r.st.chatwootStatus, "open");
    assert.equal(r.st.assignedTeam, 27);
    assert.deepEqual(r.posts.filter((p) => !p.private).map((p) => p.content), [HANDOFF_TEXT]);
    assert.ok(r.log.some((l) => l.event === "unbacked_handoff_language"));
  }
});

test("configured escalation team is assigned and read back before the human promise is sent", async () => {
  const r = rig({ escalationTeamId: 27, esc: { known: true, escalated: true, reason: "needs a person" } });
  await run(r, msg());
  assert.deepEqual(r.calls, ["turn", "get", "note", "status:open", "assign-team:27", "get", "post"]);
  assert.equal(r.st.assignedTeam, 27);
  assert.equal(r.posts.filter((p) => !p.private)[0].content, r.st.turn.text);
  assert.ok(r.log.some((l) => l.event === "handoff" && l.assignmentTarget === "team" && l.chatwootHandoffConfirmed === true));
});

test("configured team mismatch or failed note suppresses the agent's human promise", async () => {
  const mismatch = rig({ escalationTeamId: 27, teamReadbackId: 28, esc: { known: true, escalated: true, reason: "needs a person" } });
  await run(mismatch, msg());
  assert.equal(mismatch.posts.filter((p) => !p.private)[0].content, NO_HANDOFF_TEXT);
  assert.ok(mismatch.log.some((l) => l.event === "team_assignment_failed" && l.reason === "readback_mismatch"));

  const noteFailure = rig({ escalationTeamId: 27, noteFails: true, esc: { known: true, escalated: true, reason: "needs a person" } });
  await run(noteFailure, msg());
  assert.equal(noteFailure.posts.filter((p) => !p.private)[0].content, NO_HANDOFF_TEXT);
  assert.ok(noteFailure.calls.includes("assign-team:27"));
});

test("an ordinary offer stays pending; an explicit customer request invokes handoff before inference", async () => {
  const offer = rig({ esc: { known: false }, turn: { ok: true, text: "Would you like to speak to someone?", conversationId: "sf-1" } });
  await run(offer, msg());
  assert.deepEqual(offer.posts.filter((p) => !p.private).map((p) => p.content), ["Would you like to speak to someone?"]);
  assert.equal(offer.calls.includes("status:open"), false);

  const request = rig({ escalationTeamId: 27 });
  await run(request, msg({ content: "Could I please speak to a person?" }));
  assert.deepEqual(request.calls, ["note", "status:open", "assign-team:27", "get", "post"]);
  assert.equal(request.posts.filter((p) => !p.private)[0].content, HANDOFF_TEXT);
});

test("request and claim classifiers distinguish customer intent, completed handoff and ordinary offers", () => {
  for (const text of ["Could I talk to a real person?", "I need an agent", "Please transfer me to a representative"]) assert.equal(requestsHuman(text), true, text);
  for (const text of ["We've connected you to a teammate.", "Your request has been escalated.", "I'll bring in a teammate to help.", "Someone will get back to you shortly."]) assert.equal(claimsHandoff(text), true, text);
  for (const text of ["Would you like to speak to someone?", "I can connect you with a representative if you prefer.", "A person can review the service hours listed above.", "Our staff hours are Monday to Friday."]) {
    assert.equal(requestsHuman(text), false, text);
    assert.equal(claimsHandoff(text), false, text);
  }
});

test("Lane A phrase battery: offers stay normal, every promised handoff invokes takeover, customer requests stay distinct", () => {
  const offers = [
    "Would you like to speak to someone?",
    "Would you like me to bring someone in to go over it with you? If so, just share your name and number.",
    "A colleague can walk you through exactly what it does for your business and confirm current pricing.",
    "If you'd like, I can connect you with a teammate.",
    "Do you want me to pass this to a colleague?",
    "I can pass this to a colleague if you want.",
    "Happy to put you in touch with our team if that would help.",
    "Our team can help with installation. Would you like to talk to a person?",
    "Want me to get someone to call you?",
    "You can reach our staff Monday to Friday, 9 to 5.",
    "Our staff hours are Monday to Friday.",
    "The app supports calling and messaging.",
  ];
  const promises = [
    "I'll bring in a teammate to help with this.",
    "A staff member will reply here soon.",
    "Someone will get back to you shortly.",
    "Someone from our team will contact you shortly.",
    "A member of our team will reach out to you today.",
    "Our team will follow up with you.",
    "I'll have someone call you back.",
    "I'll have a colleague contact you.",
    "Let me transfer you to a human.",
    "Let me connect you with a teammate.",
    "I'm connecting you with a teammate now.",
    "I've transferred you to a teammate.",
    "I have passed this on to our team.",
    "Your request has been escalated to our team.",
    "A human is joining this conversation.",
    "I will ask a colleague to contact you.",
    "I'm going to get a person to help you.",
    "I'll pass this to a colleague.",
    "Thanks, John. I've noted your number and someone will call you.",
    "One of our specialists will be in touch.",
  ];
  const requests = [
    "Can I speak to someone?", "I'd like to speak with a person, please.",
    "Connect me with a human.", "I want to talk to a real person", "human please",
    "Can I talk to an agent", "transfer me to a representative",
    "I need to speak to somebody about my bill", "Please get me a person",
    "can i chat with someone from sales?",
  ];
  const normalCustomerMessages = [
    "Hi, I'm interested in a business phone line.", "What does the receptionist cost?",
    "How do I set up my line?", "I need someone to set up my business line",
    "Do you have an agent app for WhatsApp?", "Is there a person-to-person plan?",
    "my phone agent stopped working", "What are your hours?",
    "Can I speak Spanish with the assistant?", "Please send me the price list.",
  ];
  for (const text of offers) {
    assert.equal(claimsHandoff(text), false, `offer incorrectly classified: ${text}`);
    assert.equal(requestsHuman(text), false, `offer incorrectly classified as request: ${text}`);
  }
  for (const text of promises) assert.equal(claimsHandoff(text), true, `missed takeover promise: ${text}`);
  for (const text of requests) assert.equal(requestsHuman(text), true, `missed customer request: ${text}`);
  for (const text of normalCustomerMessages) assert.equal(requestsHuman(text), false, `normal query incorrectly escalated: ${text}`);
});

test("agent escalation cannot promise a person when assignment readback has the wrong owner or scope", async () => {
  for (const record of [
    { status: "open", account_id: 3, inbox_id: 16, meta: { sender: { id: 541 }, assignee: { id: 7 } } },
    { status: "open", account_id: 2, inbox_id: 16, meta: { sender: { id: 541 }, assignee: { id: 5 } } },
  ]) {
    const r = rig({ esc: { known: true, escalated: true, reason: "needs help" }, record: () => r.st.chatwootStatus === "pending" ? { status: "pending", meta: UNASSIGNED } : record });
    await run(r, msg());
    assert.equal(r.posts.filter((p) => !p.private)[0].content, NO_HANDOFF_TEXT);
    assert.ok(r.log.some((l) => l.event === "owner_assignment_failed" && l.reason === "readback_mismatch"));
  }
});

test("Chatwoot assignment uses assignee_id and rejects a failed API response", async () => {
  const writes = [];
  const client = chatwootClient({
    baseUrl: "https://chatwoot.example.invalid", accountId: 3, token: "fixture",
    fetchImpl: async (url, init) => {
      writes.push({ url, body: JSON.parse(init.body) });
      return new Response("{}", { status: writes.length === 1 ? 200 : 403 });
    },
  });
  await client.assignOwner(72, 5);
  assert.equal(writes[0].url, "https://chatwoot.example.invalid/api/v1/accounts/3/conversations/72/assignments");
  assert.deepEqual(writes[0].body, { assignee_id: 5 });
  await assert.rejects(client.assignOwner(72, 5), /HTTP 403/);
});

test("Chatwoot team assignment uses team_id and rejects a failed API response", async () => {
  const writes = [];
  const client = chatwootClient({
    baseUrl: "https://chatwoot.example.invalid", accountId: 2, token: "fixture",
    fetchImpl: async (url, init) => {
      writes.push({ url, body: JSON.parse(init.body) });
      return new Response("{}", { status: writes.length === 1 ? 200 : 403 });
    },
  });
  await client.assignTeam(72, 27);
  assert.equal(writes[0].url, "https://chatwoot.example.invalid/api/v1/accounts/2/conversations/72/assignments");
  assert.deepEqual(writes[0].body, { team_id: 27 });
  await assert.rejects(client.assignTeam(72, 27), /HTTP 403/);
});

test("agent escalation where Chatwoot REFUSES the status change: the promise is NOT sent; the customer gets a text that claims nothing", async () => {
  const r = rig({ esc: { known: true, escalated: true, reason: "x" }, toggleFails: true });
  await run(r, msg());
  const customer = r.posts.filter((p) => !p.private);
  assert.equal(customer.length, 1);
  assert.equal(customer[0].content, NO_HANDOFF_TEXT);
  assert.ok(r.log.some((l) => l.outcome === "agent_requested_person_FAILED"));
});

test("escalation UNKNOWN (no read-back credential) is logged, not guessed", async () => {
  const r = rig({ esc: { known: false } });
  await run(r, msg());
  assert.ok(r.log.some((l) => l.event === "escalation_unknown"));
  assert.equal(r.calls.includes("status:open"), false);
});

test("a reply that cannot be posted ends in note + open", async () => {
  const r = rig({ postFails: true });
  await run(r, msg());
  assert.ok(r.calls.includes("status:open"));
});

test("attachment-only message -> handoff with the fixed text; the model is never called", async () => {
  const r = rig();
  await run(r, msg({ content: "", attachments: [{ file_type: "image" }] }));
  assert.equal(r.calls.includes("turn"), false);
  assert.equal(r.posts.filter((p) => !p.private)[0].content, HANDOFF_TEXT);
  assert.equal((await run(rig(), msg({ content: "   " }))).outcome, "ignored");
});

// ---------- dedup and ordering ----------
test("the same message id delivered twice (retry, replay) produces ONE turn and ONE reply", async () => {
  const r = rig({ turnDelay: 30 });
  const a = r.relay.accept(msg({ id: 200 }));
  const b = r.relay.accept(msg({ id: 200 })); // while the first is still running
  await Promise.all([a.done, b.done]);
  const c = r.relay.accept(msg({ id: 200 })); // after it finished
  await c.done;
  assert.equal(r.calls.filter((x) => x === "turn").length, 1);
  assert.equal(r.posts.length, 1);
  assert.equal(b.reason, "duplicate");
  assert.equal(c.reason, "duplicate");
});

test("two messages in ONE conversation run one at a time, in order; two conversations run in parallel", async () => {
  const r = rig({ turnDelay: 60 });
  const t0 = Date.now();
  const a = r.relay.accept(msg({ id: 300, conv: 41 }));
  const b = r.relay.accept(msg({ id: 301, conv: 41 }));
  await Promise.all([a.done, b.done]);
  assert.ok(Date.now() - t0 >= 110, "same conversation must serialise");
  assert.deepEqual(r.calls.filter((x) => x === "turn" || x === "post"), ["turn", "post", "turn", "post"]);
  const r2 = rig({ turnDelay: 60 });
  const t1 = Date.now();
  await Promise.all([r2.relay.accept(msg({ id: 400, conv: 41 })).done, r2.relay.accept(msg({ id: 401, conv: 42 })).done]);
  assert.ok(Date.now() - t1 < 110, "different conversations must not wait for each other");
});

// ---------- pure helpers ----------
test("holdFromRecord: the real unassigned shape (assignee omitted) is NOT unreadable; malformed shapes are", () => {
  assert.equal(holdFromRecord({ status: "pending", meta: UNASSIGNED }), null);
  assert.equal(holdFromRecord({ status: "pending", meta: BOT_OWNED }), null);
  assert.equal(holdFromRecord({ status: "open", meta: UNASSIGNED }), "status_not_pending");
  assert.equal(holdFromRecord({ status: "pending", meta: { sender: { id: 1 }, assignee: { id: 7 }, assignee_type: "User" } }), null);
  for (const bad of [null, {}, { status: "" }, { status: "pending" }, { status: "pending", meta: {} }, { status: "pending", meta: { assignee: 7 } }]) {
    assert.throws(() => holdFromRecord(bad), undefined, JSON.stringify(bad));
  }
});

test("readEvent never throws on garbage and decide ignores it", () => {
  for (const g of [null, undefined, 5, "x", [], {}, { event: "message_created" }]) {
    assert.equal(decide(readEvent(g), SCOPE).act, "ignore");
  }
});

// ---------- the SeldonFrame client against a fake HTTP service ----------
test("seldon client: a take_message call counts as a person request (reason carries name, number, message); a plain turn does not", async () => {
  const mk = (toolCalls) => seldonClient({ baseUrl: "http://sf.test", slug: "s", workspaceId: "w", token: "t",
    fetchImpl: async () => new Response(JSON.stringify({ turns: [{ role: "assistant", toolCalls }] }), { status: 200 }) });
  const yes = await mk([{ name: "take_message", input: { caller_name: "Maria", caller_phone: "+1 767 555 0142", message: "wants a call" } }]).escalation("c");
  assert.equal(yes.escalated, true);
  assert.match(yes.reason, /Maria.*555 0142.*wants a call/);
  assert.deepEqual(await mk([{ name: "provide_faq_answer", input: {} }]).escalation("c"), { known: true, escalated: false });
});

test("seldon client: maps healthy, degraded, validator-failed, empty and non-200 replies; escalation read-back", async () => {
  const replies = [
    [200, { conversation_id: "c1", message: "Hello", validators_critical_failed: false }],
    [200, { conversation_id: "c1", message: "I'm having a hiccup", degraded: true, reason: "llm_error" }],
    [200, { conversation_id: "c1", message: "x", validators_critical_failed: true }],
    [200, { conversation_id: "c1", message: "   " }],
    [500, {}],
  ];
  let i = 0;
  const sf = seldonClient({ baseUrl: "http://sf.test", slug: "s", workspaceId: "w", token: "t", fetchImpl: async (url) => {
    if (String(url).endsWith("/api/v1/agents")) {
      return new Response(JSON.stringify({ turns: [
        { role: "user" }, { role: "assistant", toolCalls: [{ name: "escalate_to_human", input: { reason: "wants a person" } }] },
      ] }), { status: 200 });
    }
    const [code, body] = replies[i++];
    return new Response(JSON.stringify(body), { status: code });
  } });
  assert.deepEqual(await sf.turn({ message: "m", sessionId: "s" }), { ok: true, text: "Hello", conversationId: "c1" });
  assert.equal((await sf.turn({ message: "m", sessionId: "s" })).reason, "llm_error");
  assert.equal((await sf.turn({ message: "m", sessionId: "s" })).reason, "validator_failed");
  assert.equal((await sf.turn({ message: "m", sessionId: "s" })).reason, "empty_reply");
  assert.equal((await sf.turn({ message: "m", sessionId: "s" })).reason, "http_500");
  assert.deepEqual(await sf.escalation("c1"), { known: true, escalated: true, reason: "wants a person" });
  assert.deepEqual(await seldonClient({ baseUrl: "http://x", slug: "s" }).escalation("c1"), { known: false }); // no credential
});

test("chatwoot read retries ONCE after a timeout, never after an HTTP status; a second timeout still fails (control)", async () => {
  const ok = () => new Response(JSON.stringify({ status: "pending", meta: { sender: { id: 1 } } }), { status: 200 });
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  let n = 0;
  const once = chatwootClient({ baseUrl: "http://cw.test", accountId: 3, token: "t", fetchImpl: async () => { if (n++ === 0) throw timeout(); return ok(); } });
  assert.equal((await once.getConversation(1)).status, "pending");
  assert.equal(n, 2);
  n = 0;
  const twice = chatwootClient({ baseUrl: "http://cw.test", accountId: 3, token: "t", fetchImpl: async () => { n++; throw timeout(); } });
  await assert.rejects(() => twice.getConversation(1));
  assert.equal(n, 2);
  n = 0;
  const http500 = chatwootClient({ baseUrl: "http://cw.test", accountId: 3, token: "t", fetchImpl: async () => { n++; return new Response("{}", { status: 500 }); } });
  await assert.rejects(() => http500.getConversation(1));
  assert.equal(n, 1);
});

test("a reply that is raw tool-call markup is NEVER sent; fixed handoff text + note + open; ordinary replies are (control)", async () => {
  const bar = String.fromCharCode(0xff5c); // the model's full-width bar, built so no odd glyph sits in the source
  const leaked = `<${bar}${bar}DSML${bar}${bar} calls>\n<${bar}${bar}DSML${bar}${bar} invoke name="escalate_to_human">`;
  for (const text of [leaked, "<invoke name=\"x\">", "[ask_owner: something]"]) {
    assert.equal(looksLikeToolMarkup(text), true, text);
    const r = rig({ turn: { ok: true, text, conversationId: "sf-1" } });
    await run(r, msg());
    const customer = r.posts.filter((p) => !p.private).map((p) => p.content);
    assert.deepEqual(customer, [HANDOFF_TEXT], text);
    assert.ok(r.calls.includes("note") && r.calls.includes("status:open"));
  }
  assert.equal(looksLikeToolMarkup("It is EC$149 per month. Sunday is closed."), false);
  const ok = rig();
  await run(ok, msg());
  assert.equal(ok.posts.filter((p) => !p.private)[0].content, "It is EC$149 per month.");
});

test("tool markup gets ONE retry in a fresh SeldonFrame conversation: clean second answer is sent; markup twice is withheld (control)", async () => {
  const bar = String.fromCharCode(0xff5c);
  const bad = { ok: true, text: `<${bar}${bar}DSML${bar}${bar} invoke name="x">`, conversationId: "sf-old" };
  const good = { ok: true, text: "We are closed on Sundays.", conversationId: "sf-new" };
  let n = 0;
  const r1 = rig({ turn: () => (n++ === 0 ? bad : good) });
  await run(r1, msg());
  assert.deepEqual(r1.posts.filter((p) => !p.private).map((p) => p.content), ["We are closed on Sundays."]);
  assert.equal(r1.turnArgs.length, 2);
  assert.equal(r1.turnArgs[1].conversationId, null);
  const r2 = rig({ turn: bad });
  await run(r2, msg());
  assert.equal(r2.turnArgs.length, 2);
  assert.deepEqual(r2.posts.filter((p) => !p.private).map((p) => p.content), [HANDOFF_TEXT]);
});
