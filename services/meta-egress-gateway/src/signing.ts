/**
 * Request signing and replay protection.
 *
 * A bearer token alone authenticates the CALLER but not the REQUEST: anyone who
 * observes one can resend the exact call. Foundation reaches this gateway across
 * the public internet (Replit cannot join a private overlay), so the request
 * itself has to be authenticated and bound to a moment in time.
 *
 * Every request carries:
 *
 *   X-Isola-Timestamp   unix seconds
 *   X-Isola-Nonce       caller-generated, unique within the skew window
 *   X-Isola-Signature   hex HMAC-SHA256 over the canonical string
 *
 * The canonical string is:
 *
 *   {method}\n{path}\n{timestamp}\n{nonce}\n{sha256(body)}
 *
 * The body digest is included, so a signature captured from one request cannot
 * be replayed onto a different body — which is what stops a captured read being
 * turned into a different read, and later a different operation.
 *
 * The signing key is the workload's own secret, held in the same Swarm secret as
 * everything else. It is NEVER a Meta credential: a caller signs with its own
 * key and the gateway holds the Meta token. That separation is the whole point.
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/** Requests older or newer than this are refused outright. */
export const MAX_SKEW_SECONDS = 300;
/** Nonces are remembered for at least the full skew window, both directions. */
const NONCE_TTL_MS = (MAX_SKEW_SECONDS * 2 + 60) * 1000;
const MAX_NONCES = 50_000;

export type SigningFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'skew'
  | 'replay'
  | 'bad_signature'
  | 'nonce_table_full';

export interface SigningHeaders {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}

// nonce -> expiry epoch ms
const seenNonces = new Map<string, number>();

function sweep(now: number): void {
  if (seenNonces.size < MAX_NONCES / 2) return;
  for (const [n, exp] of seenNonces) {
    if (exp <= now) seenNonces.delete(n);
  }
}

export function bodyDigest(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

export function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  digest: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${digest}`;
}

export function sign(key: string, canonical: string): string {
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
}

/**
 * Verify a signed request.
 *
 * Order matters: cheap structural checks first, the constant-time comparison
 * last, and the nonce is only recorded once the signature has been proven — an
 * attacker must not be able to exhaust the nonce table with unsigned garbage.
 */
export function verify(args: {
  key: string;
  method: string;
  path: string;
  rawBody: string;
  headers: SigningHeaders;
  nowMs: number;
}): { ok: true } | { ok: false; failure: SigningFailure } {
  const { key, method, path, rawBody, headers, nowMs } = args;

  if (!headers.timestamp || !headers.nonce || !headers.signature) {
    return { ok: false, failure: 'missing_headers' };
  }
  if (!/^[0-9]{1,12}$/.test(headers.timestamp)) return { ok: false, failure: 'bad_timestamp' };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(headers.nonce)) return { ok: false, failure: 'missing_headers' };
  if (!/^[0-9a-f]{64}$/.test(headers.signature)) return { ok: false, failure: 'bad_signature' };

  const ts = Number(headers.timestamp) * 1000;
  if (!Number.isFinite(ts)) return { ok: false, failure: 'bad_timestamp' };
  if (Math.abs(nowMs - ts) > MAX_SKEW_SECONDS * 1000) return { ok: false, failure: 'skew' };

  const expected = sign(key, canonicalString(method, path, headers.timestamp, headers.nonce, bodyDigest(rawBody)));
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(headers.signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, failure: 'bad_signature' };
  }

  // Signature is valid. Only now does the nonce cost us memory.
  sweep(nowMs);
  if (seenNonces.size >= MAX_NONCES) return { ok: false, failure: 'nonce_table_full' };
  if (seenNonces.has(headers.nonce)) return { ok: false, failure: 'replay' };
  seenNonces.set(headers.nonce, nowMs + NONCE_TTL_MS);

  return { ok: true };
}

export function __resetNonces(): void {
  seenNonces.clear();
}

export function nonceCount(): number {
  return seenNonces.size;
}
