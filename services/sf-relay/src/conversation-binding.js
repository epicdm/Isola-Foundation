import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const CONVERSATION_BINDING_ATTRIBUTE = "seldonframe_relay_binding_v1";
const VERSION = "v1";

function keyFrom(secret) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("conversation_state_key_invalid");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("uplink-sf-relay-v1"), Buffer.from("chatwoot-conversation-binding"), 32));
}

export function sealConversationBinding(binding, secret) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(binding), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function openConversationBinding(envelope, secret) {
  if (typeof envelope !== "string" || envelope.length > 8192) throw new Error("conversation_binding_invalid");
  const [version, nonceText, ciphertextText, tagText, extra] = envelope.split(".");
  if (version !== VERSION || !nonceText || !ciphertextText || !tagText || extra !== undefined) {
    throw new Error("conversation_binding_invalid");
  }
  const nonce = Buffer.from(nonceText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("conversation_binding_invalid");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  const value = JSON.parse(plaintext);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("conversation_binding_invalid");
  return value;
}

export function bindingMatchesScope(binding, scope, chatwootConversationId) {
  return binding?.version === 1
    && binding.accountId === scope.accountId
    && binding.inboxId === scope.inboxId
    && binding.chatwootConversationId === chatwootConversationId
    && binding.workspaceId === scope.workspaceId
    && binding.agentId === scope.agentId
    && binding.agentSlug === scope.agentSlug
    && typeof binding.sessionId === "string"
    && binding.sessionId.length >= 8
    && typeof binding.phase === "string";
}
