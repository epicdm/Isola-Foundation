// Patch B through the REAL entry point (server.js): RELAY_CHANNEL_META_MESSAGE_ID=1 is what turns channel_meta.message_id on.
// A child-process relay receives a SIGNED Chatwoot webhook; a local stub plays Chatwoot and the gateway and records the turn request
// exactly as it arrives on the wire. Off (unset, or any value other than "1") must leave channel_meta in the deployed shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
const BOT_SECRET = "synthetic-bot-secret-material";
const IDENTITY = { workspaceId: "48467787-a471-4260-8265-a9893e2b2cae", agentId: "4c47c17f-f26a-46a7-a2e4-aa6f58a305b6", agentSlug: "pl-staging-test-agent" };

const freePort = () => new Promise((resolve) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function stub() {
  const turns = [];
  const row = { id: 41, account_id: 2, inbox_id: 18, status: "pending", custom_attributes: {}, meta: { channel: "Channel::Whatsapp", sender: { id: 541 }, assignee: null } };
  const contact = { payload: { id: 541, phone_number: "+17670000000", contact_inboxes: [{ source_id: "17679990018", inbox: { id: 18, channel_type: "Channel::Whatsapp", provider: "whatsapp_cloud" } }] } };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const u = req.url;
    if (req.method === "POST" && /\/api\/v1\/public\/agent\/[^/]+\/turn$/.test(u)) {
      turns.push({ headers: req.headers, body: JSON.parse(raw) });
      return json(200, { message: "ok", conversation_id: "sf-conv", conversation_capability: "visitor-bound-capability" });
    }
    if (req.method === "POST" && u === "/api/v1/agents") return json(404, {});
    if (req.method === "GET" && u === "/api/v1/accounts/2/conversations/41") return json(200, row);
    if (req.method === "GET" && u === "/api/v1/accounts/2/contacts/541") return json(200, contact);
    if (req.method === "POST" && u === "/api/v1/accounts/2/conversations/41/custom_attributes") { Object.assign(row.custom_attributes, JSON.parse(raw).custom_attributes); return json(200, { custom_attributes: row.custom_attributes }); }
    if (req.method === "POST" && u.startsWith("/api/v1/accounts/2/conversations/41/")) return json(200, {});
    return json(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, turns, base: `http://127.0.0.1:${server.address().port}` })));
}

async function runOnce(flag) {
  const s = await stub();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "relay-msgid-"));
  const file = (n, v) => { const p = join(dir, n); writeFileSync(p, v); return p; };
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port),
    CHATWOOT_ACCOUNT_ID: "2", CHATWOOT_INBOX_ID: "18", CHATWOOT_BASE_URL: s.base, CHATWOOT_ESCALATION_TEAM_ID: "8",
    CHATWOOT_BOT_SECRET_FILE: file("bot-secret", BOT_SECRET), CHATWOOT_BOT_TOKEN_FILE: file("bot-token", "synthetic-bot-token"),
    SF_BASE_URL: s.base, SF_AGENT_SLUG: IDENTITY.agentSlug, SF_AGENT_ID: IDENTITY.agentId, SF_WORKSPACE_ID: IDENTITY.workspaceId,
    SF_TOKEN_FILE: file("sf-token", "synthetic-readback-token"), SF_REQUIRE_CONVERSATION_CAPABILITY: "1", SF_ESCALATION_READBACK_ENABLED: "1",
    SF_CONVERSATION_STATE_KEY_FILE: file("state-key", "synthetic-state-key-material-long-enough-32"),
    PL_CONCIERGE_ASSERTIONS_ENABLED: "1", PL_CONCIERGE_INBOX_ID: "18",
    PL_CONCIERGE_ASSERTION_KEY_FILE: file("pl-key", "synthetic-pl-assertion-key-material-32-bytes-minimum"), PL_CONCIERGE_ASSERTION_KID: "pl2",
    PL_CONCIERGE_CONTEXT_KEY_FILE: file("ctx-key", "synthetic-test-route-context-key-material-32-bytes"), PL_CONCIERGE_CONTEXT_KID: "ctxtest1",
    PL_CONCIERGE_PHONE_NUMBER_ID: "1100000000000018",
    ...(flag === undefined ? {} : { RELAY_CHANNEL_META_MESSAGE_ID: flag }),
  };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  try {
    for (let i = 0; i < 100 && !out.includes('"event":"boot"'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(out.includes('"event":"boot"'), out);
    const raw = JSON.stringify({ event: "message_created", id: 7001, content: "What stage is my line at?", message_type: "incoming", private: false,
      sender: { type: "contact", id: 541 }, account: { id: 2 }, inbox: { id: 18 }, conversation: { id: 41, status: "pending", meta: { sender: { id: 541 } } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = "sha256=" + createHmac("sha256", BOT_SECRET).update(`${ts}.`).update(raw).digest("hex");
    const r = await fetch(`http://127.0.0.1:${port}/v1/chatwoot/agent-bot`, { method: "POST", headers: { "content-type": "application/json", "x-chatwoot-timestamp": ts, "x-chatwoot-signature": sig }, body: raw });
    assert.equal(r.status, 200);
    for (let i = 0; i < 100 && s.turns.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(s.turns.length, 1, out);
    return s.turns[0];
  } finally {
    child.kill(); s.server.close(); rmSync(dir, { recursive: true, force: true });
  }
}

const SHAPE = { source: "chatwoot", account_id: 2, inbox_id: 18, conversation_id: 41 };

test("entry point: RELAY_CHANNEL_META_MESSAGE_ID=1 puts the Chatwoot message id in channel_meta on the wire, beside the signed context header", async () => {
  const t = await runOnce("1");
  assert.deepEqual(t.body.channel_meta, { ...SHAPE, message_id: "7001" });
  assert.equal(typeof t.headers["x-isola-relay-context"], "string");
  const claims = JSON.parse(Buffer.from(t.headers["x-isola-relay-context"].split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.chatwootMessageId, t.body.channel_meta.message_id); // the unsigned convenience field equals the signed binding
  assert.equal(claims.inboxId, 18);
});

test("entry point: unset or any value other than \"1\" leaves channel_meta in the deployed shape (CONTROL for the test above)", async () => {
  for (const flag of [undefined, "0", "true", ""]) {
    const t = await runOnce(flag);
    assert.deepEqual(t.body.channel_meta, SHAPE, String(flag));
    assert.equal(typeof t.headers["x-isola-relay-context"], "string");
  }
});
