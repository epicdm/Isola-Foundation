/**
 * GET /home — SIP-credential auth entry point for the Acrobits custom web
 * tab (configured on test.epic.dm as
 * .../home?username=%account[username]%&password=%account[password]%).
 *
 * Acrobits fills in the signed-in softphone's own SIP username/password as
 * query params. We look up the ConsumerAccount that owns that SIP username,
 * check the password against `magnus_sip_password` (the single-sourced SIP
 * secret — see lib/magnus-voice / memory: magnus-sip-secret-authority), and
 * if it matches, establish the SAME consumer_sid session used by the
 * phone-OTP realm (lib/consumer-session) — one ConsumerAccount, reachable by
 * either auth path.
 *
 * Security: the password arrives in a query string (Acrobits' own template
 * mechanism — not our choice), so it WILL land in server access logs by
 * default; we do not add to that by ever logging it ourselves. The redirect
 * target is always a clean URL with no query string, so the credentials
 * never linger in the browser's address bar or history.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  signConsumerSessionToken,
  CONSUMER_SESSION_COOKIE,
  CONSUMER_SESSION_MAX_AGE_SECONDS,
  consumerCookieDomain,
} from '@/lib/consumer-session';
import { audit } from '@/lib/audit';
import { publicUrl } from '@/lib/request';

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get('username');
  const password = req.nextUrl.searchParams.get('password');

  // No creds on the URL at all (e.g. someone just navigates to /home
  // directly) — send them to the normal phone-OTP login, not an error page.
  if (!username || !password) {
    return NextResponse.redirect(publicUrl('/consumer/login', req));
  }

  // magnus_sip_username has no DB-level uniqueness constraint today, so this
  // is findFirst rather than findUnique — in practice each provisioned
  // account gets its own username (see lib/voice-provisioning-consumer).
  const account = await prisma.consumerAccount.findFirst({ where: { magnus_sip_username: username } });

  const authFailed =
    !account ||
    account.status !== 'active' ||
    !account.magnus_sip_password ||
    account.magnus_sip_password !== password;

  if (authFailed) {
    // Never log the password itself — username only, and only on failure,
    // for abuse/debugging visibility.
    console.warn('[home] SIP-cred auth failed for username:', username);
    return NextResponse.redirect(publicUrl('/consumer/login?error=sip_auth_failed', req));
  }

  await audit({
    consumerAccountId: account.id,
    actorId: 'system',
    action: 'consumer.signin.sip_cred',
    entity: 'ConsumerAccount',
    entityId: account.id,
    meta: { source: 'acrobits_home_tab' },
  });

  const token = signConsumerSessionToken(account.id);
  // Clean redirect target — no username/password survive into the address
  // bar, browser history, or the Acrobits web-view's back stack.
  const response = NextResponse.redirect(publicUrl('/consumer', req));
  response.cookies.set(CONSUMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    domain: consumerCookieDomain(req),
    maxAge: CONSUMER_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
