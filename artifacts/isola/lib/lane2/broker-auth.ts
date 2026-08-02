/**
 * Scoped Foundation connector credential for the lane2 adapter broker
 * endpoint (app/api/lane2/broker/turn).
 *
 * Deliberately a DIFFERENT secret from CLAWITH_SHARED_SECRET (Foundation's
 * own credential to Clawith, lib/clawith/client.ts) and from the adapter's
 * former direct-Clawith credential (clawith_bridge_secret, removed from the
 * active adapter path by this same release). This credential authenticates
 * "is this request really from the lane2 adapter", nothing more — it carries
 * no tenant, agent or permission assertion of its own.
 *
 * Same HMAC-over-`${timestamp}.${rawBody}` construction as
 * lib/chatwoot-webhook-signature.ts, reused rather than reinvented: proven,
 * already unit-tested pattern, already reviewed for the replay-window and
 * constant-time-compare failure modes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const LANE2_BROKER_SECRET_ENV = 'LANE2_BROKER_SHARED_SECRET';
export const SIGNATURE_HEADER = 'x-lane2-broker-signature';
export const TIMESTAMP_HEADER = 'x-lane2-broker-timestamp';

/** How far the delivery timestamp may drift from our clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type Lane2BrokerAuthFailure =
  | 'no-secret-configured'
  | 'missing-signature'
  | 'missing-timestamp'
  | 'malformed-signature'
  | 'malformed-timestamp'
  | 'stale-timestamp'
  | 'signature-mismatch';

export type Lane2BrokerAuthResult =
  | { ok: true }
  | { ok: false; reason: Lane2BrokerAuthFailure };

export function computeLane2BrokerSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const digest = (buf: Buffer) => createHmac('sha256', 'length-safe-compare').update(buf).digest();
  return timingSafeEqual(digest(bufA), digest(bufB));
}

/**
 * Fails closed: any missing, malformed or unverifiable input is a rejection.
 * The reason is for server-side logging only — never echoed to the caller.
 */
export function verifyLane2BrokerSignature(params: {
  rawBody: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  secret: string | null | undefined;
  toleranceSeconds?: number;
  nowMs?: number;
}): Lane2BrokerAuthResult {
  const { rawBody, signature, timestamp, secret } = params;
  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowMs = params.nowMs ?? Date.now();

  if (!secret) return { ok: false, reason: 'no-secret-configured' };
  if (!signature) return { ok: false, reason: 'missing-signature' };
  if (!timestamp) return { ok: false, reason: 'missing-timestamp' };
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'malformed-signature' };
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: 'malformed-timestamp' };

  if (tolerance > 0) {
    const skewSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
    if (skewSeconds > tolerance) return { ok: false, reason: 'stale-timestamp' };
  }

  const expected = computeLane2BrokerSignature(secret, timestamp, rawBody);
  if (!safeEquals(signature, expected)) return { ok: false, reason: 'signature-mismatch' };
  return { ok: true };
}

export function readLane2BrokerSignatureHeaders(headers: Headers): {
  signature: string | null;
  timestamp: string | null;
} {
  return {
    signature: headers.get(SIGNATURE_HEADER),
    timestamp: headers.get(TIMESTAMP_HEADER),
  };
}
