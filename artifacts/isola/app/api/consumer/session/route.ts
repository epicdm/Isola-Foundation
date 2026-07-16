/**
 * GET /api/consumer/session — returns the current consumer session, if any.
 * P2 consumer auth realm; independent of the operator getSession()/act-as.
 */

import { NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const account = await getConsumerSession();
  if (!account) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  const voiceLine = await prisma.voiceLine.findFirst({
    where: { identity_id: account.identityId, owner_kind: 'consumer' },
  });
  return NextResponse.json({
    authenticated: true,
    consumer_account: {
      id: account.id,
      phone_number: account.phone_number,
      display_name: account.display_name,
      status: account.status,
      voice_provisioning_state: voiceLine?.provisioning_state ?? 'not_provisioned',
      magnus_did_number: voiceLine?.magnus_did_number ?? null,
      magnus_sip_username: voiceLine?.magnus_sip_username ?? null,
    },
  });
}
