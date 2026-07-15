import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { MAGNUS_REGISTRATION_SERVER } from '@/lib/magnus-voice';

/** GET /api/voice/line — the owner's own provisioned voice line details. */
export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const tenant = await prisma.tenant.findUnique({
    where: { id: ctx.effectiveTenantId },
    select: {
      voice_provisioning_state: true,
      voice_provisioning_error: true,
      magnus_sip_username: true,
      magnus_sip_password: true,
      magnus_did_number: true,
      voice_forward_to_cell: true,
      voice_cell_number: true,
    },
  });

  if (!tenant) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    state: tenant.voice_provisioning_state,
    error: tenant.voice_provisioning_error,
    sip_username: tenant.magnus_sip_username,
    sip_password: tenant.magnus_sip_password,
    did_number: tenant.magnus_did_number,
    registration_server: MAGNUS_REGISTRATION_SERVER,
    forward_to_cell: tenant.voice_forward_to_cell,
    cell_number: tenant.voice_cell_number,
  });
}
