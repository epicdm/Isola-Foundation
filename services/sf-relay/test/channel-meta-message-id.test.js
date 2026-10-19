import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../src/relay.js";

// Patch B: channel_meta carries the Chatwoot message id only when explicitly enabled; default output is byte-identical to the deployed relay.
const WORKSPACE = "48467787-a471-4260-8265-a9893e2b2cae", AGENT = "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6";

async function turnMeta(extra) {
  const turns = [];
  const row = { id: 41, account_id: 2, inbox_id: 18, status: "pending", custom_attributes: {}, meta: { channel: "Channel::Whatsapp", sender: { id: 541 }, assignee: { id: 16 } } };
  const chatwoot = { async getConversation() { return structuredClone(row); }, async getContact() { return {}; }, async updateConversationCustomAttributes(i, v) { Object.assign(row.custom_attributes, v); return { custom_attributes: { ...row.custom_attributes } }; },
    async postMessage() {}, async toggleStatus() {}, async assignOwner() {}, async assignTeam() {} };
  const seldon = { async turn(i) { turns.push(i); return { ok: true, text: "ok", conversationId: "sf", conversationCapability: "cap" }; }, async escalation() { return { known: true, escalated: false }; } };
  const relay = createRelay({ scope: { accountId: 2, inboxId: 18, workspaceId: WORKSPACE, agentId: AGENT, agentSlug: "pl-test" }, ownerUserId: 16, escalationTeamId: 8, chatwoot, seldon,
    requireCapability: true, conversationStateKey: "synthetic-state-key-material-long-enough-32", now: () => 1_797_000_000_000, ...extra });
  await relay.accept({ event: "message_created", id: 7001, content: "hello", message_type: "incoming", private: false, sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: 18 },
    conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } } }).done;
  return turns[0]?.channelMeta;
}

test("default: channel_meta is exactly the deployed shape (no message_id)", async () => {
  assert.deepEqual(await turnMeta({}), { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41 });
  assert.deepEqual(await turnMeta({ channelMetaMessageId: false }), { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41 });
  assert.deepEqual(await turnMeta({ channelMetaMessageId: "1" }), { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41 });      // only boolean true enables
});

test("enabled: message_id is the Chatwoot message id as a digit string", async () => {
  assert.deepEqual(await turnMeta({ channelMetaMessageId: true }), { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41, message_id: "7001" });
});
