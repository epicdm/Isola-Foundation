import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { setDidDestinationRoute } from '@/lib/magnus-voice';

/**
 * POST /api/voice/forward — flip the tenant's DID between routing to their
 * SIP extension and forwarding to a cell number.
 * Body: { forward_to_cell: boolean, cell_number?: string }
 */
export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { forward_to_cell, cell_number } = body;

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus not configured' }, { status: 503 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: ctx.effectiveTenantId },
    select: {
      magnus_diddestination_id: true,
      magnus_sip_username: true,
      voice_provisioning_state: true,
      voice_cell_number: true,
    },
  });

  if (!tenant?.magnus_diddestination_id || tenant.voice_provisioning_state !== 'completed') {
    return NextResponse.json({ error: 'Voice line is not provisioned yet' }, { status: 400 });
  }

  const nextCellNumber = cell_number !== undefined ? cell_number : tenant.voice_cell_number;

  if (forward_to_cell && !nextCellNumber) {
    return NextResponse.json({ error: 'A cell number is required to enable forward-to-cell' }, { status: 400 });
  }

  try {
    await setDidDestinationRoute(
      getMagnusConfig(),
      tenant.magnus_diddestination_id,
      forward_to_cell
        ? { mode: 'cell', cellNumber: nextCellNumber! }
        : { mode: 'sip' },
    );

    const updated = await prisma.tenant.update({
      where: { id: ctx.effectiveTenantId },
      data: {
        voice_forward_to_cell: !!forward_to_cell,
        ...(cell_number !== undefined && { voice_cell_number: cell_number }),
      },
    });

    await audit({
      tenantId: ctx.effectiveTenantId,
      actorId: ctx.user.id,
      action: 'voice.forward_toggle',
      entity: 'tenant',
      entityId: ctx.effectiveTenantId,
      meta: { forward_to_cell: updated.voice_forward_to_cell },
    });

    return NextResponse.json({
      forward_to_cell: updated.voice_forward_to_cell,
      cell_number: updated.voice_cell_number,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Failed to update routing' }, { status: 502 });
  }
}
