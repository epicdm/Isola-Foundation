/**
 * lib/consumer-session.ts — session issuance/verification for the P2
 * consumer phone-OTP auth realm.
 *
 * Deliberately entirely separate from lib/session.ts (operator/Replit Auth
 * realm): different cookie name, different signing scheme, no shared code
 * path, no interaction with User/act_as_tenant_id/resolveSession. A compact
 * HMAC-signed token (base64url(payload).base64url(hmac)) is used instead of
 * a DB-backed session table — no new session-store table needed, and the
 * only trust anchor is SESSION_SECRET (already provisioned).
 */

import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from './prisma';
import type { ConsumerAccount } from '@prisma/client';

export const CONSUMER_SESSION_COOKIE = 'consumer_sid';

/**
 * Cookie `Domain` for consumer_sid — shared across all epic.dm subdomains
 * (test.epic.dm, app.isola.epic.dm, pay.isola.epic.dm) so a session
 * established on one epic.dm host is valid on another. `isola-foundation.
 * replit.app` is a DIFFERENT registrable domain and can never share this
 * cookie no matter what Domain is set — see memory: consumers must log in
 * on an epic.dm host (SIGNUP_URL/EMA_SIGNUP_URL), not the old Foundation
 * Replit domain, or this Domain attribute buys nothing.
 *
 * Only applied in production, or when the current request's host is
 * actually an epic.dm host — local dev (localhost) and Replit preview
 * (*.replit.dev) hosts get `undefined` (browser defaults to exact-host
 * scoping), since a literal ".epic.dm" Domain attribute on a non-epic.dm
 * host is rejected by the browser and the cookie silently fails to set at
 * all.
 */
export function consumerCookieDomain(req: { headers: { get(name: string): string | null } }): string | undefined {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  const isEpicDmHost = host === 'epic.dm' || host.endsWith('.epic.dm');
  // Belt-and-suspenders: require BOTH production-like env AND an actual
  // epic.dm host before setting Domain, so a *.replit.dev preview running
  // with NODE_ENV=production (Autoscale) still can't accidentally set a
  // ".epic.dm" Domain on a non-epic.dm host (the browser would reject the
  // Set-Cookie header entirely), and local dev never sets it either way.
  if (process.env.NODE_ENV === 'production' && isEpicDmHost) {
    return '.epic.dm';
  }
  return undefined;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CONSUMER_SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

interface ConsumerSessionPayload {
  sub: string; // ConsumerAccount.id
  iat: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured — required to sign consumer sessions');
  return secret;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(body: string): string {
  return b64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
}

export function signConsumerSessionToken(consumerAccountId: string): string {
  const payload: ConsumerSessionPayload = {
    sub: consumerAccountId,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

export function verifyConsumerSessionToken(token: string): ConsumerSessionPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expectedSig = hmac(body);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload: ConsumerSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  return payload;
}

/**
 * Route Handlers only. Reads + verifies the consumer cookie, then reloads
 * the ConsumerAccount fresh from the DB (never trusts stale JWT claims
 * beyond the id) so a suspended/deleted account can't act on an old token.
 */
export async function getConsumerSession(): Promise<ConsumerAccount | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(CONSUMER_SESSION_COOKIE)?.value;
  if (!token) return null;

  const payload = verifyConsumerSessionToken(token);
  if (!payload) return null;

  const account = await prisma.consumerAccount.findUnique({ where: { id: payload.sub } });
  if (!account || account.status !== 'active') return null;
  return account;
}
