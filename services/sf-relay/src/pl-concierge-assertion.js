import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const KID = /^[a-z0-9]{1,16}$/;
const WA_ID = /^[1-9][0-9]{6,15}$/;
const PNID = /^[0-9]{5,20}$/;
const SOURCES = new Set(["button", "list", "numbered"]);

/** Match the frozen PL concierge v1 assertion wire format. Never log output. */
export function mintPlAssertion({ key, kid, waId, phoneNumberId, conversationId, messageId, nowSec, confirmation = null, nonce = randomBytes(16).toString("base64url") }) {
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) throw new Error("pl_assertion_key_invalid");
  if (typeof kid !== "string" || !KID.test(kid)) throw new Error("pl_assertion_kid_invalid");
  if (typeof waId !== "string" || !WA_ID.test(waId)) throw new Error("pl_assertion_source_id_invalid");
  if (typeof phoneNumberId !== "string" || !PNID.test(phoneNumberId)) throw new Error("pl_assertion_phone_number_id_invalid");
  if (typeof conversationId !== "string" || conversationId.length < 1 || conversationId.length > 128) throw new Error("pl_assertion_conversation_invalid");
  if (typeof messageId !== "string" || messageId.length < 1 || messageId.length > 256) throw new Error("pl_assertion_message_invalid");
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) throw new Error("pl_assertion_time_invalid");
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw new Error("pl_assertion_nonce_invalid");

  const payload = { kid, wa_id: waId, pnid: phoneNumberId, rid: conversationId, mid: messageId, iat: nowSec, nonce };
  if (confirmation !== null) {
    if (confirmation.verified !== true
      || confirmation.waId !== waId
      || confirmation.conversationId !== conversationId
      || confirmation.messageId !== messageId
      || confirmation.offerKey !== "trial"
      || !SOURCES.has(confirmation.source)) {
      throw new Error("pl_assertion_confirmation_unverified");
    }
    payload.act = "pl.confirm_signup";
    payload.act_src = confirmation.source;
  }

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", Buffer.from(key, "utf8"))
    .update(`${VERSION}.${encoded}`, "utf8")
    .digest("base64url");
  return `${VERSION}.${encoded}.${signature}`;
}

/**
 * Resolve identity only from the authenticated Chatwoot conversation/contact
 * records. phone_number is deliberately not accepted as the PL wa_id: the
 * deployment must verify that this WhatsApp inbox's contact_inbox.source_id is
 * the provider's sender identifier before enabling the assertion key.
 */
export function resolveChatwootWhatsAppSource({ conversation, contactResponse, expectedAccountId, expectedInboxId, webhookSenderId }) {
  const contact = contactResponse?.payload ?? contactResponse;
  if (!conversation || conversation.account_id !== expectedAccountId || conversation.inbox_id !== expectedInboxId) return null;
  if (!Number.isSafeInteger(webhookSenderId) || conversation.meta?.sender?.id !== webhookSenderId) return null;
  if (!contact || contact.id !== webhookSenderId || !Array.isArray(contact.contact_inboxes)) return null;

  const matches = contact.contact_inboxes.filter((entry) => {
    const inbox = entry?.inbox;
    const channel = String(inbox?.channel_type ?? "").toLowerCase();
    const provider = String(inbox?.provider ?? "").toLowerCase();
    return inbox?.id === expectedInboxId && (channel.includes("whatsapp") || provider.includes("whatsapp"));
  });
  // Real Chatwoot WhatsApp contacts carry TWO contact_inboxes in the same inbox (measured 62/62 on inbox 7): the numeric phone id and a
  // prefixed id (US./DM./VI./GP./CN.). Only a numeric phone id is an identity; drop the rest BEFORE the uniqueness check. Two numeric
  // ids (or none) stay unresolved: fail closed.
  const numeric = matches.filter((entry) => typeof entry?.source_id === "string" && /^[1-9][0-9]{6,15}$/.test(entry.source_id));
  if (numeric.length !== 1) return null;
  const sourceId = numeric[0].source_id;
  return { waId: sourceId, contactId: webhookSenderId, inboxId: expectedInboxId };
}

const CONTEXT_KID = /^[a-z0-9]{1,16}$/;
const b64url = (value) => Buffer.from(value, "utf8").toString("base64url");

/** Short-lived relay-to-native-runtime envelope; it is never stored in Chatwoot or returned to the visitor. */
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mintRelayContext({ key, kid, accountId, inboxId, workspaceId, agentId, agentSlug, sessionId, uplinkConversationId = null, chatwootConversationId, chatwootMessageId, message, plAssertion, nowSec, nonce = randomBytes(16).toString("base64url") }) {
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) throw new Error("relay_context_key_invalid");
  if (typeof kid !== "string" || !CONTEXT_KID.test(kid)) throw new Error("relay_context_kid_invalid");
  if (!Number.isSafeInteger(accountId) || accountId !== 2 || !Number.isSafeInteger(inboxId) || inboxId !== 11) throw new Error("relay_context_scope_invalid");
  if (typeof workspaceId !== "string" || workspaceId.length < 16 || typeof agentId !== "string" || !AGENT_ID.test(agentId)
    || typeof agentSlug !== "string" || agentSlug.length < 1 || agentSlug.length > 128) throw new Error("relay_context_agent_invalid");
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 128) throw new Error("relay_context_session_invalid");
  if (uplinkConversationId !== null && (typeof uplinkConversationId !== "string" || uplinkConversationId.length > 128)) throw new Error("relay_context_uplink_conversation_invalid");
  if (typeof chatwootConversationId !== "string" || chatwootConversationId.length < 1 || chatwootConversationId.length > 128) throw new Error("relay_context_chatwoot_conversation_invalid");
  if (typeof chatwootMessageId !== "string" || chatwootMessageId.length < 1 || chatwootMessageId.length > 256) throw new Error("relay_context_message_invalid");
  if (typeof message !== "string" || message.length < 1 || message.length > 2000) throw new Error("relay_context_message_invalid");
  if (typeof plAssertion !== "string" || plAssertion.length > 2048) throw new Error("relay_context_assertion_invalid");
  if (!Number.isSafeInteger(nowSec) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw new Error("relay_context_time_or_nonce_invalid");

  const payload = {
    kid, accountId, inboxId, workspaceId, agentId, agentSlug, sessionId, uplinkConversationId,
    chatwootConversationId, chatwootMessageId,
    messageSha256: createHash("sha256").update(message, "utf8").digest("hex"),
    plAssertion, iat: nowSec, nonce,
  };
  const encoded = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", Buffer.from(key, "utf8")).update(`v1.${encoded}`, "utf8").digest("base64url");
  return `v1.${encoded}.${signature}`;
}

/** Server-side verifier contract for Uplink. All expected bindings are supplied by its resolved native route. */
export function verifyRelayContext(token, { keys, nowSec, expected }) {
  if (typeof token !== "string" || token.length > 8192) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return { ok: false, reason: "malformed" };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  const key = payload && typeof payload.kid === "string" ? keys?.[payload.kid] : null;
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) return { ok: false, reason: "unknown_kid" };
  const expectedMac = Buffer.from(createHmac("sha256", Buffer.from(key, "utf8")).update(`v1.${parts[1]}`, "utf8").digest("base64url"));
  const actualMac = Buffer.from(parts[2]);
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) return { ok: false, reason: "bad_signature" };
  if (!payload || !Number.isSafeInteger(payload.iat) || Math.abs(nowSec - payload.iat) > 60) return { ok: false, reason: "stale" };
  if (typeof payload.agentId !== "string" || !AGENT_ID.test(payload.agentId)
    || typeof payload.messageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.messageSha256)
    || typeof payload.plAssertion !== "string" || !payload.plAssertion.startsWith("v1.")
    || !/^[A-Za-z0-9_-]{22}$/.test(payload.nonce)) return { ok: false, reason: "bad_fields" };
  for (const keyName of ["accountId", "inboxId", "workspaceId", "agentId", "agentSlug", "sessionId", "uplinkConversationId", "chatwootConversationId", "chatwootMessageId", "messageSha256"]) {
    if (payload[keyName] !== expected?.[keyName]) return { ok: false, reason: `binding_mismatch:${keyName}` };
  }
  return { ok: true, payload };
}
