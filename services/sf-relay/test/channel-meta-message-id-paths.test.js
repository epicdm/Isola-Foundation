// Patch B, the NON-first call sites (Codex delta review, 2026-10-19): the tool-markup retry and the Uplink rotation must send the same
// channel_meta.message_id as the first turn (and the id the signed context binds) when enabled, and the deployed shape when not.
// The guided-rewrite call site is covered in war-room.test.js (it needs the supervised-hold harness).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../src/relay.js";

const SCOPE = { accountId: 2, inboxId: 18, workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "pl-staging-test-agent" };
const CONTACT = { payload: { id: 541, phone_number: "+17670000000", contact_inboxes: [{ source_id: "17679990018", inbox: { id: 18, channel_type: "Channel::Whatsapp", provider: "whatsapp_cloud" } }] } };
const SHAPE = { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41 };

function fixture({ metaId, turnSeq }) {
  const row = { id: 41, account_id: 2, inbox_id: 18, status: "pending", custom_attributes: {}, meta: { channel: "Channel::Whatsapp", sender: { id: 541 }, assignee: { id: 16 } } };
  const chatwoot = {
    async getConversation() { return structuredClone(row); }, async getContact() { return structuredClone(CONTACT); },
    async listMessages() { return { payload: [] }; },
    async updateConversationCustomAttributes(id, v) { Object.assign(row.custom_attributes, v); return { custom_attributes: structuredClone(row.custom_attributes) }; },
    async postMessage() {}, async toggleStatus() {}, async assignOwner() {}, async assignTeam() {},
  };
  const seldon = {
    turnInputs: [],
    async turn(input) { seldon.turnInputs.push(input); return turnSeq.length ? turnSeq.shift() : { ok: true, text: "ok", conversationId: "sf-x", conversationCapability: "cap-x" }; },
    async escalation() { return { known: true, escalated: false }; },
    async inspectTurn() { return { known: true, currentTurnVerified: true, escalated: false, toolCalls: [], toolResults: [] }; },
  };
  const relay = createRelay({ channelMetaMessageId: metaId, scope: SCOPE, ownerUserId: 16, escalationTeamId: 8, chatwoot, seldon,
    requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32",
    plConcierge: { key: "synthetic-pl-assertion-key-material-32-bytes-minimum", kid: "uat1", bridgeKey: "synthetic-test-route-context-key-material-32-bytes", bridgeKid: "ctxtest1", phoneNumberId: "1100000000000018", inboxId: 18 },
    now: () => 1_797_000_000_000 });
  return { relay, seldon };
}
const event = { event: "message_created", id: 7001, content: "What stage is my line at?", message_type: "incoming", private: false,
  sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: 18 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } } };
const claims = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));

const PATHS = {
  "tool-markup retry": () => [{ ok: true, text: "<invoke name=\"pl_journey\"></invoke>", conversationId: "sf-1", conversationCapability: "cap-1" }],
  "Uplink rotation (turn limit)": () => [{ ok: false, reason: "http_503", error: "PUBLIC_CHAT_CONVERSATION_LIMIT", conversationId: null }],
};

for (const [name, seq] of Object.entries(PATHS)) {
  test(`${name}: enabled -> BOTH turns carry message_id, equal to the signed context's chatwootMessageId`, async () => {
    const f = fixture({ metaId: true, turnSeq: seq() });
    await f.relay.accept(event).done;
    assert.equal(f.seldon.turnInputs.length, 2, "the path was actually taken (a second turn was sent)");
    for (const input of f.seldon.turnInputs) {
      assert.deepEqual(input.channelMeta, { ...SHAPE, message_id: "7001" });
      assert.equal(typeof input.relayContext, "string");
      assert.equal(claims(input.relayContext).chatwootMessageId, input.channelMeta.message_id);
    }
    assert.notEqual(f.seldon.turnInputs[1].sessionId, f.seldon.turnInputs[0].sessionId, "the second turn is the retry/rotation, on its own session");
  });
  test(`${name}: disabled (CONTROL) -> both turns carry the deployed shape`, async () => {
    const f = fixture({ metaId: false, turnSeq: seq() });
    await f.relay.accept(event).done;
    assert.equal(f.seldon.turnInputs.length, 2);
    for (const input of f.seldon.turnInputs) assert.deepEqual(input.channelMeta, SHAPE);
  });
}
