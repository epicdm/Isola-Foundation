/**
 * HTTP entry point. Reads its configuration from the environment and its credentials from mounted secret FILES
 * (this is a standalone service: it reads its own files, no entrypoint shim). Values are never printed.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRelay, verifySignature } from "./relay.js";
import { adapterClient, chatwootClient, seldonClient, waPresenceClient } from "./clients.js";
import { parsePlConciergeInboxId, plConciergeIdentityValid, PL_CONCIERGE_DEFAULT_INBOX_ID } from "./pl-concierge-assertion.js";

const MAX_BODY = 256 * 1024;
const PATH = "/v1/chatwoot/agent-bot";

function readSecretFile(path) {
  const v = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  if (v.length === 0 || /\s/.test(v)) throw new Error("a secret file is empty or contains whitespace");
  return v;
}

export function createHandler({ secret, relay, logger, now = () => Date.now() }) {
  return async function handler(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
    if (req.method !== "POST" || req.url !== PATH) return send(404, { error: "not_found" });

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return send(413, { error: "too_large" });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks);
    const ok = verifySignature({
      secret,
      timestamp: req.headers["x-chatwoot-timestamp"],
      signature: req.headers["x-chatwoot-signature"],
      raw,
      nowSec: Math.floor(now() / 1000),
    });
    if (!ok) {
      logger({ event: "rejected", reason: "bad_signature" });
      return send(401, { error: "bad_signature" });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(400, { error: "bad_json" });
    }
    // ACK FIRST: Chatwoot gives a webhook 5 s; the model turn takes longer and runs after the response.
    const { outcome, reason, done } = relay.accept(payload);
    send(200, reason ? { outcome, reason } : { outcome });
    done.catch(() => {});
  };
}

export function validateCapabilityConfig({ workspaceId, agentId, conversationStateKey, escalationReadback, sfToken }) {
  if (!workspaceId || typeof agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)
    || typeof conversationStateKey !== "string" || conversationStateKey.length < 32
    || !["0", "1"].includes(escalationReadback)) {
    throw new Error("conversation_capability_configuration_incomplete");
  }
  if (escalationReadback === "1" && !sfToken) {
    throw new Error("SF_TOKEN_FILE_required_for_escalation_readback");
  }
}

/**
 * rc10g: the optional presence client. Returns null (presence disabled) - never throws - when the token file is not configured,
 * missing, empty, malformed, too short, or the phone-number id is invalid. Logs ONE redacted line: a fixed reason code, never a
 * path's contents, the token or an error message that could carry either.
 */
export function buildPresence({ env, logger, fallbackPhoneNumberId = null, readFile = readSecretFile, makeClient = waPresenceClient }) {
  if (!env.WA_PRESENCE_TOKEN_FILE) {
    logger({ event: "presence_config", enabled: false, reason: "not_configured" });
    return null;
  }
  let token;
  try {
    token = readFile(env.WA_PRESENCE_TOKEN_FILE);
  } catch (err) {
    const reason = err?.code === "ENOENT" ? "token_file_missing" : /empty or contains whitespace/.test(String(err?.message)) ? "token_file_malformed" : "token_file_unreadable";
    logger({ event: "presence_config", enabled: false, reason });
    return null;
  }
  try {
    const client = makeClient({ token, phoneNumberId: env.WA_PRESENCE_PHONE_NUMBER_ID ?? fallbackPhoneNumberId, graphVersion: env.WA_GRAPH_VERSION ?? "v21.0" });
    logger({ event: "presence_config", enabled: true, tokenLength: token.length });
    return client;
  } catch (err) {
    const reason = /token_invalid/.test(String(err?.message)) ? "token_invalid" : /phone_number_id/.test(String(err?.message)) ? "phone_number_id_invalid" : "client_rejected";
    logger({ event: "presence_config", enabled: false, reason });
    return null;
  }
}

/** War room: the relay's own Chatwoot user id, read once at boot. Null (and the hold OFF, logged) when it cannot be read - never boot-fatal. */
export async function resolveSelfUserId(chatwoot, logger = () => {}) {
  try {
    const p = await chatwoot.getProfile();
    if (Number.isSafeInteger(p?.id) && p.id > 0) return p.id;
  } catch { /* logged below */ }
  logger({ event: "config_ignored", key: "RELAY_SUPERVISED_HOLD_MS", reason: "the relay could not read its own Chatwoot user id; supervised hold is OFF" });
  return null;
}

/** War room: RELAY_SUPERVISED_HOLD_MS - unset/empty = 0 (off); a whole number 0..60000 = that hold; anything else = 0 with a logged warning. */
export function parseSupervisedHoldMs(raw, logger = () => {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
  const s = String(raw).trim();
  const n = /^\d{1,5}$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 60_000) {
    logger({ event: "config_ignored", key: "RELAY_SUPERVISED_HOLD_MS", reason: "not a whole number of ms between 0 and 60000; supervised hold is OFF" });
    return 0;
  }
  return n;
}

/**
 * allowedInboxId is PL_CONCIERGE_INBOX_ID (default 11). The relay's own CHATWOOT_INBOX_ID must equal it, so one setting can never
 * widen the other. The identity (workspace, UUID agent, slug) and the capability path are checked here so a deployment that could
 * only ever send context-less turns refuses to boot instead.
 */
export function validatePlAssertionConfig({ enabled, accountId, inboxId, allowedInboxId = PL_CONCIERGE_DEFAULT_INBOX_ID, key, kid, bridgeKey, bridgeKid, phoneNumberId, sfToken, identity, requireCapability }) {
  if (!enabled) return;
  if (!Number.isSafeInteger(allowedInboxId) || allowedInboxId <= 0) throw new Error("PL_CONCIERGE_INBOX_ID_invalid");
  if (accountId !== 2 || inboxId !== allowedInboxId) throw new Error(`pl_concierge_assertions_are_scoped_to_account2_inbox${allowedInboxId}`);
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) throw new Error("PL_CONCIERGE_ASSERTION_KEY_FILE_required");
  if (typeof kid !== "string" || !/^[a-z0-9]{1,16}$/.test(kid)) throw new Error("PL_CONCIERGE_ASSERTION_KID_invalid");
  if (typeof bridgeKey !== "string" || Buffer.byteLength(bridgeKey, "utf8") < 32) throw new Error("PL_CONCIERGE_CONTEXT_KEY_FILE_required");
  if (typeof bridgeKid !== "string" || !/^[a-z0-9]{1,16}$/.test(bridgeKid)) throw new Error("PL_CONCIERGE_CONTEXT_KID_invalid");
  if (typeof phoneNumberId !== "string" || !/^[0-9]{5,20}$/.test(phoneNumberId)) throw new Error("PL_CONCIERGE_PHONE_NUMBER_ID_invalid");
  if (!sfToken) throw new Error("SF_TOKEN_FILE_required_for_pl_offer_readback");
  if (requireCapability !== true) throw new Error("PL_CONCIERGE_ASSERTIONS_require_SF_REQUIRE_CONVERSATION_CAPABILITY");
  if (!plConciergeIdentityValid(identity ?? {})) throw new Error("PL_CONCIERGE_identity_invalid_SF_WORKSPACE_ID_SF_AGENT_ID_SF_AGENT_SLUG");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const need = (k) => {
    if (!env[k]) throw new Error(`missing required environment variable ${k}`);
    return env[k];
  };
  const logger = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const accountId = Number(need("CHATWOOT_ACCOUNT_ID"));
  const inboxId = Number(need("CHATWOOT_INBOX_ID"));
  const secret = readSecretFile(need("CHATWOOT_BOT_SECRET_FILE"));
  const botToken = readSecretFile(need("CHATWOOT_BOT_TOKEN_FILE"));
  const sfToken = env.SF_TOKEN_FILE ? readSecretFile(env.SF_TOKEN_FILE) : null;
  const requireCapability = env.SF_REQUIRE_CONVERSATION_CAPABILITY === "1";
  const escalationReadback = env.SF_ESCALATION_READBACK_ENABLED;
  const workspaceId = env.SF_WORKSPACE_ID ?? null;
  const agentSlug = need("SF_AGENT_SLUG");
  const agentId = need("SF_AGENT_ID");
  const conversationStateKey = requireCapability
    ? readSecretFile(need("SF_CONVERSATION_STATE_KEY_FILE"))
    : null;
  if (requireCapability) validateCapabilityConfig({ workspaceId, agentId, conversationStateKey, escalationReadback, sfToken });
  const plAssertionsEnabled = env.PL_CONCIERGE_ASSERTIONS_ENABLED === "1";
  const plAssertionKey = plAssertionsEnabled ? readSecretFile(need("PL_CONCIERGE_ASSERTION_KEY_FILE")) : null;
  const plKid = plAssertionsEnabled ? need("PL_CONCIERGE_ASSERTION_KID") : null;
  const plContextKey = plAssertionsEnabled ? readSecretFile(need("PL_CONCIERGE_CONTEXT_KEY_FILE")) : null;
  const plContextKid = plAssertionsEnabled ? need("PL_CONCIERGE_CONTEXT_KID") : null;
  const plPhoneNumberId = plAssertionsEnabled ? need("PL_CONCIERGE_PHONE_NUMBER_ID") : null;
  const plInboxId = plAssertionsEnabled ? parsePlConciergeInboxId(env.PL_CONCIERGE_INBOX_ID) : null;
  validatePlAssertionConfig({ enabled: plAssertionsEnabled, accountId, inboxId, allowedInboxId: plInboxId, key: plAssertionKey, kid: plKid, bridgeKey: plContextKey, bridgeKid: plContextKid, phoneNumberId: plPhoneNumberId, sfToken, identity: { workspaceId, agentId, agentSlug }, requireCapability });
  const ownerUserId = Number(env.CHATWOOT_OWNER_USER_ID);
  const escalationTeamId = env.CHATWOOT_ESCALATION_TEAM_ID ? Number(env.CHATWOOT_ESCALATION_TEAM_ID) : null;
  if (escalationTeamId !== null && (!Number.isSafeInteger(escalationTeamId) || escalationTeamId <= 0)) {
    throw new Error("CHATWOOT_ESCALATION_TEAM_ID must be a positive Chatwoot team id");
  }
  if ((!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) && escalationTeamId === null) {
    throw new Error("configure CHATWOOT_OWNER_USER_ID or CHATWOOT_ESCALATION_TEAM_ID");
  }
  // rc9: deterministic actions (taps, STOP/START, Flow Done) through the PL action adapter. Both settings or neither.
  if (Boolean(env.PL_ADAPTER_URL) !== Boolean(env.PL_ADAPTER_BEARER_FILE)) throw new Error("set PL_ADAPTER_URL and PL_ADAPTER_BEARER_FILE together");
  if (env.PL_ADAPTER_URL && !plAssertionsEnabled) throw new Error("PL_ADAPTER_URL requires PL_CONCIERGE_ASSERTIONS_ENABLED=1");
  const adapter = env.PL_ADAPTER_URL ? adapterClient({ baseUrl: env.PL_ADAPTER_URL, bearer: readSecretFile(env.PL_ADAPTER_BEARER_FILE) }) : null;
  // rc10g: WhatsApp read receipt + typing indicator (owner 2026-10-11). OPTIONAL: any problem with its credential disables it
  // and the relay still boots (2026-10-11: a malformed optional secret crash-looped the production relay for ~1.5 min).
  const presence = buildPresence({ env, logger, fallbackPhoneNumberId: plPhoneNumberId });
  // War room (owner 2026-10-15): supervised hold and staff trace notes. OPTIONAL and never boot-fatal: a bad value means OFF, logged.
  const supervisedHoldMs = parseSupervisedHoldMs(env.RELAY_SUPERVISED_HOLD_MS, logger);
  const traceNotes = env.RELAY_TRACE_NOTES === "1";
  const chatwoot = chatwootClient({ baseUrl: need("CHATWOOT_BASE_URL"), accountId, token: botToken });
  const selfUserId = supervisedHoldMs > 0 ? await resolveSelfUserId(chatwoot, logger) : null;
  const relay = createRelay({
    channelMetaMessageId: env.RELAY_CHANNEL_META_MESSAGE_ID === "1",
    supervisedHoldMs: selfUserId ? supervisedHoldMs : 0,
    selfUserId,
    traceNotes,
    adapter,
    presence,
    scope: { accountId, inboxId, workspaceId, agentId, agentSlug },
    ownerUserId: Number.isSafeInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null,
    escalationTeamId,
    requireCapability,
    conversationStateKey,
    plConcierge: plAssertionsEnabled ? { key: plAssertionKey, kid: plKid, bridgeKey: plContextKey, bridgeKid: plContextKid, phoneNumberId: plPhoneNumberId, inboxId: plInboxId } : null,
    chatwoot,
    seldon: seldonClient({ baseUrl: need("SF_BASE_URL"), slug: agentSlug, workspaceId, agentId, token: sfToken }),
    logger,
  });
  const port = Number(env.PORT ?? 3000);
  createServer(createHandler({ secret, relay, logger })).listen(port, () =>
    logger({ event: "boot", port, accountId, inboxId, plInboxId, escalationReadback: escalationReadback === "1" && sfToken !== null, adapterActions: adapter !== null, presence: presence !== null, supervisedHoldMs: selfUserId ? supervisedHoldMs : 0, selfUserIdKnown: selfUserId !== null, traceNotes }),
  );
}
