import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { MAGNUS_REGISTRATION_SERVER } from '@/lib/magnus-voice';
import { redactSecret } from '@/lib/redact-secret';

/**
 * GET /api/voice/line — the owner's own provisioned voice line details.
 *
 * P0 CONTAINMENT 2026-08-12: the operator-realm twin of
 * app/api/consumer/voice/line. It carried the identical defect — returning
 * `sip_password` (the plaintext SIP registration secret) into a browser
 * response, which app/(owner)/voice/page.tsx then rendered, linked as
 * `csc:<user>:<pass>@…` and encoded into a QR image.
 *
 * The owner page's mask/reveal toggle was NOT containment: the full value was
 * in the JSON body and the DOM regardless of which way the toggle was set.
 *
 * Removed, not masked — see the consumer route for the full reasoning.
 */
export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const voiceLine = await prisma.voiceLine.findFirst({
    where: { tenant_id: ctx.effectiveTenantId, owner_kind: 'business' },
  });

  if (!voiceLine) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    state: voiceLine.provisioning_state,
    // See the consumer twin: upstream Magnus errors can echo the credential
    // they rejected, so redact before this leaves the server.
    error: redactSecret(voiceLine.provisioning_error, voiceLine.magnus_sip_password),
    sip_username: voiceLine.magnus_sip_username,
    activation_state: 'unavailable' as const,
    did_number: voiceLine.magnus_did_number,
    registration_server: MAGNUS_REGISTRATION_SERVER,
    forward_to_cell: voiceLine.voice_forward_to_cell,
    cell_number: voiceLine.voice_cell_number,
  });
}
