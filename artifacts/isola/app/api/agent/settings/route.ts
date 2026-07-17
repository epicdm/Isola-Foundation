import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const agent = await prisma.agent.findFirst({
    where: { tenant_id: ctx.effectiveTenantId },
  });
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  return NextResponse.json({ agent });
}

export async function PUT(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const {
    name,
    greeting,
    business_info,
    knowledge_text,
    intelligence_tier,
    after_hours_start,
    after_hours_end,
    timezone,
    is_active,
  } = body;

  // tenant_id is no longer @unique (S4 multi-agent). Resolve the agent being
  // edited: the dashboard settings page always targets the tenant's default
  // (first) agent. If somehow none exists yet, create one.
  const existingAgent = await prisma.agent.findFirst({
    where: { tenant_id: ctx.effectiveTenantId },
  });

  const agentData = {
    ...(name !== undefined && { name }),
    ...(greeting !== undefined && { greeting }),
    ...(business_info !== undefined && { business_info }),
    ...(knowledge_text !== undefined && { knowledge_text }),
    ...(intelligence_tier !== undefined && { intelligence_tier }),
    ...(after_hours_start !== undefined && { after_hours_start }),
    ...(after_hours_end !== undefined && { after_hours_end }),
    ...(timezone !== undefined && { timezone }),
    ...(is_active !== undefined && { is_active }),
  };

  const agent = existingAgent
    ? await prisma.agent.update({ where: { id: existingAgent.id }, data: agentData })
    : await prisma.agent.create({
        data: {
          tenant_id: ctx.effectiveTenantId,
          name: name ?? 'Isola Assistant',
          greeting: greeting ?? 'Hello! How can I help you today?',
          business_info: business_info ?? '',
          knowledge_text: knowledge_text ?? '',
          intelligence_tier: intelligence_tier ?? 'standard',
          after_hours_start,
          after_hours_end,
          timezone: timezone ?? 'America/Dominica',
          is_active: is_active ?? true,
        },
      });

  await audit({
    tenantId: ctx.effectiveTenantId,
    actorId: ctx.user.id,
    action: 'agent.update',
    entity: 'agent',
    entityId: agent.id,
    meta: { changes: Object.keys(body) },
  });

  return NextResponse.json({ agent });
}
