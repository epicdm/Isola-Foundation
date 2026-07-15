/**
 * GET /api/consumer/session — returns the current consumer session, if any.
 * P2 consumer auth realm; independent of the operator getSession()/act-as.
 */

import { NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';

export async function GET() {
  const account = await getConsumerSession();
  if (!account) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    consumer_account: {
      id: account.id,
      phone_number: account.phone_number,
      display_name: account.display_name,
      status: account.status,
      voice_provisioning_state: account.voice_provisioning_state,
      magnus_did_number: account.magnus_did_number,
      magnus_sip_username: account.magnus_sip_username,
    },
  });
}
