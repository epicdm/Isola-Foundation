/**
 * Chatwoot agent-bot / API-channel webhook signature verification.
 *
 * Chatwoot 4.13.0 added signed webhook deliveries. Verified against the
 * running 4.16.1 image at lib/webhooks/trigger.rb#request_headers:
 *
 *   ts = Time.now.to_i.to_s
 *   headers['X-Chatwoot-Timestamp'] = ts
 *   headers['X-Chatwoot-Signature'] = "sha256=" +
 *     OpenSSL::HMAC.hexdigest('SHA256', secret, "#{ts}.#{body}")
 *   headers['X-Chatwoot-Delivery']  = delivery_id   # when present
 *
 * The signed payload is `${timestamp}.${rawBody}` — the RAW request body, byte
 * for byte. Re-serialising parsed JSON will not reproduce it (key order and
 * whitespace differ), so the caller must pass the exact text it received.
 *
 * This replaces `?secret=<token>` in the bot's outgoing_url. A query-string
 * secret is written to proxy logs, browser history and Chatwoot's own admin UI,
 * and it carries no timestamp, so a captured request can be replayed forever.
 *
 * These functions are pure so they can be unit-tested without a live Chatwoot.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-chatwoot-signature';
export const TIMESTAMP_HEADER = 'x-chatwoot-timestamp';
export const DELIVERY_HEADER = 'x-chatwoot-delivery';

/** How far the delivery timestamp may drift from our clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure =
  | 'no-secret-configured'
  | 'missing-signature'
  | 'missing-timestamp'
  | 'malformed-signature'
  | 'malformed-timestamp'
  | 'stale-timestamp'
  | 'signature-mismatch';

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: SignatureFailure };

/**
 * Compute the expected signature value, including the `sha256=` prefix.
 * Exported so tests (and any future outbound caller) sign identically.
 */
export function computeChatwootSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

/** Length-safe constant-time comparison of two ASCII strings. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, and the throw itself would leak
  // length. Compare a fixed-size digest of each instead so the comparison is
  // constant-time regardless of input length.
  const digest = (buf: Buffer) => createHmac('sha256', 'length-safe-compare').update(buf).digest();
  return timingSafeEqual(digest(bufA), digest(bufB));
}

/**
 * Verify a Chatwoot webhook delivery.
 *
 * Fails closed: any missing, malformed or unverifiable input is a rejection.
 * The reason is returned for server-side logging only — never send it to the
 * caller, since it would tell an attacker which half of the check failed.
 */
export function verifyChatwootSignature(params: {
  rawBody: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  secret: string | null | undefined;
  /** Defaults to DEFAULT_TOLERANCE_SECONDS. Set 0 to disable the window. */
  toleranceSeconds?: number;
  /** Injectable clock (ms since epoch) so tests are deterministic. */
  nowMs?: number;
}): SignatureResult {
  const { rawBody, signature, timestamp, secret } = params;
  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowMs = params.nowMs ?? Date.now();

  if (!secret) return { ok: false, reason: 'no-secret-configured' };
  if (!signature) return { ok: false, reason: 'missing-signature' };
  if (!timestamp) return { ok: false, reason: 'missing-timestamp' };

  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: 'malformed-signature' };
  }
  if (!/^\d{1,15}$/.test(timestamp)) {
    return { ok: false, reason: 'malformed-timestamp' };
  }

  // Replay window. Reject deliveries too far in the past OR the future — a
  // far-future timestamp would otherwise stay valid indefinitely.
  if (tolerance > 0) {
    const skewSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
    if (skewSeconds > tolerance) return { ok: false, reason: 'stale-timestamp' };
  }

  const expected = computeChatwootSignature(secret, timestamp, rawBody);
  if (!safeEquals(signature, expected)) {
    return { ok: false, reason: 'signature-mismatch' };
  }
  return { ok: true };
}

/** Read the signature headers off a request in a case-insensitive way. */
export function readSignatureHeaders(headers: Headers): {
  signature: string | null;
  timestamp: string | null;
  deliveryId: string | null;
} {
  return {
    signature: headers.get(SIGNATURE_HEADER),
    timestamp: headers.get(TIMESTAMP_HEADER),
    deliveryId: headers.get(DELIVERY_HEADER),
  };
}
