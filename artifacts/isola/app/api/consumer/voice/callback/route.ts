/**
 * POST /api/consumer/voice/callback — server-to-server proxy in front of
 * the BFF Lite `/api/lite/callback` endpoint (the "call without installing
 * Acrobits" feature). Session-gated: the signed-in consumer's own SIP
 * creds and ownerPhone are injected server-side, never accepted from the
 * request body — the browser only ever sends the destination number.
 *
 * Flow this triggers on the BFF/Magnus side: Magnus rings the consumer's
 * OWN registered number first (fromNumber = account.phone_number); once
 * they answer, Magnus dials the destination and bridges the two legs,
 * wallet-metered. No VoIP/data softphone involved on the consumer's end.
 *
 * Body: { destination: string } — Dominica number in any common format
 * (local 7-digit, 767XXXXXXX, 1767XXXXXXX, +1767XXXXXXX) today. See
 * lib/dominica-phone.ts for why only Dominica destinations are supported
 * right now (a temporary Magnus trunk workaround, not a permanent
 * restriction) and for the CALLBACK_ALLOW_ALL_DESTINATIONS flag that lifts
 * it once that's fixed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { getBffConfig, isBffConfigured } from '@/lib/engines';
import { startCallback } from '@/engines/bff';
import { normalizeCallbackDestination } from '@/lib/dominica-phone';
import { audit } from '@/lib/audit';

export async function POST(req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isBffConfigured()) {
    return NextResponse.json({ error: 'Calling is not configured (BFF_BASE_URL / BFF_INTERNAL_SECRET)' }, { status: 503 });
  }

  if (!account.magnus_sip_username || !account.magnus_sip_password) {
    return NextResponse.json({ error: 'Voice account not provisioned yet \u2014 try again shortly.' }, { status: 409 });
  }

  if (!account.phone_number) {
    return NextResponse.json({ error: 'Your account has no registered number to ring.' }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const destinationRaw = typeof body?.destination === 'string' ? body.destination : '';

  const normalized = normalizeCallbackDestination(destinationRaw);
  if (!normalized.ok || !normalized.e164) {
    return NextResponse.json({ error: normalized.error ?? 'Enter a valid destination number.' }, { status: 422 });
  }

  const result = await startCallback(getBffConfig(), {
    sipUsername: account.magnus_sip_username,
    sipPassword: account.magnus_sip_password,
    fromNumber: account.phone_number,
    toDominicaNumber: normalized.e164,
  });

  // Never log the destination-attempt failure with credentials attached —
  // this log line intentionally omits sipPassword (it's never passed here).
  if (!result.ok) {
    console.warn('[consumer callback] failed:', result.errorKind, 'for account', account.id);
    const status =
      result.errorKind === 'rate_limited' ? 429 :
      result.errorKind === 'insufficient_balance' ? 402 :
      result.errorKind === 'bad_destination' ? 422 :
      result.errorKind === 'bad_from_number' ? 400 :
      502;
    return NextResponse.json({ error: result.error ?? 'Could not start the call', errorKind: result.errorKind }, { status });
  }

  await audit({
    consumerAccountId: account.id,
    actorId: 'system',
    action: 'consumer.voice.callback_started',
    entity: 'call',
    entityId: result.callId,
    meta: { destination: normalized.e164 },
  });

  return NextResponse.json({
    ok: true,
    callId: result.callId,
    message: result.message,
    ownerPhone: account.phone_number,
    destination: normalized.e164,
  }, { status: 202 });
}
