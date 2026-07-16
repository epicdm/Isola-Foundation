import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { MAGNUS_REGISTRATION_SERVER } from '@/lib/magnus-voice';

/** GET /api/voice/line — the owner's own provisioned voice line details. */
export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const voiceLine = await prisma.voiceLine.findFirst({
    where: { tenant_id: ctx.effectiveTenantId, owner_kind: 'business' },
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
