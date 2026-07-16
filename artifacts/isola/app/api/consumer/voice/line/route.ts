import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { prisma } from '@/lib/prisma';
import { MAGNUS_REGISTRATION_SERVER } from '@/lib/magnus-voice';

/** GET /api/consumer/voice/line — the signed-in consumer's own voice line. */
export async function GET(_req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const voiceLine = await prisma.voiceLine.findFirst({
    where: { identity_id: account.identityId, owner_kind: 'consumer' },
  });
  if (!voiceLine) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    state: voiceLine.provisioning_state,
    error: voiceLine.provisioning_error,
    sip_username: voiceLine.magnus_sip_username,
    sip_password: voiceLine.magnus_sip_password,
    did_number: voiceLine.magnus_did_number,
    registration_server: MAGNUS_REGISTRATION_SERVER,
    forward_to_cell: voiceLine.voice_forward_to_cell,
    cell_number: voiceLine.voice_cell_number,
  });
}
