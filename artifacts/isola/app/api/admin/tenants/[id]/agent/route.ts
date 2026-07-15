/**
 * POST /api/admin/tenants/[id]/agent
 *
 * Admin: create the Agent record for a tenant that doesn't have one yet.
 * Agent.tenant_id is @unique, so this is a create-if-missing operation —
 * it never duplicates or overwrites an existing Agent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const tenant = await prisma.tenant.findUnique({ where: { id }, include: { agents: true } });
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (tenant.agents.length > 0) {
    return NextResponse.json({ error: 'Tenant already has an Agent record', agent: tenant.agents[0] }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Isola Assistant';

  const agent = await prisma.agent.create({
    data: {
      tenant_id: id,
      name,
      greeting: 'Hello! How can I help you today?',
      intelligence_tier: 'standard',
    },
  });

  await audit({
    tenantId: ctx.user.tenant_id,
    actorId: ctx.user.id,
    action: 'admin.agent.create',
    entity: 'agent',
    entityId: agent.id,
    meta: { target_tenant_id: id, name },
  });

  return NextResponse.json({ agent }, { status: 201 });
}
