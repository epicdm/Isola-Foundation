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
import { prisma } from '@/lib/prisma';
import { getBffConfig, isBffConfigured, getNbdManualAccount, defaultTopupCurrency } from '@/lib/engines';
import { getTopupOptions } from '@/engines/bff';

export async function GET() {
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

  // A line can carry stale-but-present SIP creds after being retired
  // (sub-resource ids torn down out-of-band, creds left on the record) —
  // the presence check above alone can't tell that apart from "still
  // provisioning," so distinguish retired explicitly with 410 Gone rather
  // than letting it fall through to a BFF call that 502s on a missing
  // mirror row. See bt-foundation-wallet-topup-502.
  if (voiceLine.provisioning_state === 'retired') {
    return NextResponse.json({ error: 'Voice account has been retired.' }, { status: 410 });
  }
  if (voiceLine.provisioning_state !== 'completed') {
    return NextResponse.json({ error: 'Voice account provisioning is not complete — try again shortly.' }, { status: 409 });
  }

  const result = await getTopupOptions(getBffConfig(), {
    username: voiceLine.magnus_sip_username,
    password: voiceLine.magnus_sip_password,
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
