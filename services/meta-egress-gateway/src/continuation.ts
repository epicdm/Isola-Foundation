/**
 * Pagination continuation tokens.
 *
 * Meta returns `paging.next` as an ABSOLUTE URL to graph.facebook.com. Chatwoot
 * follows it verbatim, with no headers:
 *
 *   return response['data'] + fetch_whatsapp_templates(next_url) if next_url.present?
 *
 * So a pass-through of Meta's paging object sends Chatwoot straight to Graph on
 * page two, carrying a gateway workload token that is not a Meta credential —
 * the request fails, the template list silently truncates, and the workload
 * token has been handed to Meta. `WHATSAPP_CLOUD_BASE_URL` cannot help: it
 * rewrites only the paths Chatwoot CONSTRUCTS, never a URL returned in a body.
 *
 * Every page therefore stays inside the gateway. `paging.next` is rewritten to a
 * gateway URL carrying one of these tokens, and because the follow-up request
 * arrives with no headers at all, the token has to authenticate the call by
 * itself. That is why it is bound to the workload, tenant, operation and asset,
 * and why it is short-lived and single-use rather than a second long-lived
 * credential in a URL.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Deliberately short: a page follow-up happens immediately or not at all. */
export const CONTINUATION_TTL_SECONDS = 120;
const MAX_USED = 20_000;

export interface ContinuationClaims {
  /** Which workload may follow this cursor. */
  readonly w: string;
  /** Tenant the page belongs to. */
  readonly t: string;
  /** Adapter operation this cursor is valid for, and no other. */
  readonly op: string;
  /** Asset (WABA) this cursor is valid for, and no other. */
  readonly a: string;
  /** The opaque Meta cursor. Meaningless outside Meta, carried verbatim. */
  readonly c: string;
  /** Expiry, unix seconds. */
  readonly exp: number;
  /** Uniqueness, so single-use can be enforced. */
  readonly n: string;
}

let signingKey: Buffer = randomBytes(32);
const used = new Map<string, number>();

/**
 * Set the continuation signing key.
 *
 * When the secret store does not supply one, the boot-time random key stands.
 * That is deliberate and safe: a restart invalidates in-flight cursors, which
 * fails closed — Chatwoot simply re-syncs from page one.
 */
export function setContinuationKey(key: string | null): void {
  if (key && key.length >= 32) signingKey = Buffer.from(key, 'utf8');
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function issue(claims: Omit<ContinuationClaims, 'exp' | 'n'>, nowMs: number): string {
  const full: ContinuationClaims = {
    ...claims,
    exp: Math.floor(nowMs / 1000) + CONTINUATION_TTL_SECONDS,
    n: b64url(randomBytes(9)),
  };
  const payload = b64url(Buffer.from(JSON.stringify(full), 'utf8'));
  const mac = b64url(createHmac('sha256', signingKey).update(payload, 'utf8').digest());
  return `${payload}.${mac}`;
}

export type ContinuationFailure = 'malformed' | 'bad_signature' | 'expired' | 'replayed' | 'table_full';

/**
 * Verify and CONSUME a continuation token.
 *
 * Single-use. A transient failure on page two makes Chatwoot restart the sync
 * from page one, so nothing legitimate needs to replay a cursor — and allowing
 * replay would let an observed URL be re-fetched indefinitely.
 */
export function consume(
  token: string,
  nowMs: number,
): { ok: true; claims: ContinuationClaims } | { ok: false; failure: ContinuationFailure } {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, failure: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, failure: 'malformed' };

  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) {
    return { ok: false, failure: 'malformed' };
  }

  const expected = b64url(createHmac('sha256', signingKey).update(payload, 'utf8').digest());
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(mac, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, failure: 'bad_signature' };

  let claims: ContinuationClaims;
  try {
    claims = JSON.parse(unb64url(payload).toString('utf8')) as ContinuationClaims;
  } catch {
    return { ok: false, failure: 'malformed' };
  }
  if (!claims || typeof claims.exp !== 'number' || typeof claims.n !== 'string') {
    return { ok: false, failure: 'malformed' };
  }
  if (claims.exp * 1000 < nowMs) return { ok: false, failure: 'expired' };

  // Signature proven before anything is stored, so unsigned input cannot fill
  // the table.
  if (used.size >= MAX_USED) {
    for (const [k, exp] of used) if (exp <= nowMs) used.delete(k);
    if (used.size >= MAX_USED) return { ok: false, failure: 'table_full' };
  }
  if (used.has(claims.n)) return { ok: false, failure: 'replayed' };
  used.set(claims.n, claims.exp * 1000 + 60_000);

  return { ok: true, claims };
}

export function __resetContinuations(): void {
  used.clear();
}
