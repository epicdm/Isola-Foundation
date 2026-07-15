/**
 * POST /api/consumer/auth/verify-otp — P2 consumer phone-OTP auth realm.
 * Body: { phone_number: string, code: string }
 *
 * On success: find-or-create ConsumerAccount by phone_number; on first
 * signup, call provisionConsumerVoice() (Magnus DID/SIP/wallet); issue a
 * consumer session cookie. Entirely separate from the operator/Replit Auth
 * realm — no shared cookie, no resolveSession/act-as involvement.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  normalizePhone,
  verifyOtp,
  OtpInvalidError,
  OtpLockedError,
} from '@/lib/consumer-otp';
import { provisionConsumerVoice } from '@/lib/voice-provisioning-consumer';
import {
  signConsumerSessionToken,
  CONSUMER_SESSION_COOKIE,
  CONSUMER_SESSION_MAX_AGE_SECONDS,
  consumerCookieDomain,
} from '@/lib/consumer-session';
import { audit } from '@/lib/audit';

export async function POST(req: NextRequest) {
  let body: { phone_number?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.phone_number || !body.code) {
    return NextResponse.json({ error: 'phone_number and code are required' }, { status: 400 });
  }

  let phoneNumber: string;
  try {
    phoneNumber = normalizePhone(body.phone_number);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    await verifyOtp(phoneNumber, body.code.trim());
  } catch (err) {
    if (err instanceof OtpLockedError) {
      return NextResponse.json({ error: err.message }, { status: 423 });
    }
    if (err instanceof OtpInvalidError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[consumer/verify-otp] Unexpected error:', err);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }

  let account = await prisma.consumerAccount.findUnique({ where: { phone_number: phoneNumber } });
  const isNewAccount = !account;

  if (!account) {
    account = await prisma.consumerAccount.create({ data: { phone_number: phoneNumber } });
    await audit({
      consumerAccountId: account.id,
      actorId: 'system',
      action: 'consumer.signup',
      entity: 'ConsumerAccount',
      entityId: account.id,
    });

    try {
      await provisionConsumerVoice(account.id);
      account = await prisma.consumerAccount.findUniqueOrThrow({ where: { id: account.id } });
    } catch (err) {
      console.error('[consumer/verify-otp] Voice provisioning failed:', err);
      // Account still exists (created); provisioning state/error is persisted
      // on the row by provisionConsumerVoice's own step-machine. Re-fetch so
      // the response reflects the real (failed) state rather than stale data.
      account = await prisma.consumerAccount.findUnique({ where: { id: account.id } });
    }
  } else {
    await audit({
      consumerAccountId: account.id,
      actorId: 'system',
      action: 'consumer.signin',
      entity: 'ConsumerAccount',
      entityId: account.id,
    });
  }

  if (!account) {
    return NextResponse.json({ error: 'Account lookup failed after creation' }, { status: 500 });
  }

  const token = signConsumerSessionToken(account.id);
  const response = NextResponse.json({
    ok: true,
    is_new_account: isNewAccount,
    consumer_account: {
      id: account.id,
      phone_number: account.phone_number,
      display_name: account.display_name,
      status: account.status,
      voice_provisioning_state: account.voice_provisioning_state,
      voice_provisioning_error: account.voice_provisioning_error,
      magnus_did_number: account.magnus_did_number,
      magnus_sip_username: account.magnus_sip_username,
    },
  });
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
