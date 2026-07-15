import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { MAGNUS_REGISTRATION_SERVER } from '@/lib/magnus-voice';

/** GET /api/consumer/voice/line — the signed-in consumer's own voice line. */
export async function GET(_req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json({
    state: account.voice_provisioning_state,
    error: account.voice_provisioning_error,
    sip_username: account.magnus_sip_username,
    sip_password: account.magnus_sip_password,
    did_number: account.magnus_did_number,
    registration_server: MAGNUS_REGISTRATION_SERVER,
    forward_to_cell: account.voice_forward_to_cell,
    cell_number: account.voice_cell_number,
  });
}
