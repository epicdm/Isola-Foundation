/**
 * POST /api/agent/takeover
 * Body: { enabled: boolean }
 *
 * Owner enables/disables their takeover flag.
 * When enabled = true: AI goes silent for this tenant; owner handles messages manually.
 * When enabled = false: AI resumes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { enabled } = await req.json() as { enabled: boolean };
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: '`enabled` must be a boolean' }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id: ctx.user.id },
    data: { agent_took_over: enabled },
  });

  await audit({
    tenantId: ctx.effectiveTenantId,
    actorId: ctx.user.id,
    action: enabled ? 'takeover.enable' : 'takeover.disable',
    entity: 'user',
    entityId: ctx.user.id,
  });

  return NextResponse.json({ agent_took_over: user.agent_took_over });
}
