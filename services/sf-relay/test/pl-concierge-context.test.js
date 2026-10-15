import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mintPlAssertion, mintRelayContext, resolveChatwootWhatsAppSource, verifyRelayContext } from "../src/pl-concierge-assertion.js";
import { createRelay } from "../src/relay.js";
import { seldonClient } from "../src/clients.js";
import { validatePlAssertionConfig } from "../src/server.js";

const KEY = "synthetic-pl-assertion-key-material-32-bytes-minimum";
const BRIDGE_KEY = "synthetic-relay-context-key-material-32-bytes-minimum";
const SCOPE = { accountId: 2, inboxId: 11, workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "pl-staging-test-agent" };
const CONTACT = { payload: {
  id: 541,
  phone_number: "+17670000000",
  contact_inboxes: [{ source_id: "17679990001", inbox: { id: 11, channel_type: "Channel::Whatsapp", provider: "whatsapp_cloud" } }],
} };
const CONVERSATION = { id: 41, account_id: 2, inbox_id: 11, status: "pending", meta: { channel: "Channel::Whatsapp", sender: { id: 541 } } };
const NOW = 1_797_000_000_000;

function decode(assertion) {
  const [, encoded, sig] = assertion.split(".");
  const expected = createHmac("sha256", KEY).update(`v1.${encoded}`).digest("base64url");
  assert.equal(sig, expected);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function fixture({ contact = CONTACT, resolver, now = NOW, turnEvidence = { known: true, currentTurnVerified: true, escalated: false, toolCalls: [], toolResults: [] }, turnText = "Here are the verified Personal Line details.", turnSeq = null } = {}) {
  const posted = [];
  const calls = [];
  const row = structuredClone({ ...CONVERSATION, custom_attributes: {}, meta: { ...CONVERSATION.meta, sender: { id: 541 }, assignee: { id: 16 } } });
  const event = {
    event: "message_created", id: 7001, content: "Tell me about Personal Line.", message_type: "incoming", private: false,
    sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: 11 },
    conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } },
  };
  const chatwoot = {
    async getConversation() { calls.push("conversation_read"); return structuredClone(row); },
    async getContact(id) { calls.push(`contact_read:${id}`); return structuredClone(contact); },
    async updateConversationCustomAttributes(id, values) { Object.assign(row.custom_attributes, values); return { custom_attributes: structuredClone(row.custom_attributes) }; },
    async postMessage(id, content, opts) { posted.push({ id, content, private: opts.private, items: opts.items ?? null }); },
    async toggleStatus() {}, async assignOwner() {}, async assignTeam() {},
  };
  let turnInput;
  const seldon = {
    turnInputs: [],
    async turn(input) { turnInput = input; seldon.turnInputs.push(input); if (turnSeq && turnSeq.length) return turnSeq.shift(); return { ok: true, text: turnText, conversationId: "sf-conv", conversationCapability: "visitor-bound-capability" }; },
    async escalation() { return { known: true, escalated: false }; },
    async inspectTurn() { return structuredClone(turnEvidence); },
  };
  const relay = createRelay({
    scope: SCOPE, ownerUserId: 16, escalationTeamId: 8, chatwoot, seldon,
    requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32",
    plConcierge: { key: KEY, kid: "uat1", bridgeKey: BRIDGE_KEY, bridgeKid: "ctx1", phoneNumberId: "1023804347491554", resolveConfirmation: resolver },
    now: () => now,
  });
  return { event, relay, chatwoot, calls, posted, seldon, get turnInput() { return turnInput; } };
}

async function run(f, event = f.event) {
  const accepted = f.relay.accept(event);
  await accepted.done;
}

test("frozen assertion format: fresh nonce, scoped ids and signature verify without logging material", () => {
  const token = mintPlAssertion({ key: KEY, kid: "uat1", waId: "17679990001", phoneNumberId: "1023804347491554", conversationId: "41", messageId: "7001", nowSec: 100 });
  const p = decode(token);
  assert.deepEqual(Object.keys(p).sort(), ["iat", "kid", "mid", "nonce", "pnid", "rid", "wa_id"].sort());
  assert.equal(p.rid, "41");
  assert.equal(p.mid, "7001");
  assert.equal(p.nonce.length, 22);
  assert.notEqual(token, mintPlAssertion({ key: KEY, kid: "uat1", waId: "17679990001", phoneNumberId: "1023804347491554", conversationId: "41", messageId: "7001", nowSec: 100 }));
});

test("confirmation act is absent by default and invalid or mismatched offer proof is refused", () => {
  const base = { key: KEY, kid: "uat1", waId: "17679990001", phoneNumberId: "1023804347491554", conversationId: "41", messageId: "7001", nowSec: 100 };
  assert.equal("act" in decode(mintPlAssertion(base)), false);
  for (const confirmation of [
    { verified: true, source: "numbered", offerKey: "wrong", waId: base.waId, conversationId: base.conversationId, messageId: base.messageId },
    { verified: true, source: "numbered", offerKey: "trial", waId: "17670000000", conversationId: base.conversationId, messageId: base.messageId },
    { verified: true, source: "model", offerKey: "trial", waId: base.waId, conversationId: base.conversationId, messageId: base.messageId },
    { verified: false, source: "button", offerKey: "trial", waId: base.waId, conversationId: base.conversationId, messageId: base.messageId },
  ]) assert.throws(() => mintPlAssertion({ ...base, confirmation }), /confirmation_unverified/);
  const confirmed = decode(mintPlAssertion({ ...base, confirmation: { verified: true, source: "numbered", offerKey: "trial", waId: base.waId, conversationId: base.conversationId, messageId: base.messageId } }));
  assert.equal(confirmed.act, "pl.confirm_signup");
  assert.equal(confirmed.act_src, "numbered");
});

test("identity comes from the matching Chatwoot WhatsApp source id, not sender phone text", () => {
  assert.deepEqual(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: CONTACT, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 541 }), { waId: "17679990001", contactId: 541, inboxId: 11 });
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: CONTACT, expectedAccountId: 3, expectedInboxId: 11, webhookSenderId: 541 }), null);
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: CONTACT, expectedAccountId: 2, expectedInboxId: 12, webhookSenderId: 541 }), null);
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: CONTACT, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 999 }), null);
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: { ...CONTACT, payload: { ...CONTACT.payload, contact_inboxes: [{ source_id: "not-a-provider-id", inbox: { id: 11, channel_type: "Channel::Whatsapp" } }] } }, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 541 }), null);
  const phoneOnly = { payload: { id: 541, phone_number: "+17679990001", contact_inboxes: [] } };
  // C5: the REAL shape - numeric phone id + prefixed id in the SAME inbox. POSITIVE control: resolves to the numeric id; the order must not matter.
  const WA = { id: 11, channel_type: "Channel::Whatsapp", provider: "whatsapp_cloud" };
  for (const pair of [["17679990001", "DM.AAAABBBBCCCCDDDD"], ["DM.AAAABBBBCCCCDDDD", "17679990001"], ["17679990001", "US.ABCDEF1234567"], ["17679990001", "VI.X1"], ["17679990001", "GP.X1"], ["17679990001", "CN.X1"]]) {
    const real = { payload: { ...CONTACT.payload, contact_inboxes: pair.map((source_id) => ({ source_id, inbox: WA })) } };
    assert.deepEqual(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: real, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 541 }), { waId: "17679990001", contactId: 541, inboxId: 11 }, pair.join("+"));
  }
  // NEGATIVES (same harness): two NUMERIC ids stay ambiguous; a prefixed-only contact is refused; the pair in ANOTHER inbox is refused.
  const twoNumeric = { payload: { ...CONTACT.payload, contact_inboxes: [{ source_id: "17679990001", inbox: WA }, { source_id: "17679990002", inbox: WA }] } };
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: twoNumeric, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 541 }), null);
  const prefixedOnly = { payload: { ...CONTACT.payload, contact_inboxes: [{ source_id: "DM.AAAABBBBCCCCDDDD", inbox: WA }, { source_id: "US.ABCDEF1234567", inbox: WA }] } };
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: prefixedOnly, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 541 }), null);
  const otherInbox = { payload: { ...CONTACT.payload, contact_inboxes: [{ source_id: "17679990001", inbox: { ...WA, id: 12 } }, { source_id: "DM.AAAABBBBCCCCDDDD", inbox: { ...WA, id: 12 } }] } };
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: otherInbox, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 541 }), null);
  assert.equal(resolveChatwootWhatsAppSource({ conversation: CONVERSATION, contactResponse: phoneOnly, expectedAccountId: 2, expectedInboxId: 11, webhookSenderId: 541 }), null);
});

test("relay attaches a short-lived assertion only from authenticated Chatwoot records; it is not persisted or sent to the model", async () => {
  const f = fixture();
  await run(f);
  assert.deepEqual(f.calls, ["conversation_read", "contact_read:541", "conversation_read"]);
  assert.equal(typeof f.turnInput.relayContext, "string");
  const context = verifyRelayContext(f.turnInput.relayContext, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: {
    accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug,
    sessionId: "cw-chatwoot-2-41", uplinkConversationId: null,
    chatwootConversationId: "41", chatwootMessageId: "7001",
    messageSha256: createHash("sha256").update(f.event.content).digest("hex"),
  } });
  assert.equal(context.ok, true);
  const p = decode(context.payload.plAssertion);
  assert.equal(p.wa_id, "17679990001");
  assert.equal(p.pnid, "1023804347491554");
  assert.equal(p.rid, "41");
  assert.equal(p.mid, "7001");
  assert.equal("act" in p, false);
  assert.equal(JSON.stringify(f.turnInput.channelMeta).includes(context.payload.plAssertion), false);
  assert.equal(f.posted.length, 1);
});

test("model/customer text alone cannot mint signup confirmation; resolver must return an offer-bound proof", async () => {
  const noResolver = fixture();
  await run(noResolver, { ...noResolver.event, content: "1" });
  assert.equal("act" in decode(verifyRelayContext(noResolver.turnInput.relayContext, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: {
    accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug,
    sessionId: "cw-chatwoot-2-41", uplinkConversationId: null, chatwootConversationId: "41", chatwootMessageId: "7001",
    messageSha256: createHash("sha256").update("1").digest("hex"),
  } }).payload.plAssertion), false);

  const wrongOffer = fixture({ resolver: async () => ({ verified: true, source: "numbered", offerKey: "week-pass", waId: "17679990001", conversationId: "41", messageId: "7001" }) });
  await run(wrongOffer, { ...wrongOffer.event, content: "1" });
  assert.ok(wrongOffer.turnInput, JSON.stringify(wrongOffer.calls));
  assert.equal(wrongOffer.turnInput.relayContext, null);

  const verified = fixture({ resolver: async ({ event, identity }) => event.content === "1" ? ({ verified: true, source: "numbered", offerKey: "trial", waId: identity.waId, conversationId: "41", messageId: String(event.messageId) }) : null });
  await run(verified, { ...verified.event, content: "1" });
  const proof = verifyRelayContext(verified.turnInput.relayContext, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: {
    accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug,
    sessionId: "cw-chatwoot-2-41", uplinkConversationId: null, chatwootConversationId: "41", chatwootMessageId: "7001",
    messageSha256: createHash("sha256").update("1").digest("hex"),
  } });
  assert.equal(proof.ok, true);
  const p = decode(proof.payload.plAssertion);
  assert.equal(p.act, "pl.confirm_signup");
  assert.equal(p.act_src, "numbered");
});

test("relay request sends signed bridge context out-of-band, never in channel_meta/model arguments", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    return Response.json({ conversation_id: "sf-conv", conversation_capability: "cap", message: "ok" });
  };
  const client = seldonClient({ baseUrl: "https://uplink.epic.dm", slug: SCOPE.agentSlug, fetchImpl });
  await client.turn({ message: "hello", sessionId: "cw-2-41", relayContext: "v1.synthetic", channelMeta: { source: "chatwoot", account_id: 2, inbox_id: 11, conversation_id: 41 } });
  assert.equal(calls[0].headers["x-isola-relay-context"], "v1.synthetic");
  assert.equal(calls[0].body.channel_meta.pl_assertion, undefined);
});

test("assertion key configuration is scoped to account 2 inbox 11 and fails closed", () => {
  assert.doesNotThrow(() => validatePlAssertionConfig({ enabled: false }));
  assert.throws(() => validatePlAssertionConfig({ enabled: true, accountId: 2, inboxId: 12, key: KEY, kid: "uat1", phoneNumberId: "1023804347491554" }), /scoped_to_account2_inbox11/);
  assert.throws(() => validatePlAssertionConfig({ enabled: true, accountId: 2, inboxId: 11, key: "short", kid: "uat1", phoneNumberId: "1023804347491554" }), /KEY_FILE_required/);
  assert.throws(() => validatePlAssertionConfig({ enabled: true, accountId: 2, inboxId: 11, key: KEY, kid: "uat1", phoneNumberId: "1023804347491554" }), /CONTEXT_KEY_FILE_required/);
  assert.throws(() => validatePlAssertionConfig({ enabled: true, accountId: 2, inboxId: 11, key: KEY, kid: "uat1", bridgeKey: BRIDGE_KEY, bridgeKid: "ctx1", phoneNumberId: "1023804347491554" }), /SF_TOKEN_FILE_required_for_pl_offer_readback/);
  assert.doesNotThrow(() => validatePlAssertionConfig({ enabled: true, accountId: 2, inboxId: 11, key: KEY, kid: "uat1", bridgeKey: BRIDGE_KEY, bridgeKid: "ctx1", phoneNumberId: "1023804347491554", sfToken: "synthetic-readback-token" }));
});

test("Seldon readback exposes only the latest assistant tool results when workspace, agent, visitor and Chatwoot scope match", async () => {
  const message = "I'd like to start a line";
  const toolCalls = [{ id: "tc-1", name: "pl-action-adapter__pl_present_offer", input: { offer_key: "trial" } }];
  const toolResults = [{ toolCallId: "tc-1", ok: true, output: { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "offer_issued", offer_key: "trial", confirm_with: "1", customer_message: "Canonical synthetic offer: reply 1 to continue." }) }] } }];
  const conversation = {
    id: "sf-conv", orgId: SCOPE.workspaceId, agentId: SCOPE.agentId, anonymousSessionId: "cw-chatwoot-2-41",
    channelMeta: { source: "chatwoot", account_id: 2, inbox_id: 11, conversation_id: 41 },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/turn")) return new Response(JSON.stringify({ conversation_id: "sf-conv", conversation_capability: "cap", message: "model text" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, conversation, turns: [
      { role: "user", content: message },
      { role: "assistant", content: "model text", toolCalls, toolResults },
    ] }), { status: 200 });
  };
  const client = seldonClient({ baseUrl: "https://uplink.epic.dm", slug: SCOPE.agentSlug, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, token: "synthetic-token", fetchImpl });
  const turn = await client.turn({ message, sessionId: conversation.anonymousSessionId, relayContext: "v1.synthetic" });
  const evidence = await client.inspectTurn({ conversationId: turn.conversationId, sessionId: conversation.anonymousSessionId, userMessage: message, chatwootConversationId: 41, accountId: 2, inboxId: 11 });
  assert.equal(evidence.currentTurnVerified, true);
  assert.deepEqual(evidence.toolCalls, toolCalls);
  assert.deepEqual(evidence.toolResults, toolResults);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers["x-org-id"], SCOPE.workspaceId);
  assert.equal(calls[1].init.headers.authorization, "Bearer synthetic-token");
});

test("Seldon current-turn readback fails closed on wrong agent, workspace, visitor or Chatwoot binding", async () => {
  const expected = { id: "sf-conv", orgId: SCOPE.workspaceId, agentId: SCOPE.agentId, anonymousSessionId: "cw-chatwoot-2-41", channelMeta: { source: "chatwoot", account_id: 2, inbox_id: 11, conversation_id: 41 } };
  for (const conversation of [
    { ...expected, orgId: "other-workspace" },
    { ...expected, agentId: "other-agent" },
    { ...expected, anonymousSessionId: "other-visitor" },
    { ...expected, channelMeta: { ...expected.channelMeta, inbox_id: 16 } },
  ]) {
    const fetchImpl = async () => new Response(JSON.stringify({ conversation, turns: [{ role: "user", content: "hi" }, { role: "assistant", toolCalls: [], toolResults: [] }] }), { status: 200 });
    const client = seldonClient({ baseUrl: "https://uplink.epic.dm", slug: SCOPE.agentSlug, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, token: "synthetic-token", fetchImpl });
    assert.equal((await client.inspectTurn({ conversationId: "sf-conv", sessionId: "cw-chatwoot-2-41", userMessage: "hi", chatwootConversationId: 41, accountId: 2, inboxId: 11 })).known, false);
  }
});

test("current offer tool result is sent as one deterministic canonical message, not model prose", async () => {
  const canonical = "Free trial: 7 days with 60 minutes of Dominica calls, EC$0.00. To set up your line now, reply 1.";
  const call = { id: "tool-1", name: "pl-action-adapter__pl_present_offer", input: { offer_key: "trial" } };
  const output = { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "offer_issued", offer_key: "trial", confirm_with: "1", customer_message: canonical }) }] };
  const f = fixture({
    turnEvidence: { known: true, currentTurnVerified: true, escalated: false, toolCalls: [call], toolResults: [{ toolCallId: call.id, ok: true, output }] },
    turnText: `Here is the deal! ${canonical} (plus extra model wording).`,
  });
  await run(f);
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), [canonical]);
  assert.equal(f.posted.some((m) => m.content.includes("Here is the deal!")), false);
});

test("unverified, failed, mismatched or malformed offer tool results never send model confirmation text", async () => {
  const canonical = "Free trial: 7 days with 60 minutes of Dominica calls, EC$0.00. To set up your line now, reply 1.";
  const call = { id: "tool-2", name: "pl-action-adapter__pl_present_offer", input: { offer_key: "trial" } };
  const goodOutput = { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "offer_issued", offer_key: "trial", confirm_with: "1", customer_message: canonical }) }] };
  const invalid = [
    { known: false, currentTurnVerified: false, toolCalls: [call], toolResults: [{ toolCallId: call.id, ok: true, output: goodOutput }] },
    { known: true, currentTurnVerified: true, toolCalls: [call], toolResults: [{ toolCallId: "other-call", ok: true, output: goodOutput }] },
    { known: true, currentTurnVerified: true, toolCalls: [call], toolResults: [{ toolCallId: call.id, ok: false, output: goodOutput }] },
    { known: true, currentTurnVerified: true, toolCalls: [call], toolResults: [{ toolCallId: call.id, ok: true, output: { isError: true, content: goodOutput.content } }] },
    { known: true, currentTurnVerified: true, toolCalls: [{ ...call, input: { offer_key: "trial", phone: "17675550142" } }], toolResults: [{ toolCallId: call.id, ok: true, output: goodOutput }] },
  ];
  for (const turnEvidence of invalid) {
    const f = fixture({ turnEvidence, turnText: canonical });
    await run(f);
    assert.equal(f.posted.some((m) => !m.private && m.content === canonical), false);
    assert.equal(f.posted.some((m) => !m.private && m.content === canonical), false);
  }
});

test("model-generated confirmation offer without a current offer tool is withheld", async () => {
  const f = fixture({ turnText: "To set up your line now, reply 1." });
  await run(f);
  assert.equal(f.posted.some((m) => !m.private && m.content.includes("reply 1")), false);
});

test("relay context is HMAC-authenticated, short-lived and bound to each customer/channel/agent/message", () => {
  const token = mintRelayContext({ key: BRIDGE_KEY, kid: "ctx1", accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug,
    sessionId: "cw-chatwoot-2-41", uplinkConversationId: "sf-conv", chatwootConversationId: "41", chatwootMessageId: "7002",
    message: "1", plAssertion: "v1.synthetic", nowSec: Math.floor(NOW / 1000) });
  const expected = { accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug,
    sessionId: "cw-chatwoot-2-41", uplinkConversationId: "sf-conv", chatwootConversationId: "41", chatwootMessageId: "7002",
    messageSha256: createHash("sha256").update("1").digest("hex") };
  assert.equal(verifyRelayContext(token, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected }).ok, true);
  for (const altered of [
    { ...expected, inboxId: 12 }, { ...expected, workspaceId: "other-workspace" },
    { ...expected, agentId: "a5e7235d-9fe1-409a-b824-d7810fc13ab1" }, { ...expected, agentSlug: "other-agent" },
    { ...expected, sessionId: "other-session" }, { ...expected, uplinkConversationId: "other-conversation" },
    { ...expected, chatwootConversationId: "42" }, { ...expected, chatwootMessageId: "7003" },
    { ...expected, messageSha256: createHash("sha256").update("2").digest("hex") },
  ]) assert.equal(verifyRelayContext(token, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: altered }).ok, false);
  assert.equal(verifyRelayContext(token, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000) + 61, expected }).reason, "stale");
  assert.equal(verifyRelayContext(token, { keys: { ctx1: "wrong-key-material-which-is-32-bytes-long" }, nowSec: Math.floor(NOW / 1000), expected }).reason, "bad_signature");
});

test("agentId is mandatory, UUID-validated and bound into the signed claim", () => {
  const args = { key: BRIDGE_KEY, kid: "ctx1", accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId,
    agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug, sessionId: "cw-chatwoot-2-41", uplinkConversationId: null,
    chatwootConversationId: "41", chatwootMessageId: "7004", message: "status", plAssertion: "v1.synthetic", nowSec: Math.floor(NOW / 1000) };
  assert.throws(() => mintRelayContext({ ...args, agentId: undefined }), /relay_context_agent_invalid/);
  assert.throws(() => mintRelayContext({ ...args, agentId: "not-a-uuid" }), /relay_context_agent_invalid/);
  const token = mintRelayContext(args);
  const expected = { accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId,
    agentSlug: SCOPE.agentSlug, sessionId: "cw-chatwoot-2-41", uplinkConversationId: null,
    chatwootConversationId: "41", chatwootMessageId: "7004", messageSha256: createHash("sha256").update("status").digest("hex") };
  assert.equal(verifyRelayContext(token, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected }).ok, true);
  assert.equal(verifyRelayContext(token, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: { ...expected, agentId: "a5e7235d-9fe1-409a-b824-d7810fc13ab1" } }).ok, false);
});

// ── 2026-10-10: verified non-offer outcomes of the offer tool (owner test conv 512: a line holder was escalated) ──
function offerToolEvidence({ ok = true, isError = false, payload, rawError } = {}) {
  const call = { id: "tool-ne", name: "pl-action-adapter__pl_present_offer", input: { offer_key: "trial" } };
  const result = rawError
    ? { toolCallId: call.id, ok: false, error: rawError }
    : { toolCallId: call.id, ok, output: { isError, content: [{ type: "text", text: JSON.stringify(payload) }] } };
  return { known: true, currentTurnVerified: true, escalated: false, toolCalls: [call], toolResults: [result] };
}
const handedOff = (f) => f.posted.some((m) => m.private && /Relay handoff/.test(m.content));

test("verified line_exists outcome: the model's status reply is sent, no handoff", async () => {
  const reply = "You already have your Isola line +1 767 818 5097, and it's connected.";
  const f = fixture({ turnEvidence: offerToolEvidence({ payload: { code: "line_exists", offer_key: "trial", did_masked: "+1 767 *** 5097" } }), turnText: reply });
  await run(f);
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), [reply]);
  assert.equal(handedOff(f), false);
});

// rc9 (owner 2026-10-10: "Replace generic 'Sent' and 'Anything else?' replies ... Avoid duplicate messages"). Supersedes the rc7
// assertion that the model's reply is posted after setup_flow_sent: the Flow message IS the answer, so the model's line is not sent.
// rc10b SUPERSEDES the rc9 assertion (PM 2026-10-10: suppression must not hide needed guidance): the Flow is a separate WhatsApp
// message outside this thread, so the agent's guidance around it IS posted (once), with no handoff.
test("verified setup_flow_sent outcome: the agent's guidance is posted once alongside the Flow, no handoff", async () => {
  const reply = "For Dominica plus calls to Toronto the Week Pass fits best - your signup form is in the chat now, tap Start setup to begin free.";
  const f = fixture({ turnEvidence: offerToolEvidence({ payload: { code: "setup_flow_sent", offer_key: "trial" } }), turnText: reply });
  await run(f);
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), [reply]);
  assert.equal(handedOff(f), false);
});

test("rc9: a tool that delivered its own message (message_sent) suppresses the model's duplicate line; CONTROL a read-only tool result does not", async () => {
  const dup = "Sent - your balance is right there in that message. Anything else?";
  const bal = { id: "tool-bal", name: "pl-action-adapter__pl_balance", input: {} };
  const balEvidence = { known: true, currentTurnVerified: true, escalated: false, toolCalls: [bal],
    toolResults: [{ toolCallId: bal.id, ok: true, output: { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "message_sent", stage: "balance" }) }] } }] };
  const f = fixture({ turnEvidence: balEvidence, turnText: dup });
  await run(f);
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), []);
  assert.equal(handedOff(f), false);
  // CONTROL: line_exists WITHOUT a delivered form leaves the model's reply as the only answer, so it IS posted.
  const reply = "You already have your line +1 767 818 5097 and it's working.";
  const c = fixture({ turnEvidence: offerToolEvidence({ payload: { code: "line_exists", offer_key: "trial", setup_flow_sent: false } }), turnText: reply });
  await run(c);
  assert.deepEqual(c.posted.filter((m) => !m.private).map((m) => m.content), [reply]);
});

test("CONTROL the exact failing shape from conv 512 (ok:false MCP error carrying line_exists) still escalates", async () => {
  const f = fixture({ turnEvidence: offerToolEvidence({ rawError: 'MCP tool "pl_present_offer" reported an error: {"code":"line_exists","did_masked":"+1 767 *** 5097"}' }), turnText: "You already have a line." });
  await run(f);
  assert.equal(handedOff(f), true);
  assert.equal(f.posted.some((m) => !m.private && m.content === "You already have a line."), false);
});

test("CONTROL genuine failures still escalate: isError, unknown code, missing offer_key, service failure", async () => {
  for (const ev of [
    offerToolEvidence({ isError: true, payload: { code: "line_exists", offer_key: "trial" } }),
    offerToolEvidence({ payload: { code: "service_unavailable", offer_key: "trial" } }),
    offerToolEvidence({ payload: { code: "line_exists" } }),
    offerToolEvidence({ ok: false, payload: { code: "line_exists", offer_key: "trial" } }),
    { ...offerToolEvidence({ payload: { code: "line_exists", offer_key: "trial" } }), currentTurnVerified: false },
  ]) {
    const f = fixture({ turnEvidence: ev, turnText: "You already have a line." });
    await run(f);
    assert.equal(handedOff(f), true, JSON.stringify(ev.toolResults[0]).slice(0, 120));
  }
});

test("line_exists does not license a confirmation offer: a 'reply 1' reply is still withheld", async () => {
  const f = fixture({ turnEvidence: offerToolEvidence({ payload: { code: "line_exists", offer_key: "trial" } }), turnText: "To set up your line now, reply 1." });
  await run(f);
  assert.equal(f.posted.some((m) => !m.private && m.content.includes("reply 1")), false);
});

// ── 2026-10-10: deterministic end-of-onboarding actions (no model turn) ──
import { FLOW_DONE_CONNECTED_TEXT, FLOW_DONE_OTHER_TEXT, requestsHuman } from "../src/relay.js";
function countingFixture(turnText = "model reply") {
  const f = fixture({ turnText });
  let modelCalls = 0;
  const orig = f.relay;
  return { f, get modelCalls() { return modelCalls; }, wrapTurn(seldonTurn) { modelCalls++; return seldonTurn; } };
}
test("'Talk to a person' (button title) and typed variants are an explicit request; ordinary text is not", () => {
  for (const t of ["Talk to a person", "talk to a person", " Talk to a person. ", "speak with a human", "chat to someone"]) assert.equal(requestsHuman(t), true, t);
  for (const t of ["Get your free number", "how do I talk to a person later?", "my person is calling", "Check my balance"]) assert.equal(requestsHuman(t), false, t);
});
test("tapping 'Talk to a person' hands off WITHOUT a model turn", async () => {
  const f = fixture({ turnText: "should never be sent" });
  await run(f, { ...f.event, id: 7101, content: "Talk to a person" });
  assert.equal(f.turnInput, undefined, "model must not be called");
  assert.equal(f.posted.some((m) => m.private && /customer explicitly requested a person/.test(m.content)), true);
});
const flowEvent = (f, status) => ({ ...f.event, id: 7200 + (status ? status.length : 0), content: "Submitted a flow response",
  content_attributes: { whatsapp_flow_response: { name: "flow", body: "Sent", response_json: status === undefined ? {} : { status } } } });
test("Flow Done (status connected): fixed acknowledgement + staff note, NO model turn", async () => {
  const f = fixture({ turnText: "should never be sent" });
  await run(f, flowEvent(f, "connected"));
  assert.equal(f.turnInput, undefined, "model must not be called");
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), [FLOW_DONE_CONNECTED_TEXT]);
  assert.equal(f.posted.some((m) => m.private && /finished the WhatsApp setup form \(status: connected\)/.test(m.content)), true);
});
test("Flow Done (status error or missing): the non-connected acknowledgement, NO model turn", async () => {
  for (const st of ["error", undefined]) {
    const f = fixture({ turnText: "should never be sent" });
    await run(f, flowEvent(f, st));
    assert.equal(f.turnInput, undefined);
    assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), [FLOW_DONE_OTHER_TEXT]);
  }
});
test("CONTROL ordinary customer text still reaches the model", async () => {
  const f = fixture({ turnText: "Here is your answer." });
  await run(f, { ...f.event, id: 7300, content: "What can you do?" });
  assert.notEqual(f.turnInput, undefined, "model must be called for ordinary text");
});

// rc10 (PM 2026-10-10: the agent writes; buttons ride on its reply): a facts-mode tool's choices are attached to the agent's reply.
function factsEvidence(payload, name = "pl-action-adapter__pl_journey") {
  const call = { id: "tool-f", name, input: {} };
  return { known: true, currentTurnVerified: true, escalated: false, toolCalls: [call],
    toolResults: [{ toolCallId: call.id, ok: true, output: { isError: false, content: [{ type: "text", text: JSON.stringify(payload) }] } }] };
}
test("rc10: facts result -> ONE message: the agent's words + the tool's buttons; CONTROL no facts -> plain reply", async () => {
  const reply = "Your line +1 767 818 5097 is working - what can I help with today?";
  const choices = [{ title: "Balance", value: "pl_balance" }, { title: "Recent calls", value: "pl_calls" }, { title: "Calling help", value: "pl_callhelp" }];
  const f = fixture({ turnEvidence: factsEvidence({ code: "facts", topic: "journey", state: "active", choices }), turnText: reply });
  await run(f);
  const pub = f.posted.filter((m) => !m.private);
  assert.equal(pub.length, 1);
  assert.equal(pub[0].content, reply);
  assert.deepEqual(pub[0].items, choices);
  assert.equal(handedOff(f), false);
  const c = fixture({ turnText: "Here are the verified Personal Line details." });
  await run(c);
  const cpub = c.posted.filter((m) => !m.private);
  assert.equal(cpub.length, 1);
  assert.equal(cpub[0].items, null);
});
test("rc10: buttons are sanitised (max 3, titles <= 20, safe values) and a non-adapter tool cannot inject buttons", async () => {
  const many = [{ title: "A", value: "pl_a" }, { title: "B", value: "pl_b" }, { title: "C", value: "pl_c" }, { title: "D", value: "pl_d" },
    { title: "x".repeat(21), value: "pl_long" }, { title: "Bad", value: "Pay Now!" }];
  const f = fixture({ turnEvidence: factsEvidence({ code: "facts", choices: many }), turnText: "ok" });
  await run(f);
  assert.deepEqual(f.posted.filter((m) => !m.private)[0].items.map((i) => i.title), ["A", "B", "C"]);
  const bad = fixture({ turnEvidence: factsEvidence({ code: "facts", choices: [{ title: "Bad", value: "Pay Now!" }] }), turnText: "ok" });
  await run(bad);
  assert.equal(bad.posted.filter((m) => !m.private)[0].items, null);
  const g = fixture({ turnEvidence: factsEvidence({ code: "facts", choices: [{ title: "Pay now", value: "pay_now" }] }, "other-connector__tool"), turnText: "ok" });
  await run(g);
  assert.equal(g.posted.filter((m) => !m.private)[0].items, null);
});
test("rc10: a receipt tool (message_sent) still suppresses the duplicate line even if a facts result also exists", async () => {
  const calls = [{ id: "t1", name: "pl-action-adapter__pl_journey", input: {} }, { id: "t2", name: "pl-action-adapter__pl_balance", input: {} }];
  const ev = { known: true, currentTurnVerified: true, escalated: false, toolCalls: calls, toolResults: [
    { toolCallId: "t1", ok: true, output: { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "facts", choices: [{ title: "Balance", value: "pl_balance" }] }) }] } },
    { toolCallId: "t2", ok: true, output: { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "message_sent", stage: "balance" }) }] } }] };
  const f = fixture({ turnEvidence: ev, turnText: "Sent - anything else?" });
  await run(f);
  assert.deepEqual(f.posted.filter((m) => !m.private), []);
});

// rc10c: Uplink's metered pilot answers 503 PUBLIC_CHAT_CONVERSATION_LIMIT after 5 turns per Uplink conversation (da08b734).
test("rc10c: conversation turn limit -> ONE fresh Uplink conversation, reply posted, no handoff", async () => {
  const f = fixture({ turnSeq: [{ ok: false, reason: "http_503", error: "PUBLIC_CHAT_CONVERSATION_LIMIT", conversationId: null }] });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 2);
  assert.equal(f.seldon.turnInputs[1].conversationId, null);
  assert.notEqual(f.seldon.turnInputs[1].sessionId, f.seldon.turnInputs[0].sessionId);
  assert.equal(typeof f.seldon.turnInputs[1].relayContext, "string");
  assert.deepEqual(f.posted.filter((m) => !m.private).map((m) => m.content), ["Here are the verified Personal Line details."]);
  assert.equal(handedOff(f), false);
});
test("rc10c CONTROL: any other 503 (pilot unavailable) still hands off, with no retry", async () => {
  const f = fixture({ turnSeq: [{ ok: false, reason: "http_503", error: "PUBLIC_CHAT_UNAVAILABLE", conversationId: null }] });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 1);
  assert.equal(handedOff(f), true);
});
test("rc10c: a rotated retry that also fails is handed off once (no loop)", async () => {
  const lim = { ok: false, reason: "http_503", error: "PUBLIC_CHAT_CONVERSATION_LIMIT", conversationId: null };
  const f = fixture({ turnSeq: [lim, { ...lim }] });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 2);
  assert.equal(handedOff(f), true);
});

// rc10d: wrong/missing next action. FAILING CONTROL = the exact staging S2 reply (2026-10-11 after_rc10b) that told the customer to tap
// Check connection while only [Continue setup | Talk to a person] were attached.
import { unofferedTaps } from "../src/relay.js";
test("rc10d: reply naming a button it does not carry is detected (staging S2 control); corrected reply is clean", () => {
  const s2 = "Your line is ready \u2014 it just needs activating. I've sent your setup message: open it and tap \"Start setup\" to load your line into Cloud Softphone. Once that's done, tap Check connection and it should come up connected.";
  const items = [{ title: "Continue setup", value: "pl_setup" }, { title: "Talk to a person", value: "esc_human" }];
  assert.deepEqual(unofferedTaps(s2, items), ["Check connection"]);
  const fixed = "Your line is ready - it just needs activating. Open the setup form I sent and tap \"Start setup\" to load your line into Cloud Softphone; tap Continue setup if you need it again.";
  assert.deepEqual(unofferedTaps(fixed, items), []);
  assert.deepEqual(unofferedTaps("You can tap Check connection below.", [{ title: "Check connection", value: "pl_check" }]), []);
  assert.deepEqual(unofferedTaps("If you're stuck, tap Talk to a person.", []), []);
  assert.deepEqual(unofferedTaps("Tap *Call US/Canada* for the rates.", [{ title: "Balance", value: "pl_balance" }]), ["Call US/Canada"]);
  // staging v12 S2 turn 2 (2026-10-11): markdown bold must not hide a phantom button
  assert.deepEqual(unofferedTaps("Open the setup message and tap **Continue setup** - the link is inside.", []), ["Continue setup"]);
});

// rc10e: a follow-up turn without a facts tool that names a button from the conversation's last verified choices gets those buttons.
test("rc10e: carry the last verified buttons forward when the reply names one of them; CONTROL unrelated reply stays plain", async () => {
  const choices = [{ title: "Continue setup", value: "pl_setup" }, { title: "Talk to a person", value: "esc_human" }];
  const f = fixture({
    turnEvidence: { known: true, currentTurnVerified: true, escalated: false, toolCalls: [{ id: "a", name: "pl-action-adapter__pl_journey", input: {} }],
      toolResults: [{ toolCallId: "a", ok: true, output: { isError: false, content: [{ type: "text", text: JSON.stringify({ code: "facts", choices }) }] } }] },
    turnText: "Your line needs activating - tap Continue setup.",
  });
  await run(f);
  // second turn on the SAME relay/conversation: no tool this time, reply names Continue setup
  const ev2 = structuredClone(f.event); ev2.id = 7002; ev2.content = "how do I finish?";
  f.relay._state; // same relay instance
  const g = fixture({ turnText: "Open the setup form, then tap Continue setup here." });
  // reuse f's relay by replaying through it with a plain-evidence inspect: emulate by direct call on f
  f.seldon.inspectTurn = async () => ({ known: true, currentTurnVerified: true, escalated: false, toolCalls: [], toolResults: [] });
  f.seldon.turn = async () => ({ ok: true, text: "Open the setup form, then tap Continue setup here.", conversationId: "sf-conv", conversationCapability: "visitor-bound-capability" });
  await f.relay.accept(ev2).done;
  const pub = f.posted.filter((m) => !m.private);
  assert.equal(pub.length, 2);
  assert.deepEqual(pub[1].items, choices);
  // CONTROL: a reply that names no button stays without buttons
  f.seldon.turn = async () => ({ ok: true, text: "You're welcome!", conversationId: "sf-conv", conversationCapability: "visitor-bound-capability" });
  const ev3 = structuredClone(f.event); ev3.id = 7003; ev3.content = "thanks";
  await f.relay.accept(ev3).done;
  assert.equal(f.posted.filter((m) => !m.private)[2].items, null);
  void g;
});

// rc10j (measured live 2026-10-12): the rotated turn sent the CARRIED message but the signed relay context bound sha256(ev.content); Uplink answered 403 invalid_channel_context.
test("rc10j: rotated turn with carry-over - the relay context binds the message actually SENT (verifies with the real verifier)", async () => {
  const lim = { ok: false, reason: "http_503", error: "PUBLIC_CHAT_CONVERSATION_LIMIT", conversationId: null };
  const f = fixture({ turnSeq: [lim] });
  f.chatwoot.listMessages = async () => ({ payload: [
    { id: 6990, message_type: 0, private: false, content: "I am planning to call my sister tomorrow." },
    { id: 6991, message_type: 1, private: false, content: "Lovely, enjoy." },
  ] });
  await run(f);
  assert.equal(f.seldon.turnInputs.length, 2);
  const rotated = f.seldon.turnInputs[1];
  assert.match(rotated.message, /Earlier in this same WhatsApp chat/);
  assert.notEqual(rotated.message, f.event.content);
  const expected = (message) => ({
    accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug,
    sessionId: rotated.sessionId, uplinkConversationId: null, chatwootConversationId: "41", chatwootMessageId: "7001",
    messageSha256: createHash("sha256").update(message).digest("hex"),
  });
  const ok = verifyRelayContext(rotated.relayContext, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: expected(rotated.message) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // CONTROL: the pre-rc10j shape (context signed over the ORIGINAL text) is refused by the same verifier, so this test can fail.
  const old = verifyRelayContext(rotated.relayContext, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: expected(f.event.content) });
  assert.equal(old.ok, false);
  assert.equal(old.reason, "binding_mismatch:messageSha256");
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// rc10k (2026-10-12): a rotation keeps the PREVIOUS binding until Uplink ACCEPTS the rotated request. Live evidence: a refused rotated turn (403) overwrote the binding with
// a null conversation, orphaning the old Uplink conversation and silently dropping carry-over on the next message. States: ready -> (503) rotating{messageId, sessionId}
// with the previous conversation id/capability preserved -> ready(new) on acceptance | ready(previous) on a definitive refusal | rotating kept on an ambiguous timeout.
import { openConversationBinding, CONVERSATION_BINDING_ATTRIBUTE } from "../src/conversation-binding.js";
const STATE_KEY = "synthetic-state-key-material-long-enough-32";
const LIMIT503 = { ok: false, reason: "http_503", error: "PUBLIC_CHAT_CONVERSATION_LIMIT", conversationId: null };
const ACCEPTED = (n) => ({ ok: true, text: `rotated reply ${n}`, conversationId: `sf-conv-${n}`, conversationCapability: `cap-${n}` });
const storedBinding = async (f) => openConversationBinding((await f.chatwoot.getConversation(41)).custom_attributes[CONVERSATION_BINDING_ATTRIBUTE], STATE_KEY);
const messageFor = (f, id, content) => ({ ...f.event, id, content });
function restart(f) {   // a NEW relay process over the same Chatwoot state (all in-memory dedup and caches are lost)
  return createRelay({
    scope: SCOPE, ownerUserId: 16, escalationTeamId: 8, chatwoot: f.chatwoot, seldon: f.seldon, requireCapability: true, conversationStateKey: STATE_KEY,
    plConcierge: { key: KEY, kid: "uat1", bridgeKey: BRIDGE_KEY, bridgeKid: "ctx1", phoneNumberId: "1023804347491554", resolveConfirmation: undefined }, now: () => NOW,
  });
}
async function primed() {   // one ordinary turn first, so the binding holds an OLD Uplink conversation (sf-conv / visitor-bound-capability)
  const seq = [];
  const f = fixture({ turnSeq: seq });
  f.chatwoot.listMessages = async () => ({ payload: [{ id: 6990, message_type: 0, private: false, content: "I am planning to call my sister tomorrow." }, { id: 6991, message_type: 1, private: false, content: "Lovely, enjoy." }] });
  await run(f);
  assert.equal((await storedBinding(f)).conversationId, "sf-conv");
  return { f, seq };
}
const publicReplies = (f) => f.posted.filter((m) => !m.private).map((m) => m.content);

test("rc10k accepted rotation (positive control): bound to the NEW conversation only after Uplink accepts; one reply; marker cleared", async () => {
  const { f, seq } = await primed();
  seq.push(LIMIT503, ACCEPTED(2));
  await run(f, messageFor(f, 7002, "What was I planning to do tomorrow?"));
  const b = await storedBinding(f);
  assert.equal(b.conversationId, "sf-conv-2"); assert.equal(b.conversationCapability, "cap-2"); assert.equal(b.phase, "ready"); assert.equal(b.rotation, undefined);
  assert.equal(f.seldon.turnInputs[1].conversationId, "sf-conv");        // the old conversation was tried first
  assert.equal(f.seldon.turnInputs[2].conversationId, null);
  assert.match(f.seldon.turnInputs[2].message, /Earlier in this same WhatsApp chat/);
  assert.ok(publicReplies(f).includes("rotated reply 2"));
  assert.equal(handedOff(f), false);
});

test("rc10k definitive refusal: the OLD binding is kept exactly, handoff only; control: the next message rotates from that preserved binding and succeeds", async () => {
  const { f, seq } = await primed();
  seq.push(LIMIT503, { ok: false, reason: "http_403", error: "invalid_channel_context", conversationId: null });
  await run(f, messageFor(f, 7002, "What was I planning to do tomorrow?"));
  const kept = await storedBinding(f);
  assert.equal(kept.conversationId, "sf-conv"); assert.equal(kept.conversationCapability, "visitor-bound-capability"); assert.equal(kept.phase, "ready"); assert.equal(kept.rotation, undefined);
  assert.equal(handedOff(f), true);
  assert.equal(publicReplies(f).some((t) => /rotated reply/.test(t)), false);
  // positive control in the same harness: the preserved binding is usable
  seq.push(LIMIT503, ACCEPTED(3));
  const before = f.seldon.turnInputs.length;
  await run(f, messageFor(f, 7003, "Hello again"));
  assert.equal(f.seldon.turnInputs[before].conversationId, "sf-conv");   // went to the PRESERVED old conversation (it is at the limit, so it rotated again)
  assert.equal((await storedBinding(f)).conversationId, "sf-conv-3");
});

test("rc10k timeout after possible acceptance: marker kept, previous binding preserved, nothing retried; the SAME message after a restart is a duplicate (no second turn); control: another message proceeds", async () => {
  const { f, seq } = await primed();
  seq.push(LIMIT503, { ok: false, reason: "timeout", conversationId: null });
  await run(f, messageFor(f, 7002, "What was I planning to do tomorrow?"));
  const marker = await storedBinding(f);
  assert.equal(marker.phase, "rotating"); assert.equal(marker.rotation.messageId, 7002);
  assert.equal(marker.conversationId, "sf-conv"); assert.equal(marker.conversationCapability, "visitor-bound-capability");
  assert.equal(handedOff(f), true);
  const turnsAfterAmbiguous = f.seldon.turnInputs.length;                       // 3: first turn, old-conversation attempt, the rotated attempt
  // restart (memory lost) and the SAME message is delivered again: never blindly retried
  const r2 = restart(f); await r2.accept(messageFor(f, 7002, "What was I planning to do tomorrow?")).done;
  assert.equal(f.seldon.turnInputs.length, turnsAfterAmbiguous);
  assert.equal((await storedBinding(f)).conversationId, "sf-conv");           // not replaced
  // positive control: a DIFFERENT message continues from the preserved binding and rotates successfully
  seq.push(LIMIT503, ACCEPTED(4));
  await r2.accept(messageFor(f, 7004, "Are you there?")).done;
  assert.equal(f.seldon.turnInputs[turnsAfterAmbiguous].conversationId, "sf-conv");
  assert.equal((await storedBinding(f)).conversationId, "sf-conv-4");
});

test("rc10k restart after an ACCEPTED rotation: the duplicate of the completed message is ignored (no extra turn); the next message continues on the NEW conversation (control)", async () => {
  const { f, seq } = await primed();
  seq.push(LIMIT503, ACCEPTED(5));
  await run(f, messageFor(f, 7005, "What was I planning to do tomorrow?"));
  const turns = f.seldon.turnInputs.length;
  const r2 = restart(f); await r2.accept(messageFor(f, 7005, "What was I planning to do tomorrow?")).done;
  assert.equal(f.seldon.turnInputs.length, turns);
  assert.equal(publicReplies(f).filter((t) => t === "rotated reply 5").length, 1);
  await r2.accept(messageFor(f, 7006, "thanks")).done;
  assert.equal(f.seldon.turnInputs[turns].conversationId, "sf-conv-5");
});

test("rc10k duplicate delivery of the same webhook during one process: exactly one rotated turn and one reply", async () => {
  const { f, seq } = await primed();
  seq.push(LIMIT503, ACCEPTED(6));
  const ev = messageFor(f, 7007, "What was I planning to do tomorrow?");
  const a = f.relay.accept(ev), b = f.relay.accept(ev);
  await Promise.all([a.done, b.done]);
  assert.equal(f.seldon.turnInputs.filter((t) => t.conversationId === null && /Earlier in this same WhatsApp chat/.test(t.message)).length, 1);
  assert.equal(publicReplies(f).filter((t) => t === "rotated reply 6").length, 1);
});

test("rc10k an accepted turn whose reply is unusable (empty text) still binds the new conversation (it exists in Uplink and holds the spend)", async () => {
  const { f, seq } = await primed();
  seq.push(LIMIT503, { ok: false, reason: "empty_reply", conversationId: "sf-conv-7", conversationCapability: "cap-7" });
  await run(f, messageFor(f, 7008, "What was I planning to do tomorrow?"));
  const b = await storedBinding(f);
  assert.equal(b.conversationId, "sf-conv-7"); assert.equal(b.phase, "ready");
  assert.equal(handedOff(f), true);
});

// rc10k: the adapter binds the exact CHATWOOT message (sha256 of what the customer wrote) while Uplink binds the text it RECEIVES (the carry-over framing on a rotated turn).
// The signed context therefore carries BOTH hashes on a rotated turn: messageSha256 (sent text, for Uplink) and originalMessageSha256 (the customer's own message, for the adapter).
const payloadOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
test("rc10k rotated turn: context carries messageSha256 of the sent text AND originalMessageSha256 of the customer's message; an ordinary turn carries no original hash (control)", async () => {
  const { f, seq } = await primed();
  const ordinary = payloadOf(f.seldon.turnInputs[0].relayContext);
  assert.equal(ordinary.originalMessageSha256, undefined);
  assert.equal(ordinary.messageSha256, createHash("sha256").update(f.event.content).digest("hex"));
  seq.push(LIMIT503, ACCEPTED(8));
  const q = "What was I planning to do tomorrow?";
  await run(f, messageFor(f, 7009, q));
  const rotated = f.seldon.turnInputs[2];
  const claims = payloadOf(rotated.relayContext);
  assert.equal(claims.messageSha256, createHash("sha256").update(rotated.message).digest("hex"));
  assert.equal(claims.originalMessageSha256, createHash("sha256").update(q).digest("hex"));
  assert.notEqual(claims.messageSha256, claims.originalMessageSha256);
  const ok = verifyRelayContext(rotated.relayContext, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: { accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug, sessionId: rotated.sessionId, uplinkConversationId: null, chatwootConversationId: "41", chatwootMessageId: "7009", messageSha256: claims.messageSha256 } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// rc10l (2026-10-12): the tool-markup retry follows the rotation's rule - the previous binding survives until the retry is ACCEPTED, and the retry carries a context signed for ITS OWN session.
// Reproduced in the isolated acceptance harness against the REAL Uplink verifier: the pre-rc10l retry reused the old context (old session) -> 403 invalid_channel_context -> handoff, and the
// replaced (null) binding made the next message start a fresh Uplink conversation without carry-over.
const MARKUP = { ok: true, text: '<invoke name="pl_journey"></invoke>', conversationId: "sf-conv", conversationCapability: "visitor-bound-capability" };
test("rc10l tool-markup retry (positive control): the retry context verifies with the real verifier for the retry session; new conversation bound only after acceptance", async () => {
  const { f, seq } = await primed();
  seq.push(MARKUP, ACCEPTED(11));
  await run(f, messageFor(f, 7011, "What was I planning to do tomorrow?"));
  const retry = f.seldon.turnInputs[f.seldon.turnInputs.length - 1];
  assert.equal(retry.conversationId, null);
  const v = verifyRelayContext(retry.relayContext, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: {
    accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug, sessionId: retry.sessionId, uplinkConversationId: null,
    chatwootConversationId: "41", chatwootMessageId: "7011", messageSha256: createHash("sha256").update("What was I planning to do tomorrow?").digest("hex") } });
  assert.equal(v.ok, true, JSON.stringify(v));
  // CONTROL: the pre-rc10l shape (context of the OLD session) is refused by the same verifier, so this test can fail.
  const stale = f.seldon.turnInputs[f.seldon.turnInputs.length - 2].relayContext;
  const old = verifyRelayContext(stale, { keys: { ctx1: BRIDGE_KEY }, nowSec: Math.floor(NOW / 1000), expected: {
    accountId: 2, inboxId: 11, workspaceId: SCOPE.workspaceId, agentId: SCOPE.agentId, agentSlug: SCOPE.agentSlug, sessionId: retry.sessionId, uplinkConversationId: null,
    chatwootConversationId: "41", chatwootMessageId: "7011", messageSha256: createHash("sha256").update("What was I planning to do tomorrow?").digest("hex") } });
  assert.equal(old.ok, false);
  const b = await storedBinding(f);
  assert.equal(b.conversationId, "sf-conv-11"); assert.equal(b.phase, "ready"); assert.equal(b.rotation, undefined);
  assert.equal(handedOff(f), false);
});

test("rc10l tool-markup retry refused: the previous binding is kept, handoff only; control: the next message continues on the preserved conversation", async () => {
  const { f, seq } = await primed();
  seq.push(MARKUP, { ok: false, reason: "http_403", error: "invalid_channel_context", conversationId: null });
  await run(f, messageFor(f, 7012, "What was I planning to do tomorrow?"));
  const kept = await storedBinding(f);
  assert.equal(kept.conversationId, "sf-conv"); assert.equal(kept.conversationCapability, "visitor-bound-capability"); assert.equal(kept.phase, "ready"); assert.equal(kept.rotation, undefined);
  assert.equal(handedOff(f), true);
  const before = f.seldon.turnInputs.length;
  seq.push(ACCEPTED(12));
  await run(f, messageFor(f, 7013, "Hello again"));
  assert.equal(f.seldon.turnInputs[before].conversationId, "sf-conv");   // the preserved conversation, not a fresh orphan
});

test("rc10l tool-markup retry timeout: marker kept with the previous binding; the same message after a restart is a duplicate (no second retry)", async () => {
  const { f, seq } = await primed();
  seq.push(MARKUP, { ok: false, reason: "timeout", conversationId: null });
  await run(f, messageFor(f, 7014, "What was I planning to do tomorrow?"));
  const marker = await storedBinding(f);
  assert.equal(marker.phase, "rotating"); assert.equal(marker.conversationId, "sf-conv");
  const turns = f.seldon.turnInputs.length;
  const r2 = restart(f); await r2.accept(messageFor(f, 7014, "What was I planning to do tomorrow?")).done;
  assert.equal(f.seldon.turnInputs.length, turns);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2026-10-15 live (Chatwoot conv 528): Uplink's continuation capability expires after 24 h (PUBLIC_CONVERSATION_CAPABILITY_TTL_SECONDS). A customer who
// came back after 31 h got 404 conversation_not_found and an instant handoff. An expired CONTINUATION now rotates exactly like the turn limit.
const EXPIRED404 = { ok: false, reason: "http_404", error: "conversation_not_found", conversationId: null };
test("expired continuation (404 conversation_not_found on an existing binding) -> ONE fresh Uplink conversation with carry-over, reply posted, no handoff", async () => {
  const { f, seq } = await primed();
  seq.push(EXPIRED404, ACCEPTED(4));
  await run(f, messageFor(f, 7004, "Can I port my flow number in?"));
  assert.equal(f.seldon.turnInputs[1].conversationId, "sf-conv", "the old conversation was tried first");
  assert.equal(f.seldon.turnInputs[2].conversationId, null, "then a fresh one");
  assert.match(f.seldon.turnInputs[2].message, /Earlier in this same WhatsApp chat/);
  assert.ok(publicReplies(f).includes("rotated reply 4"));
  assert.equal(handedOff(f), false);
  const b = await storedBinding(f);
  assert.equal(b.conversationId, "sf-conv-4"); assert.equal(b.phase, "ready");
});
test("expired-continuation CONTROLS: a 404 with no binding to continue, or a different 404 error, still hands off with no retry", async () => {
  const fresh = fixture({ turnSeq: [EXPIRED404] });
  fresh.chatwoot.listMessages = async () => ({ payload: [] });
  await run(fresh);
  assert.equal(fresh.seldon.turnInputs.length, 1, "a brand-new conversation's 404 is not rotated");
  assert.equal(handedOff(fresh), true);
  const { f, seq } = await primed();
  seq.push({ ok: false, reason: "http_404", error: "agent_not_found", conversationId: null });
  const before = f.seldon.turnInputs.length;
  await run(f, messageFor(f, 7005, "hello"));
  assert.equal(f.seldon.turnInputs.length, before + 1, "agent_not_found is not a continuation expiry: no rotation");
  assert.equal(handedOff(f), true);
});
