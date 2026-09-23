/**
 * THE VERIFIED PRINCIPAL, as the runtime receives, AUTHENTICATES and forwards it.
 *
 * dec-internal-manager-owner-instruction-authority-and-alerts-2026-09-23: the
 * acting identity comes from the verified channel and trusted server context,
 * never from message content. The internal gateway derives it AFTER its
 * allowlist admits a sender and sends it as a top-level `principal` field on
 * `POST /v1/invoke` — never inside `context`, which this service renders
 * verbatim into the model's user message.
 *
 * WHY IT IS SIGNED (Codex, PR #151)
 *   The runtime credential does not identify the gateway: RUNTIME_SECRET_INTERNAL
 *   is shared by every INTERNAL caller. An unsigned principal is therefore only
 *   a caller's assertion, and any holder of that credential could name the
 *   owner. So the gateway signs it with HMAC-SHA256 under PRINCIPAL_SIGNING_KEY,
 *   a key held ONLY by that gateway and this service. The signature covers
 *   every identity field, an `issuedAt` (unix seconds) and a `nonce` that must
 *   equal the invoke's `runId`, so a signed principal cannot be edited, kept
 *   for later, or moved onto another run.
 *
 *   An unsigned, badly signed, stale or mis-bound principal is UNVERIFIED:
 *     - a template that `requiresPrincipal` refuses it (400 principal_unverified);
 *     - every other template IGNORES it, exactly as if none had been sent.
 *
 * WHAT REACHES THE BRAIN
 *   Never the phone number. The brain gets:
 *     - `user`: HMAC-SHA256(user key, E.164) cut to 32 hex chars. KEYED, so the
 *       brain and its logs cannot enumerate phone numbers back from it the way
 *       they could from a plain hash of a ~10^10 space. Stable per person.
 *     - header `X-Isola-Principal-Channel`: the channel name.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export interface VerifiedPrincipal {
  channel: "whatsapp";
  senderE164: string;
  verifiedBy: "gateway-allowlist";
  bindingKey: string;
}

/** The wire form: the identity plus the fields that authenticate it. */
export interface PrincipalClaim extends VerifiedPrincipal {
  issuedAt: number | null;
  nonce: string | null;
  signature: string | null;
}

export type PrincipalParse =
  | { kind: "absent" }
  | { kind: "ok"; claim: PrincipalClaim }
  | { kind: "invalid"; reason: string };

export type PrincipalVerification =
  | { kind: "verified"; principal: VerifiedPrincipal }
  | {
      kind: "unverified";
      reason: "unsigned" | "bad_signature" | "stale" | "nonce_mismatch" | "no_key";
    };

const E164 = /^\+[1-9]\d{6,14}$/;
const BINDING_KEY = /^\d{1,12}\/\d{1,12}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const KEYS = [
  "channel",
  "senderE164",
  "verifiedBy",
  "bindingKey",
  "issuedAt",
  "nonce",
  "signature",
] as const;

/** Domain-separation tag for the signature. Versioned; the gateway uses the same. */
export const PRINCIPAL_SIGNATURE_VERSION = "isola-principal-v1";
/** How old (or how far in the future) a signed principal may be. */
export const PRINCIPAL_MAX_AGE_SEC = 120;
/** HKDF `info` for deriving the user-id key from the signing key. */
export const PRINCIPAL_USER_KEY_INFO = "isola-principal-user-id-v1";

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
  // The authenticating fields are OPTIONAL at parse time on purpose: their
  // absence means "unsigned", which is an authentication outcome, not a
  // malformed body. Present but mistyped is malformed.
  const issuedAt = record["issuedAt"];
  if (issuedAt !== undefined && !(typeof issuedAt === "number" && Number.isSafeInteger(issuedAt))) {
    return { kind: "invalid", reason: "principal.issuedAt must be an integer when present" };
  }
  const nonce = record["nonce"];
  if (nonce !== undefined && (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256)) {
    return { kind: "invalid", reason: "principal.nonce must be a non-empty string when present" };
  }
  const signature = record["signature"];
  if (signature !== undefined && (typeof signature !== "string" || !HEX_SHA256.test(signature))) {
    return { kind: "invalid", reason: "principal.signature must be 64 lowercase hex chars when present" };
  }
  return {
    kind: "ok",
    claim: {
      channel: "whatsapp",
      senderE164: sender,
      verifiedBy: "gateway-allowlist",
      bindingKey,
      issuedAt: typeof issuedAt === "number" ? issuedAt : null,
      nonce: typeof nonce === "string" ? nonce : null,
      signature: typeof signature === "string" ? signature : null,
    },
  };
}

/**
 * The exact bytes signed. Newline-joined: no field can contain a newline
 * (E.164, the binding key and the fixed literals cannot; the nonce is checked
 * below), so no two distinct claims share a canonical form.
 */
export function canonicalPrincipal(
  p: VerifiedPrincipal & { issuedAt: number; nonce: string },
): string {
  return [
    PRINCIPAL_SIGNATURE_VERSION,
    p.channel,
    p.senderE164,
    p.verifiedBy,
    p.bindingKey,
    String(p.issuedAt),
    p.nonce,
  ].join("\n");
}

export function signPrincipal(
  key: string,
  p: VerifiedPrincipal & { issuedAt: number; nonce: string },
): string {
  return createHmac("sha256", key).update(canonicalPrincipal(p), "utf8").digest("hex");
}

/**
 * Authenticate a parsed claim. `runId` is the invoke's own run id, which the
 * claim's nonce must equal. `nowSec` is injected for testability.
 */
export function verifyPrincipal(
  claim: PrincipalClaim,
  args: { key: string | null; runId: string | null; nowSec: number },
): PrincipalVerification {
  if (args.key === null) return { kind: "unverified", reason: "no_key" };
  if (claim.signature === null || claim.issuedAt === null || claim.nonce === null) {
    return { kind: "unverified", reason: "unsigned" };
  }
  if (claim.nonce.includes("\n")) return { kind: "unverified", reason: "bad_signature" };
  const expected = Buffer.from(
    signPrincipal(args.key, { ...claim, issuedAt: claim.issuedAt, nonce: claim.nonce }),
    "hex",
  );
  const presented = Buffer.from(claim.signature, "hex");
  // Lengths are equal by the parse regex; checked anyway so timingSafeEqual
  // can never throw on a future change to the parse.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { kind: "unverified", reason: "bad_signature" };
  }
  // Freshness and binding are checked AFTER the MAC, so an unauthenticated
  // body cannot learn anything about the clock or the run from the reason.
  if (Math.abs(args.nowSec - claim.issuedAt) > PRINCIPAL_MAX_AGE_SEC) {
    return { kind: "unverified", reason: "stale" };
  }
  if (args.runId === null || claim.nonce !== args.runId) {
    return { kind: "unverified", reason: "nonce_mismatch" };
  }
  return {
    kind: "verified",
    principal: {
      channel: claim.channel,
      senderE164: claim.senderE164,
      verifiedBy: claim.verifiedBy,
      bindingKey: claim.bindingKey,
    },
  };
}

/**
 * The key for the brain-facing user id: PRINCIPAL_USER_KEY when configured,
 * otherwise HKDF-SHA256 of the signing key with a distinct info string, so the
 * user-id key is never the signing key itself.
 */
export function principalUserKey(args: {
  userKey: string | null;
  signingKey: string | null;
}): Buffer | null {
  if (args.userKey !== null) return Buffer.from(args.userKey, "utf8");
  if (args.signingKey === null) return null;
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(args.signingKey, "utf8"), Buffer.alloc(0), PRINCIPAL_USER_KEY_INFO, 32),
  );
}

/** Stable, keyed, non-phone id for the brain's `user` field. 32 lowercase hex chars. */
export function principalUserId(principal: VerifiedPrincipal, userKey: Buffer): string {
  return createHmac("sha256", userKey)
    .update(principal.senderE164, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export const PRINCIPAL_CHANNEL_HEADER = "X-Isola-Principal-Channel";
