/**
 * POST /api/consumer/auth/request-otp — P2 consumer phone-OTP auth realm.
 * Body: { phone_number: string } (E.164)
 *
 * Never touches the operator Replit Auth realm, Tenant, agent/webhook/
 * agent-tools adapter, or act-as/session logic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { normalizePhone, requestOtp, OtpRateLimitError } from '@/lib/consumer-otp';
import { sendConsumerOtp } from '@/lib/consumer-whatsapp-otp';

export async function POST(req: NextRequest) {
  let body: { phone_number?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.phone_number) {
    return NextResponse.json({ error: 'phone_number is required' }, { status: 400 });
  }

  let phoneNumber: string;
  try {
    phoneNumber = normalizePhone(body.phone_number);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  let code: string;
  try {
    const otp = await requestOtp(phoneNumber);
    code = otp.code;
  } catch (err) {
    if (err instanceof OtpRateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    console.error('[consumer/request-otp] Failed to create OTP:', err);
    return NextResponse.json({ error: 'Failed to generate code' }, { status: 500 });
  }

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    // Dev-only visibility so the flow is testable without a live handset.
    // The WhatsApp send below still hits the real Graph API regardless.
    console.log(`[consumer/request-otp][DEV ONLY] code for ${phoneNumber}: ${code}`);
  }

  let sendResult;
  try {
    sendResult = await sendConsumerOtp(phoneNumber, code);
  } catch (err) {
    console.error('[consumer/request-otp] WhatsApp send threw:', err);
    return NextResponse.json({ error: 'Failed to send WhatsApp message' }, { status: 502 });
  }

  if (!sendResult.ok) {
    console.error('[consumer/request-otp] WhatsApp send failed at API level:', sendResult.error);
    return NextResponse.json(
      { error: 'WhatsApp message could not be sent', detail: sendResult.error },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    delivery: {
      mechanism: sendResult.mechanism,
      template_dependency_flagged: sendResult.templateDependencyFlagged,
    },
    ...(isProd ? {} : { dev_code: code }),
  });
}
