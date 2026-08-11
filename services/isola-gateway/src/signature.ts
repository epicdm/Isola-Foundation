/**
 * Chatwoot AgentBot webhook signature verification.
 *
 * VERIFIED CONTRACT — Chatwoot 4.16.1, `lib/webhooks/trigger.rb` in the running
 * image:
 *
 *   POST <agent_bot.outgoing_url>
 *   content-type:          application/json
 *   X-Chatwoot-Signature:  sha256=<hex HMAC-SHA256>
 *   X-Chatwoot-Timestamp:  <unix seconds>
 *   X-Chatwoot-Delivery:   <uuid>
 *
 *   signed string = `${timestamp}.${rawBody}`      <- the RAW body, byte for byte
 *   key           = the AgentBot's own `secret`
 *
 * The raw body matters. `JSON.stringify(JSON.parse(raw))` reorders nothing in
 * V8 but does normalise whitespace, unicode escaping and number formatting, so
 * a re-serialised body will not reproduce the signature. Every caller in this
 * service therefore verifies over the `Buffer` that came off the socket, before
 * anything parses it. `test/signature.test.ts` pins that difference.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-chatwoot-signature";
export const TIMESTAMP_HEADER = "x-chatwoot-timestamp";
export const DELIVERY_HEADER = "x-chatwoot-delivery";

/**
 * Why a verification failed. This is a SERVER-SIDE category only. The HTTP
 * response says `unauthorized` and nothing else: telling a caller which half
 * failed turns the endpoint into an oracle for the replay window and for which
 * inboxes exist.
 */
export type SignatureFailureReason =
  | "no_secret_configured"
  | "signature_header_missing"
  | "signature_header_malformed"
  | "timestamp_header_missing"
  | "timestamp_header_malformed"
  | "timestamp_too_old"
  | "timestamp_in_future"
  | "signature_mismatch";

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason };

/** The exact byte sequence Chatwoot signs: `${timestamp}.` followed by the raw body. */
export function signingPayload(timestamp: string, raw: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), raw]);
}

/** Produce the hex digest Chatwoot puts after `sha256=`. Used by tests and by nothing else. */
export function computeSignature(secret: string, timestamp: string, raw: Buffer): string {
  return createHmac("sha256", secret).update(signingPayload(timestamp, raw)).digest("hex");
}

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/** Pull the hex digest out of `sha256=<hex>`. Null when the header is not that shape. */
export function parseSignatureHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const match = SIGNATURE_PATTERN.exec(raw.trim());
  if (match === null) return null;
  return (match[1] ?? "").toLowerCase();
}

/** Unix seconds as an integer, or null. */
export function parseTimestampHeader(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Constant-time equality. Both sides are hashed first so the comparison is over
 * two equal-length buffers and no length information leaks through an early
 * return.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export interface VerifyArgs {
  raw: Buffer;
  signatureHeader: string | string[] | undefined;
  timestampHeader: string | string[] | undefined;
  /** The AgentBot secret for the binding this delivery is addressed to. */
  secret: string | null;
  /** Wall clock in milliseconds. */
  nowMs: number;
  /** Replay window in seconds, applied to BOTH past and future skew. */
  windowSec: number;
}

/**
 * Verify one delivery. Fails closed on every ambiguity, including a binding
 * with no configured secret.
 *
 * Check order is deliberate: the cheap structural checks run first, and the
 * timestamp window is enforced BEFORE the HMAC so that a replayed-but-validly-
 * signed body is still rejected.
 */
export function verifyChatwootSignature(args: VerifyArgs): SignatureVerdict {
  if (args.secret === null || args.secret.length === 0) {
    return { ok: false, reason: "no_secret_configured" };
  }

  const rawSignature = Array.isArray(args.signatureHeader)
    ? args.signatureHeader[0]
    : args.signatureHeader;
  if (typeof rawSignature !== "string" || rawSignature.trim().length === 0) {
    return { ok: false, reason: "signature_header_missing" };
  }
  const provided = parseSignatureHeader(args.signatureHeader);
  if (provided === null) {
    return { ok: false, reason: "signature_header_malformed" };
  }

  const rawTimestamp = Array.isArray(args.timestampHeader)
    ? args.timestampHeader[0]
    : args.timestampHeader;
  if (typeof rawTimestamp !== "string" || rawTimestamp.trim().length === 0) {
    return { ok: false, reason: "timestamp_header_missing" };
  }
  const timestamp = parseTimestampHeader(args.timestampHeader);
  if (timestamp === null) {
    return { ok: false, reason: "timestamp_header_malformed" };
  }

  const nowSec = Math.floor(args.nowMs / 1000);
  if (nowSec - timestamp > args.windowSec) {
    return { ok: false, reason: "timestamp_too_old" };
  }
  if (timestamp - nowSec > args.windowSec) {
    return { ok: false, reason: "timestamp_in_future" };
  }

  // The timestamp is signed, so it must go into the HMAC exactly as it arrived
  // on the wire, not as the integer we parsed out of it.
  const expected = computeSignature(args.secret, rawTimestamp.trim(), args.raw);
  if (!constantTimeEquals(provided, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

/** The delivery id, or null when the header is absent or unusable. */
export function parseDeliveryHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}
