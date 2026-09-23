/**
 * THE VERIFIED PRINCIPAL, as the runtime receives and forwards it.
 *
 * dec-internal-manager-owner-instruction-authority-and-alerts-2026-09-23: the
 * acting identity comes from the verified channel and trusted server context,
 * never from message content. The internal gateway derives it AFTER its
 * allowlist admits a sender and sends it as a top-level `principal` field on
 * `POST /v1/invoke` — never inside `context`, which this service renders
 * verbatim into the model's user message.
 *
 * WHAT REACHES THE BRAIN
 *   Never the phone number. The brain gets:
 *     - `user` (the OpenAI-compatible field): `principalUserId()`, a stable,
 *       non-reversible id — sha256 over a fixed namespace plus the E.164, cut to
 *       32 hex chars. Stable, so a brain that keys memory or sessions on `user`
 *       keeps one person's memory together and apart from everyone else's.
 *     - header `X-Isola-Principal-Channel`: the channel name.
 *
 * WHY THE PARSE IS STRICT
 *   A principal is an authority claim. A malformed one has no safe reading, so
 *   it is refused (400) rather than dropped: dropping it would silently turn an
 *   owner request into an anonymous one, which for a template that REQUIRES a
 *   principal is exactly the failure that must be loud.
 */
import { createHash } from "node:crypto";

export interface VerifiedPrincipal {
  channel: "whatsapp";
  senderE164: string;
  verifiedBy: "gateway-allowlist";
  bindingKey: string;
}

export type PrincipalParse =
  | { kind: "absent" }
  | { kind: "ok"; principal: VerifiedPrincipal }
  | { kind: "invalid"; reason: string };

const E164 = /^\+[1-9]\d{6,14}$/;
const BINDING_KEY = /^\d{1,12}\/\d{1,12}$/;
const KEYS = ["channel", "senderE164", "verifiedBy", "bindingKey"] as const;

/**
 * The namespace mixed into the hash. Changing it re-keys every principal's
 * memory in the brain, so it is versioned and must not change casually.
 */
export const PRINCIPAL_USER_NAMESPACE = "isola-principal-user-v1";

export function parsePrincipal(raw: unknown): PrincipalParse {
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", reason: "principal must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) {
    // Named by count, not by key: the key names are caller-supplied text.
    return { kind: "invalid", reason: `principal carries ${extra.length} unrecognised field(s)` };
  }
  if (record["channel"] !== "whatsapp") {
    return { kind: "invalid", reason: "principal.channel must be \"whatsapp\"" };
  }
  if (record["verifiedBy"] !== "gateway-allowlist") {
    return { kind: "invalid", reason: "principal.verifiedBy must be \"gateway-allowlist\"" };
  }
  const sender = record["senderE164"];
  if (typeof sender !== "string" || !E164.test(sender)) {
    return { kind: "invalid", reason: "principal.senderE164 must be an E.164 number" };
  }
  const bindingKey = record["bindingKey"];
  if (typeof bindingKey !== "string" || !BINDING_KEY.test(bindingKey)) {
    return { kind: "invalid", reason: "principal.bindingKey must be <account>/<inbox>" };
  }
  return {
    kind: "ok",
    principal: { channel: "whatsapp", senderE164: sender, verifiedBy: "gateway-allowlist", bindingKey },
  };
}

/** Stable, non-phone id for the brain's `user` field. 32 lowercase hex chars. */
export function principalUserId(principal: VerifiedPrincipal): string {
  return createHash("sha256")
    .update(`${PRINCIPAL_USER_NAMESPACE}:${principal.senderE164}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export const PRINCIPAL_CHANNEL_HEADER = "X-Isola-Principal-Channel";
