/**
 * GET /api/consumer/wallet/topup/bff/options — server-to-server proxy in
 * front of the BFF Lite `topup/options` endpoint. Session-gated: the
 * signed-in consumer's own magnus_sip_username/magnus_sip_password are
 * looked up server-side and injected into the BFF call. The browser never
 * sees the SIP password or BFF_INTERNAL_SECRET — only the resulting bundle
 * and payment-method list.
 *
 * Currency: getTopupOptions() (engines/bff.ts) already maps the BFF's raw
 * ISO currency codes ("USD"/"XCD") to our display vocabulary ("US$"/"EC$")
 * at its own boundary — every bundle returned here already carries the
 * correct display currency, so this route does not re-interpret it.
 */

import { NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { getBffConfig, isBffConfigured, getNbdManualAccount, defaultTopupCurrency } from '@/lib/engines';
import { getTopupOptions } from '@/engines/bff';

export async function GET() {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isBffConfigured()) {
    return NextResponse.json({ error: 'Top-up not configured (BFF_BASE_URL / BFF_INTERNAL_SECRET)' }, { status: 503 });
  }

  if (!account.magnus_sip_username || !account.magnus_sip_password) {
    return NextResponse.json({ error: 'Voice account not provisioned yet — try again shortly.' }, { status: 409 });
  }

  const result = await getTopupOptions(getBffConfig(), {
    username: account.magnus_sip_username,
    password: account.magnus_sip_password,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not load top-up options' }, { status: 502 });
  }

  const usdAvailable = result.bundles.some((b) => b.currency === 'US$');

  // Account NUMBER/NAME are not secrets (they're the public wire details a
  // customer types into their own banking app), so it's fine to relay them
  // here alongside the bundle list.
  return NextResponse.json({
    bundles: result.bundles,
    methods: result.methods,
    currency: 'EC$', // legacy top-level field kept for older clients; per-bundle `currency` is authoritative now.
    defaultCurrency: defaultTopupCurrency(account.phone_number),
    usdAvailable,
    nbdManual: getNbdManualAccount(),
  });
}
