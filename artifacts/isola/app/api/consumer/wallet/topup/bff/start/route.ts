/**
 * POST /api/consumer/wallet/topup/bff/start — server-to-server proxy in
 * front of the BFF Lite `topup/start` endpoint. Session-gated: the
 * signed-in consumer's own magnus_sip_username/magnus_sip_password are
 * injected server-side, never accepted from the request body. The BFF
 * itself owns the actual money movement (Fiserv checkout link for
 * method=card, NBD MoBanking QR + auto-credit via its own email-loop for
 * method=mobanking) — this route only relays the result.
 *
 * Body: { bundleId: string, method: 'card' | 'mobanking', currency?: 'EC$' | 'US$' }
 * `currency` only matters for method=card (Fiserv accepts both EC$/XCD and
 * US$/USD) — mobanking is always EC$.
 *
 * For method=card, this route also builds a `returnUrl` pointing at the
 * canonical CONSUMER_ROOT_ORIGIN (ema.epic.dm) — Eric's RATIFIED domain
 * split (2026-07-13): ema.epic.dm is the canonical domain for the EMA
 * CONSUMER app specifically (isola.epic.dm is the separate Isola B2B
 * platform's canonical domain — NOT used for consumer links).
 * app.isola.epic.dm / pay.isola.epic.dm / test.epic.dm remain live aliases
 * of the same deployment, but outbound consumer links/returnUrls we
 * generate always target ema.epic.dm now, not whatever alias host the
 * consumer happened to start from. This is safe because consumer_sid is
 * issued with `domain: '.epic.dm'` (see lib/consumer-session.ts
 * consumerCookieDomain), so the session cookie is valid on ema.epic.dm
 * regardless of which *.epic.dm alias the consumer originally logged in
 * from.
 *
 * In non-production (localhost/*.replit.dev previews), we still fall back
 * to the PUBLIC host the browser is actually on (x-forwarded-host, via
 * lib/request.ts publicUrl() / memory: nextjs-route-redirect-public-url.md)
 * since isola.epic.dm doesn't resolve to the dev workspace.
 *
 * UAT FIX (2026-07-13): a live top-up returned the payer to
 * isola-foundation.replit.app instead of the intended PWA host. Root cause:
 * this route derives the host from proxy headers correctly, but whether
 * the Fiserv-hosted pay page actually redirects to the returnUrl we send
 * is up to the BFF/pay-page side — if this recurs after this fix, the
 * BFF is either ignoring `returnUrl` or falling back to a stale default
 * on its own end, which is outside Foundation's control and should be
 * reported to CC with the exact returnUrl this route sent (see the
 * `[bff topup] returnUrl` log line below).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { prisma } from '@/lib/prisma';
import { getBffConfig, isBffConfigured } from '@/lib/engines';
import { startTopup, type BffTopupCurrency } from '@/engines/bff';
import { audit } from '@/lib/audit';
import { publicUrl } from '@/lib/request';

// Canonical root domain for the EMA CONSUMER app (Eric, 2026-07-13,
// RATIFIED domain split — ema.epic.dm=EMA consumer app, isola.epic.dm=
// Isola B2B platform) — used for outbound links/returnUrls regardless of
// which *.epic.dm alias the consumer is currently on. Falls back to the
// bare origin if a path can't be built for some reason.
const CONSUMER_ROOT_ORIGIN = 'https://ema.epic.dm';

export async function POST(req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isBffConfigured()) {
    return NextResponse.json({ error: 'Top-up not configured (BFF_BASE_URL / BFF_INTERNAL_SECRET)' }, { status: 503 });
  }

  const voiceLine = await prisma.voiceLine.findFirst({
    where: { identity_id: account.identityId, owner_kind: 'consumer' },
  });

  if (!voiceLine?.magnus_sip_username || !voiceLine.magnus_sip_password) {
    return NextResponse.json({ error: 'Voice account not provisioned yet — try again shortly.' }, { status: 409 });
  }

  // See the matching check in ../options/route.ts — a retired line can
  // still carry stale SIP creds, so distinguish it explicitly instead of
  // falling through to a BFF call that 502s on a missing mirror row.
  if (voiceLine.provisioning_state === 'retired') {
    return NextResponse.json({ error: 'Voice account has been retired.' }, { status: 410 });
  }
  if (voiceLine.provisioning_state !== 'completed') {
    return NextResponse.json({ error: 'Voice account provisioning is not complete — try again shortly.' }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const { bundleId, method, currency } = body ?? {};

  if (!bundleId || (method !== 'card' && method !== 'mobanking')) {
    return NextResponse.json({ error: 'bundleId and method ("card" | "mobanking") are required' }, { status: 400 });
  }

  const bundleCurrency: BffTopupCurrency | undefined =
    currency === 'EC$' || currency === 'US$' ? currency : undefined;

  // card-only: point the Fiserv-hosted checkout page back at the
  // canonical ema.epic.dm wallet screen (consumer_sid's `.epic.dm`
  // cookie domain makes the session valid there regardless of which
  // *.epic.dm alias the consumer started from). In dev, fall back to the
  // PUBLIC host the browser is actually on (x-forwarded-host), since
  // ema.epic.dm doesn't resolve to the dev workspace.
  const returnUrl =
    method === 'card'
      ? process.env.NODE_ENV === 'production'
        ? `${CONSUMER_ROOT_ORIGIN}/consumer/wallet?topup=success`
        : publicUrl('/consumer/wallet?topup=success', req).toString()
      : undefined;
  if (returnUrl) {
    console.info('[bff topup] returnUrl:', returnUrl);
  }

  const result = await startTopup(getBffConfig(), {
    username: voiceLine.magnus_sip_username,
    password: voiceLine.magnus_sip_password,
    bundleId,
    method,
    currency: bundleCurrency,
    returnUrl,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not start top-up' }, { status: 502 });
  }

  await audit({
    consumerAccountId: account.id,
    actorId: 'system',
    action: 'consumer.wallet.topup.bff_started',
    entity: 'wallet',
    meta: { bundleId, method, currency: bundleCurrency },
  });

  return NextResponse.json({
    ok: true,
    url: result.url,
    qrUrl: result.qrUrl,
    amountEc: result.amountEc,
    note: result.note,
  });
}
