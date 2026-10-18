import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../src/relay.js";
import { seldonClient } from "../src/clients.js";
import { validateCapabilityConfig } from "../src/server.js";
import { CONVERSATION_BINDING_ATTRIBUTE } from "../src/conversation-binding.js";

const CHATWOOT = { accountId: 2, inboxId: 11 };
const UPLINK = {
  ...CHATWOOT,
  workspaceId: "48467787-a471-4260-8265-a9893e2b2cae",
  agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6",
  agentSlug: "uplinks-workspace-4816--default",
};
const STATE_KEY = "synthetic-only-state-key-material-32-bytes-minimum";
const CONVERSATION_A = "10000000-0000-4000-8000-000000000041";
const CONVERSATION_B = "10000000-0000-4000-8000-000000000042";
const CAPABILITY_A = "synthetic-signed-capability-A";

function event({ id, conv = 41, content = "Tell me about the Week Pass.", status = "pending" }) {
  return {
    event: "message_created", id, content, message_type: "incoming", private: false,
    sender: { type: "contact", id: 541 }, account: { id: CHATWOOT.accountId }, inbox: { id: CHATWOOT.inboxId },
    conversation: { id: conv, status, meta: { sender: { id: 541 } } },
  };
}

function makeChatwoot() {
  const rows = new Map();
  const posts = [];
  const writes = [];
  const operations = [];
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, {
      id, account_id: CHATWOOT.accountId, inbox_id: CHATWOOT.inboxId, status: "pending",
      custom_attributes: {}, meta: { sender: { id: 541 } },
    });
    return rows.get(id);
  };
  return {
    rows, posts, writes, operations,
    async getConversation(id) { operations.push({ op: "read", id }); return structuredClone(row(id)); },
    async updateConversationCustomAttributes(id, values) {
      const target = row(id);
      Object.assign(target.custom_attributes, values);
      writes.push({ id, ...structuredClone(values) });
      operations.push({ op: "attributes", id });
      return { custom_attributes: structuredClone(target.custom_attributes) };
    },
    async postMessage(id, content, { private: isPrivate }) {
      posts.push({ id, content, private: isPrivate });
      operations.push({ op: "message", id, private: isPrivate });
    },
    async toggleStatus(id, status) {
      const target = row(id);
      target.status = status;
      operations.push({ op: "status", id, status });
      if (status === "open") target.meta.assignee = { id: 5, type: "user" };
    },
    async assignOwner(id, userId) { row(id).meta.assignee = { id: userId, type: "user" }; },
    async assignTeam(id, teamId) { row(id).meta.team = { id: teamId }; operations.push({ op: "team", id, teamId }); },
  };
}

function makeNativeClient({ fetchImpl, slug = UPLINK.agentSlug } = {}) {
  return seldonClient({
    baseUrl: "https://uplink.epic.dm",
    slug,
    workspaceId: UPLINK.workspaceId,
    token: "synthetic-workspace-operator-token-never-used-on-wire-for-public-turn",
    fetchImpl,
    timeoutMs: 1000,
  });
}

function createFixture({ fetchImpl, scope = UPLINK, chatwoot = makeChatwoot(), ownerUserId = null } = {}) {
  const requests = [];
  const fetch = fetchImpl ?? (async (url, init) => {
    if (String(url).endsWith("/api/v1/agents")) return Response.json({ turns: [] });
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), headers: init.headers, body });
    const first = body.conversation_id == null;
    if (!first && (body.conversation_capability !== CAPABILITY_A || body.conversation_id !== CONVERSATION_A)) {
      return Response.json({ error: "conversation_not_found" }, { status: 404 });
    }
    return Response.json({
      conversation_id: first ? CONVERSATION_A : body.conversation_id,
      conversation_capability: CAPABILITY_A,
      message: first ? "Week Pass details." : "It includes the approved allowance.",
      validators_critical_failed: false,
    });
  });
  const logs = [];
  const relay = createRelay({
    scope,
    ownerUserId,
    escalationTeamId: 8,
    chatwoot,
    seldon: makeNativeClient({ fetchImpl: fetch }),
    requireCapability: true,
    conversationStateKey: STATE_KEY,
    logger: (entry) => logs.push(entry),
  });
  return { relay, chatwoot, requests, logs };
}

async function process(f, payload) {
  const result = f.relay.accept(payload);
  await result.done;
  return result;
}

test("Uplink multi-turn: signed capability, visitor session and native live agent stay bound to one Chatwoot conversation", async () => {
  const f = createFixture();
  await process(f, event({ id: 100 }));
  await process(f, event({ id: 101, content: "And what is included?" }));

  assert.equal(f.requests.length, 2, JSON.stringify(f.logs));
  assert.match(f.requests[0].url, /\/api\/v1\/public\/agent\/uplinks-workspace-4816--default\/turn$/);
  assert.equal(f.requests[0].body.conversation_id, undefined);
  assert.equal(f.requests[0].body.anonymous_session_id, "cw-chatwoot-2-41");
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(f.requests[0].headers["x-test-mode"], undefined);
  assert.equal(f.requests[1].body.conversation_id, CONVERSATION_A);
  assert.equal(f.requests[1].body.conversation_capability, CAPABILITY_A);
  assert.equal(f.requests[1].body.anonymous_session_id, "cw-chatwoot-2-41");
  assert.equal(f.chatwoot.posts.filter((x) => !x.private).length, 2);

  const envelope = f.chatwoot.rows.get(41).custom_attributes[CONVERSATION_BINDING_ATTRIBUTE];
  assert.equal(typeof envelope, "string");
  assert.equal(envelope.includes(CAPABILITY_A), false);
  assert.equal(envelope.includes(CONVERSATION_A), false);
});

test("encrypted binding copied to another Chatwoot conversation is rejected before inference", async () => {
  const f = createFixture();
  await process(f, event({ id: 200 }));
  f.chatwoot.rows.set(42, {
    ...structuredClone(f.chatwoot.rows.get(41)),
    id: 42,
  });
  await process(f, event({ id: 201, conv: 42, content: "Try to reuse the other conversation." }));
  assert.equal(f.requests.length, 1);
  assert.equal(f.chatwoot.posts.some((x) => /handoff/i.test(x.content) && x.private), true);
  assert.equal(f.logs.some((x) => x.event === "relay_error"), false);
});

test("wrong configured workspace/agent scope rejects the stored capability before inference", async () => {
  const cw = makeChatwoot();
  const f = createFixture({ chatwoot: cw });
  await process(f, event({ id: 300 }));
  const wrong = createFixture({
    chatwoot: cw,
    scope: { ...UPLINK, workspaceId: "other-workspace", agentSlug: "other-workspace--default" },
  });
  await process(wrong, event({ id: 301, content: "Cross-scope attempt." }));
  assert.equal(wrong.requests.length, 0);
  assert.equal(cw.posts.some((x) => /handoff/i.test(x.content) && x.private), true);
});

test("duplicate delivery is idempotent in-process and after relay restart", async () => {
  const chatwoot = makeChatwoot();
  const f = createFixture({ chatwoot });
  const payload = event({ id: 400 });
  await process(f, payload);
  await process(f, payload);
  assert.equal(f.requests.length, 1);

  const restarted = createFixture({ chatwoot });
  await process(restarted, payload);
  assert.equal(restarted.logs.some((x) => x.reason === "durable_duplicate"), true);
  assert.equal(restarted.requests.length, 0);
});

test("an ambiguous retry after a persisted processing marker does not call the model twice", async () => {
  const chatwoot = makeChatwoot();
  const failing = createFixture({ chatwoot, fetchImpl: async () => { throw new TypeError("synthetic network reset"); } });
  await process(failing, event({ id: 500 }));
  assert.equal(failing.requests.length, 0);
  const restarted = createFixture({ chatwoot });
  chatwoot.rows.get(41).status = "pending"; // customer retry after the relay restarted
  await process(restarted, event({ id: 500 }));
  assert.equal(restarted.requests.length, 0);
  assert.equal(chatwoot.posts.some((x) => x.private && /duplicate delivery/i.test(x.content)), true);
});

test("a later message after ambiguous outcome starts a fresh bound thread; a normal continuation keeps its binding", async () => {
  const chatwoot = makeChatwoot();
  const failing = createFixture({ chatwoot, fetchImpl: async () => { throw new TypeError("synthetic network reset"); } });
  await process(failing, event({ id: 600 }));
  chatwoot.rows.get(41).status = "pending"; // operator performed the existing human handback

  const retry = createFixture({ chatwoot });
  await process(retry, event({ id: 601, content: "I am back after speaking with the team." }));
  assert.equal(retry.requests.length, 1);
  assert.equal(retry.requests[0].body.conversation_id, undefined);
  assert.equal(retry.requests[0].body.anonymous_session_id, "cw-chatwoot-2-41-r601");
});

test("human takeover stays silent; explicit handoff uses existing assignment/readback; after handback the same bound thread resumes", async () => {
  const f = createFixture();
  await process(f, event({ id: 700 }));
  const before = f.requests.length;
  await process(f, event({ id: 701, content: "I want to speak to a person." }));
  assert.equal(f.chatwoot.rows.get(41).status, "open");
  assert.equal(f.chatwoot.rows.get(41).meta.team.id, 8);
  const ops = f.chatwoot.operations.map((x) => x.op);
  const teamIndex = ops.indexOf("team");
  const teamReadbackIndex = ops.findIndex((op, i) => op === "read" && i > teamIndex);
  const customerNoticeIndex = f.chatwoot.operations.findIndex((x, i) => i > teamReadbackIndex && x.op === "message" && x.private === false);
  assert.ok(teamIndex >= 0 && teamReadbackIndex > teamIndex && customerNoticeIndex > teamReadbackIndex);
  assert.match(f.chatwoot.posts.at(-1).content, /bring in a teammate/i);
  assert.equal(f.requests.length, before);

  await process(f, event({ id: 702, status: "open", content: "human is replying" }));
  assert.equal(f.requests.length, before);

  f.chatwoot.rows.get(41).status = "pending"; // existing Chatwoot Resolve/handback behavior
  await process(f, event({ id: 703, content: "Thanks, one more question." }));
  assert.equal(f.requests.length, before + 1);
  assert.equal(f.requests.at(-1).body.conversation_id, CONVERSATION_A);
  assert.equal(f.requests.at(-1).body.conversation_capability, CAPABILITY_A);
  assert.equal(f.requests.at(-1).body.anonymous_session_id, "cw-chatwoot-2-41");
});

test("strict signed-continuation mode permits no workspace token only when escalation readback is explicitly disabled", () => {
  assert.doesNotThrow(() => validateCapabilityConfig({
    workspaceId: UPLINK.workspaceId,
    agentId: UPLINK.agentId,
    conversationStateKey: STATE_KEY,
    escalationReadback: "0",
    sfToken: null,
  }));
  assert.throws(() => validateCapabilityConfig({
    workspaceId: UPLINK.workspaceId,
    agentId: UPLINK.agentId,
    conversationStateKey: STATE_KEY,
    escalationReadback: "1",
    sfToken: null,
  }), /SF_TOKEN_FILE_required_for_escalation_readback/);
});

test("strict mode refuses an omitted escalation-readback decision", () => {
  assert.throws(() => validateCapabilityConfig({
    workspaceId: UPLINK.workspaceId,
    conversationStateKey: STATE_KEY,
    escalationReadback: undefined,
    sfToken: null,
  }), /conversation_capability_configuration_incomplete/);
});

test("strict capability configuration requires the exact native agent UUID", () => {
  const config = { workspaceId: UPLINK.workspaceId, agentId: UPLINK.agentId, conversationStateKey: STATE_KEY, escalationReadback: "0", sfToken: null };
  assert.throws(() => validateCapabilityConfig({ ...config, agentId: undefined }), /conversation_capability_configuration_incomplete/);
  assert.throws(() => validateCapabilityConfig({ ...config, agentId: "another-agent" }), /conversation_capability_configuration_incomplete/);
});

test("missing capability persistence configuration fails at construction", () => {
  assert.throws(() => createRelay({
    scope: UPLINK,
    ownerUserId: 5,
    chatwoot: makeChatwoot(),
    seldon: makeNativeClient({ fetchImpl: async () => Response.json({}) }),
    requireCapability: true,
  }), /conversation_capability_configuration_incomplete/);
});
