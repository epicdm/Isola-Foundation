// Option A (2026-10-19): the PL concierge assertion/context scope is an explicit setting, PL_CONCIERGE_INBOX_ID, default 11.
// The boot check, the relay's construction check and the context minter all key on that ONE value, and the relay's own
// CHATWOOT_INBOX_ID must equal it. Every refusal below has a positive twin in the same file (a refusal that also refuses the
// good case proves nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mintRelayContext, parsePlConciergeInboxId, PL_CONCIERGE_DEFAULT_INBOX_ID, verifyRelayContext } from "../src/pl-concierge-assertion.js";
import { createRelay } from "../src/relay.js";
import { seldonClient } from "../src/clients.js";
import { validatePlAssertionConfig } from "../src/server.js";

const KEY = "synthetic-pl-assertion-key-material-32-bytes-minimum";
const PROD_CTX_KEY = "synthetic-production-context-key-material-32-bytes";
const TEST_CTX_KEY = "synthetic-test-route-context-key-material-32-bytes";
const IDENTITY = { workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "pl-staging-test-agent" };
const TEST_PNID = "1100000000000018";
const PROD_PNID = "1100000000000011";
const NOW = 1_797_000_000_000;

// ── one fixture, parameterised by the inbox the deployment is scoped to and the inbox the traffic comes from ──
function fixture({ scopeInbox, plInbox, trafficInbox = scopeInbox, recordInbox = trafficInbox, contactInboxes = [trafficInbox], ctxKid = "ctxtest1", ctxKey = TEST_CTX_KEY, pnid = TEST_PNID }) {
  const posted = [];
  const contact = { payload: { id: 541, phone_number: "+17670000000",
    contact_inboxes: contactInboxes.map((id) => ({ source_id: `176799900${String(id).padStart(2, "0")}`, inbox: { id, channel_type: "Channel::Whatsapp", provider: "whatsapp_cloud" } })) } };
  const row = { id: 41, account_id: 2, inbox_id: recordInbox, status: "pending", custom_attributes: {}, meta: { channel: "Channel::Whatsapp", sender: { id: 541 }, assignee: { id: 16 } } };
  const event = {
    event: "message_created", id: 7001, content: "What stage is my line at?", message_type: "incoming", private: false,
    sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: trafficInbox },
    conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } },
  };
  const chatwoot = {
    async getConversation() { return structuredClone(row); },
    async getContact() { return structuredClone(contact); },
    async updateConversationCustomAttributes(id, values) { Object.assign(row.custom_attributes, values); return { custom_attributes: structuredClone(row.custom_attributes) }; },
    async postMessage(id, content, opts) { posted.push({ content, private: opts.private }); },
    async toggleStatus() {}, async assignOwner() {}, async assignTeam() {},
  };
  // The turn goes through the REAL seldonClient, so the test sees the bytes on the wire (the x-isola-relay-context header).
  const requests = [];
  const wire = seldonClient({ baseUrl: "http://gateway.test", slug: IDENTITY.agentSlug, fetchImpl: async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ message: "Your line is waiting for the setup link to be opened.", conversation_id: "sf-conv", conversation_capability: "visitor-bound-capability" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const seldon = {
    turnInputs: [], requests,
    async turn(input) { seldon.turnInputs.push(input); return wire.turn(input); },
    async escalation() { return { known: true, escalated: false }; },
    async inspectTurn() { return { known: true, currentTurnVerified: true, escalated: false, toolCalls: [], toolResults: [] }; },
  };
  const relay = createRelay({
    scope: { accountId: 2, inboxId: scopeInbox, ...IDENTITY }, ownerUserId: 16, escalationTeamId: 8, chatwoot, seldon,
    requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32",
    plConcierge: { key: KEY, kid: "uat1", bridgeKey: ctxKey, bridgeKid: ctxKid, phoneNumberId: pnid, ...(plInbox === undefined ? {} : { inboxId: plInbox }) },
    now: () => NOW,
  });
  return { relay, event, posted, seldon };
}
async function run(f) { await f.relay.accept(f.event).done; }
const expectedFor = (inboxId, input, claims) => ({ accountId: 2, inboxId, ...IDENTITY, sessionId: input.sessionId, uplinkConversationId: null,
  chatwootConversationId: "41", chatwootMessageId: "7001", messageSha256: claims.messageSha256 });
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
const plClaimsOf = (assertion) => JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));

// ── 1. default production behaviour ──
test("default: unset PL_CONCIERGE_INBOX_ID is inbox 11; the production-shaped relay mints an inbox-11 context exactly as before", async () => {
  assert.equal(PL_CONCIERGE_DEFAULT_INBOX_ID, 11);
  for (const raw of [undefined, null, ""]) assert.equal(parsePlConciergeInboxId(raw), 11);
  const f = fixture({ scopeInbox: 11, plInbox: undefined, ctxKid: "ctx1", ctxKey: PROD_CTX_KEY, pnid: PROD_PNID });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 1);
  const input = f.seldon.turnInputs[0];
  assert.equal(typeof input.relayContext, "string");
  assert.deepEqual(input.channelMeta, { source: "chatwoot", account_id: 2, inbox_id: 11, conversation_id: 41 });
  const claims = claimsOf(input.relayContext);
  const v = verifyRelayContext(input.relayContext, { keys: { ctx1: PROD_CTX_KEY }, nowSec: NOW / 1000, expected: expectedFor(11, input, claims) });
  assert.equal(v.ok, true, v.reason);
  assert.equal(plClaimsOf(claims.plAssertion).pnid, PROD_PNID);
  assert.equal(plClaimsOf(claims.plAssertion).wa_id, "17679990011");
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), ["Your line is waiting for the setup link to be opened."]);
});

test("default: an explicit inboxId 11 behaves exactly like the unset default (same claim keys and bindings)", async () => {
  const a = fixture({ scopeInbox: 11, plInbox: undefined, ctxKid: "ctx1", ctxKey: PROD_CTX_KEY, pnid: PROD_PNID });
  const b = fixture({ scopeInbox: 11, plInbox: 11, ctxKid: "ctx1", ctxKey: PROD_CTX_KEY, pnid: PROD_PNID });
  await run(a); await run(b);
  // Only the random nonces differ (the clock is fixed): every other context claim AND every PL assertion claim is identical.
  const ca = claimsOf(a.seldon.turnInputs[0].relayContext), cb = claimsOf(b.seldon.turnInputs[0].relayContext);
  const strip = (c) => { const { nonce, plAssertion, ...rest } = c; return rest; };
  const stripPl = (c) => { const { nonce, ...rest } = plClaimsOf(c.plAssertion); return rest; };
  assert.deepEqual(strip(cb), strip(ca));
  assert.deepEqual(stripPl(cb), stripPl(ca));
  assert.deepEqual(Object.keys(cb).sort(), Object.keys(ca).sort());
  assert.deepEqual(Object.keys(plClaimsOf(cb.plAssertion)).sort(), Object.keys(plClaimsOf(ca.plAssertion)).sort());
  assert.equal(a.seldon.requests[0].headers["x-isola-relay-context"], a.seldon.turnInputs[0].relayContext);
});

test("default boot check: production-shaped config passes; the old inbox-12 refusal still names inbox 11", () => {
  const prod = { enabled: true, accountId: 2, inboxId: 11, key: KEY, kid: "pl2", bridgeKey: PROD_CTX_KEY, bridgeKid: "ctx1", phoneNumberId: PROD_PNID, sfToken: "synthetic-readback-token", identity: IDENTITY, requireCapability: true };
  assert.doesNotThrow(() => validatePlAssertionConfig(prod));
  assert.throws(() => validatePlAssertionConfig({ ...prod, inboxId: 12 }), /scoped_to_account2_inbox11$/);
});

// ── 2. inbox-18 operation (the PATH: webhook -> identity -> assertion -> context -> turn header) ──
test("inbox 18: with PL_CONCIERGE_INBOX_ID=18 the relay mints a context bound to inbox 18 under the test key, and the turn carries it", async () => {
  const f = fixture({ scopeInbox: 18, plInbox: 18 });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 1);
  const input = f.seldon.turnInputs[0];
  assert.deepEqual(input.channelMeta, { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41 });
  // On the wire: exactly one turn request, carrying the context in the x-isola-relay-context HEADER (not channel_meta).
  assert.equal(f.seldon.requests.length, 1);
  const req = f.seldon.requests[0];
  assert.equal(req.url, `http://gateway.test/api/v1/public/agent/${IDENTITY.agentSlug}/turn`);
  assert.equal(req.headers["x-isola-relay-context"], input.relayContext);
  assert.deepEqual(req.body.channel_meta, { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41 });
  assert.equal(JSON.stringify(req.body).includes(input.relayContext), false);
  const claims = claimsOf(req.headers["x-isola-relay-context"]);
  assert.equal(claims.kid, "ctxtest1");
  assert.equal(claims.inboxId, 18);
  const ok = verifyRelayContext(input.relayContext, { keys: { ctxtest1: TEST_CTX_KEY }, nowSec: NOW / 1000, expected: expectedFor(18, input, claims) });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(plClaimsOf(claims.plAssertion).pnid, TEST_PNID);
  // The test context never verifies where production keys or production bindings are expected.
  assert.deepEqual(verifyRelayContext(input.relayContext, { keys: { ctx1: PROD_CTX_KEY }, nowSec: NOW / 1000, expected: expectedFor(18, input, claims) }), { ok: false, reason: "unknown_kid" });
  assert.deepEqual(verifyRelayContext(input.relayContext, { keys: { ctxtest1: TEST_CTX_KEY }, nowSec: NOW / 1000, expected: expectedFor(11, input, claims) }), { ok: false, reason: "binding_mismatch:inboxId" });
});

test("inbox 18: a contact who is ALSO an inbox-11 customer resolves to the inbox-18 WhatsApp source only", async () => {
  const f = fixture({ scopeInbox: 18, plInbox: 18, contactInboxes: [11, 18] });
  await run(f);
  const claims = claimsOf(f.seldon.turnInputs[0].relayContext);
  assert.equal(plClaimsOf(claims.plAssertion).wa_id, "17679990018");
  // CONTROL: the same two-inbox contact on the inbox-11 relay resolves to the inbox-11 source.
  const c = fixture({ scopeInbox: 11, plInbox: undefined, contactInboxes: [11, 18], ctxKid: "ctx1", ctxKey: PROD_CTX_KEY, pnid: PROD_PNID });
  await run(c);
  assert.equal(plClaimsOf(claimsOf(c.seldon.turnInputs[0].relayContext).plAssertion).wa_id, "17679990011");
});

// ── 3. foreign-inbox refusal ──
test("foreign inbox: the inbox-18 relay ignores inbox-11 traffic (no turn, no post); CONTROL inbox-18 traffic is answered", async () => {
  const f = fixture({ scopeInbox: 18, plInbox: 18, trafficInbox: 11 });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 0);
  assert.equal(f.posted.length, 0);
  const c = fixture({ scopeInbox: 18, plInbox: 18 });
  await run(c);
  assert.equal(c.seldon.turnInputs.length, 1);
});

test("foreign inbox: a webhook claiming inbox 18 whose live Chatwoot record is inbox 11 never reaches the agent", async () => {
  const f = fixture({ scopeInbox: 18, plInbox: 18, recordInbox: 11 });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 0);
});

test("foreign inbox: an inbox-18 contact with no inbox-18 WhatsApp source gets no assertion and no context", async () => {
  const f = fixture({ scopeInbox: 18, plInbox: 18, contactInboxes: [11] });
  await run(f);
  for (const input of f.seldon.turnInputs) assert.equal(input.relayContext ?? null, null);
  // CONTROL in the same harness: the inbox-18 source present -> a context is sent.
  const c = fixture({ scopeInbox: 18, plInbox: 18, contactInboxes: [18] });
  await run(c);
  assert.equal(typeof c.seldon.turnInputs[0].relayContext, "string");
});

test("foreign inbox: the minter refuses any inbox other than the allowed one, in both directions", () => {
  const base = { key: TEST_CTX_KEY, kid: "ctxtest1", accountId: 2, ...IDENTITY, sessionId: "cw-chatwoot-2-41", chatwootConversationId: "41", chatwootMessageId: "7001", message: "hi", plAssertion: "v1.x.y", nowSec: 1 };
  assert.throws(() => mintRelayContext({ ...base, inboxId: 11, allowedInboxId: 18 }), /relay_context_scope_invalid/);
  assert.throws(() => mintRelayContext({ ...base, inboxId: 18 }), /relay_context_scope_invalid/); // default allowed = 11
  assert.throws(() => mintRelayContext({ ...base, accountId: 3, inboxId: 18, allowedInboxId: 18 }), /relay_context_scope_invalid/);
  for (const bad of [0, -18, 18.5, "18", null]) assert.throws(() => mintRelayContext({ ...base, inboxId: 18, allowedInboxId: bad }), /relay_context_scope_invalid/, String(bad));
  // CONTROLS
  assert.equal(typeof mintRelayContext({ ...base, inboxId: 18, allowedInboxId: 18 }), "string");
  assert.equal(typeof mintRelayContext({ ...base, inboxId: 11 }), "string");
});

test("multi-gate: boot, construction and minter key on the SAME value - a mismatch fails at each gate; CONTROL the matched pair passes all three", () => {
  const cfg = { enabled: true, accountId: 2, key: KEY, kid: "uat1", bridgeKey: TEST_CTX_KEY, bridgeKid: "ctxtest1", phoneNumberId: TEST_PNID, sfToken: "synthetic-readback-token", identity: IDENTITY, requireCapability: true };
  // The two field names are genuinely distinct inputs (CHATWOOT_INBOX_ID -> inboxId, PL_CONCIERGE_INBOX_ID -> allowedInboxId).
  assert.throws(() => validatePlAssertionConfig({ ...cfg, inboxId: 18 }), /scoped_to_account2_inbox11$/); // allowed unset -> 11
  assert.throws(() => validatePlAssertionConfig({ ...cfg, inboxId: 11, allowedInboxId: 18 }), /scoped_to_account2_inbox18$/);
  assert.doesNotThrow(() => validatePlAssertionConfig({ ...cfg, inboxId: 18, allowedInboxId: 18 }));
  assert.throws(() => fixture({ scopeInbox: 18, plInbox: undefined }), /pl_concierge_assertion_configuration_incomplete/);
  assert.throws(() => fixture({ scopeInbox: 11, plInbox: 18 }), /pl_concierge_assertion_configuration_incomplete/);
  assert.throws(() => fixture({ scopeInbox: 18, plInbox: 0 }), /pl_concierge_assertion_configuration_incomplete/);
  assert.doesNotThrow(() => fixture({ scopeInbox: 18, plInbox: 18 }));
});

// ── 4. wrong identity ──
test("wrong identity: a non-UUID agent id, short workspace id or bad slug refuses to boot; CONTROL the agreed UUID binding boots", () => {
  const cfg = { enabled: true, accountId: 2, inboxId: 18, allowedInboxId: 18, key: KEY, kid: "uat1", bridgeKey: TEST_CTX_KEY, bridgeKid: "ctxtest1", phoneNumberId: TEST_PNID, sfToken: "synthetic-readback-token", requireCapability: true };
  for (const identity of [
    { ...IDENTITY, agentId: "clawith-pl-candidate" },
    { ...IDENTITY, agentId: "4c47c17f-f26a-06a7-a2e4-aa6f58a305b6" },
    { ...IDENTITY, workspaceId: null },
    { ...IDENTITY, workspaceId: "short" },
    { ...IDENTITY, agentSlug: "" },
    { ...IDENTITY, agentSlug: "x".repeat(129) },
    undefined,
  ]) assert.throws(() => validatePlAssertionConfig({ ...cfg, identity }), /PL_CONCIERGE_identity_invalid/, JSON.stringify(identity));
  assert.doesNotThrow(() => validatePlAssertionConfig({ ...cfg, identity: IDENTITY }));
});

test("wrong identity: a context minted for one agent/workspace does not verify for another", async () => {
  const f = fixture({ scopeInbox: 18, plInbox: 18 });
  await run(f);
  const input = f.seldon.turnInputs[0];
  const claims = claimsOf(input.relayContext);
  const exp = expectedFor(18, input, claims);
  for (const [k, v] of [["agentId", "11111111-2222-4333-8444-555555555555"], ["workspaceId", "99999999-a471-4260-8265-a9893e2b2cae"], ["agentSlug", "other-agent"]]) {
    assert.deepEqual(verifyRelayContext(input.relayContext, { keys: { ctxtest1: TEST_CTX_KEY }, nowSec: NOW / 1000, expected: { ...exp, [k]: v } }), { ok: false, reason: `binding_mismatch:${k}` });
  }
});

// ── 5. missing configuration ──
test("missing configuration: invalid PL_CONCIERGE_INBOX_ID values refuse; capability path and readback token are required", () => {
  for (const raw of ["0", "-1", "18x", " 18", "18 ", "1e2", "011", "1234567890"]) assert.throws(() => parsePlConciergeInboxId(raw), /PL_CONCIERGE_INBOX_ID_invalid/, raw);
  assert.equal(parsePlConciergeInboxId("18"), 18);
  const cfg = { enabled: true, accountId: 2, inboxId: 18, allowedInboxId: 18, key: KEY, kid: "uat1", bridgeKey: TEST_CTX_KEY, bridgeKid: "ctxtest1", phoneNumberId: TEST_PNID, sfToken: "synthetic-readback-token", identity: IDENTITY, requireCapability: true };
  assert.throws(() => validatePlAssertionConfig({ ...cfg, requireCapability: false }), /require_SF_REQUIRE_CONVERSATION_CAPABILITY/);
  assert.throws(() => validatePlAssertionConfig({ ...cfg, sfToken: null }), /SF_TOKEN_FILE_required_for_pl_offer_readback/);
  assert.throws(() => validatePlAssertionConfig({ ...cfg, allowedInboxId: 0 }), /PL_CONCIERGE_INBOX_ID_invalid/);
  assert.throws(() => validatePlAssertionConfig({ ...cfg, bridgeKey: null }), /CONTEXT_KEY_FILE_required/);
  assert.throws(() => validatePlAssertionConfig({ ...cfg, phoneNumberId: undefined }), /PHONE_NUMBER_ID_invalid/);
  assert.doesNotThrow(() => validatePlAssertionConfig(cfg));
  // Assertions OFF stays exactly as permissive as before (non-PL relays are unaffected).
  assert.doesNotThrow(() => validatePlAssertionConfig({ enabled: false, accountId: 3, inboxId: 16 }));
});

// ── the real entry point, in a child process (configuration is read by server.js main, not by the helpers above) ──
const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
function boot(extraEnv, { omit = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-scope-"));
  const file = (name, value) => { const p = join(dir, name); writeFileSync(p, value); return p; };
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: "0",
    CHATWOOT_ACCOUNT_ID: "2", CHATWOOT_INBOX_ID: "11", CHATWOOT_BASE_URL: "http://127.0.0.1:9", CHATWOOT_ESCALATION_TEAM_ID: "8",
    CHATWOOT_BOT_SECRET_FILE: file("bot-secret", "synthetic-bot-secret-material"), CHATWOOT_BOT_TOKEN_FILE: file("bot-token", "synthetic-bot-token"),
    SF_BASE_URL: "http://127.0.0.1:9", SF_AGENT_SLUG: IDENTITY.agentSlug, SF_AGENT_ID: IDENTITY.agentId, SF_WORKSPACE_ID: IDENTITY.workspaceId,
    SF_TOKEN_FILE: file("sf-token", "synthetic-readback-token"), SF_REQUIRE_CONVERSATION_CAPABILITY: "1", SF_ESCALATION_READBACK_ENABLED: "1",
    SF_CONVERSATION_STATE_KEY_FILE: file("state-key", "synthetic-state-key-material-long-enough-32"),
    PL_CONCIERGE_ASSERTIONS_ENABLED: "1", PL_CONCIERGE_ASSERTION_KEY_FILE: file("pl-key", KEY), PL_CONCIERGE_ASSERTION_KID: "pl2",
    PL_CONCIERGE_CONTEXT_KEY_FILE: file("ctx-key", PROD_CTX_KEY), PL_CONCIERGE_CONTEXT_KID: "ctx1", PL_CONCIERGE_PHONE_NUMBER_ID: PROD_PNID,
    ...extraEnv,
  };
  for (const k of omit) delete env[k];
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); rmSync(dir, { recursive: true, force: true }); resolve(r); };
    const timer = setTimeout(() => finish({ booted: false, timeout: true, out, err }), 8000);
    child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.includes('"event":"boot"')); if (line) finish({ booted: true, boot: JSON.parse(line), out, err }); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => finish({ booted: false, code, out, err }));
  });
}

test("entry point: production-shaped env with PL_CONCIERGE_INBOX_ID unset boots on inbox 11 and reports plInboxId 11", async () => {
  const r = await boot({});
  assert.equal(r.booted, true, r.err);
  assert.equal(r.boot.inboxId, 11);
  assert.equal(r.boot.plInboxId, 11);
});

test("entry point: the test-route env (inbox 18, PL_CONCIERGE_INBOX_ID=18, UUID identity, test context kid) boots and reports plInboxId 18", async () => {
  const r = await boot({ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18", PL_CONCIERGE_CONTEXT_KID: "ctxtest1", PL_CONCIERGE_PHONE_NUMBER_ID: TEST_PNID });
  assert.equal(r.booted, true, r.err);
  assert.equal(r.boot.inboxId, 18);
  assert.equal(r.boot.plInboxId, 18);
});

test("entry point: each misconfiguration refuses to boot with its own reason (and never prints a secret)", async () => {
  const cases = [
    [{ CHATWOOT_INBOX_ID: "18" }, /scoped_to_account2_inbox11/], // today's test relay inbox with the default scope
    [{ PL_CONCIERGE_INBOX_ID: "18" }, /scoped_to_account2_inbox18/], // production inbox with the test scope
    [{ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18x" }, /PL_CONCIERGE_INBOX_ID_invalid/],
    // today's test-relay agent value: refused first by the existing capability check (UUID agent), then by the PL identity check
    [{ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18", SF_AGENT_ID: "clawith-pl-candidate" }, /conversation_capability_configuration_incomplete|PL_CONCIERGE_identity_invalid/],
    // a workspace id the capability check accepts (non-empty) but the context binding cannot carry (< 16 chars): only the new check refuses it
    [{ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18", SF_WORKSPACE_ID: "short" }, /PL_CONCIERGE_identity_invalid/],
    [{ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18", SF_WORKSPACE_ID: undefined }, /PL_CONCIERGE_identity_invalid|conversation_capability_configuration_incomplete/],
    [{ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18", SF_REQUIRE_CONVERSATION_CAPABILITY: "0" }, /require_SF_REQUIRE_CONVERSATION_CAPABILITY/],
    [{ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18", SF_TOKEN_FILE: undefined }, /SF_TOKEN_FILE_required/],
    [{ CHATWOOT_INBOX_ID: "18", PL_CONCIERGE_INBOX_ID: "18", PL_CONCIERGE_CONTEXT_KEY_FILE: undefined }, /missing required environment variable PL_CONCIERGE_CONTEXT_KEY_FILE/],
  ];
  for (const [env, reason] of cases) {
    const r = await boot(env);
    assert.equal(r.booted, false, JSON.stringify(env));
    assert.match(r.err, reason, JSON.stringify(env));
    for (const secret of [KEY, PROD_CTX_KEY, "synthetic-readback-token", "synthetic-bot-token"]) assert.equal((r.out + r.err).includes(secret), false);
  }
});
