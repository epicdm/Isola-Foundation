import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import { getCurrentUsage } from '@/lib/meter';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const [tenant, usage] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: true,
        wallet: true,
        agents: true,
        whatsapp_numbers: true,
        chatwoot_bindings: true,
        _count: { select: { users: true, conversations: true, wallet_txns: true } },
      },
    }),
    getCurrentUsage(id),
  ]);

  if (!tenant) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ tenant, usage });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await req.json();
  const { business_name, plan, status, magnus_user_id, brain_provider, flowise_flow_id } = body;

  const tenant = await prisma.tenant.update({
    where: { id },
    data: {
      ...(business_name !== undefined && { business_name }),
      ...(status !== undefined && { status }),
      ...(magnus_user_id !== undefined && { magnus_user_id }),
    },
  });

  if (plan !== undefined) {
    await prisma.subscription.upsert({
      where: { tenant_id: id },
      create: { tenant_id: id, plan, status: 'active' },
      update: { plan },
    });
    await prisma.tenant.update({ where: { id }, data: { plan } });
  }

  // Brain-provider flip: which runtime (native Claude vs external Flowise flow)
  // answers this tenant's messages. Guard against enabling flowise without a
  // flow id — that would silently no-op back to native inside generateReply().
  if (brain_provider !== undefined || flowise_flow_id !== undefined) {
    if (brain_provider === 'flowise') {
      const nextFlowId = flowise_flow_id ?? (await prisma.agent.findFirst({
        where: { tenant_id: id },
        select: { flowise_flow_id: true },
      }))?.flowise_flow_id;
      if (!nextFlowId) {
        return NextResponse.json(
          { error: 'flowise_flow_id is required to set brain_provider=flowise' },
          { status: 400 },
        );
      }
    }
    // tenant_id is no longer @unique (S4 multi-agent); updateMany targets all
    // agents under the tenant, which matches the intended blanket admin flip.
    await prisma.agent.updateMany({
      where: { tenant_id: id },
      data: {
        ...(brain_provider !== undefined && { brain_provider }),
        ...(flowise_flow_id !== undefined && { flowise_flow_id }),
      },
    });
  }

  await audit({
    tenantId: ctx.user.tenant_id,
    actorId: ctx.user.id,
    action: 'admin.tenant.update',
    entity: 'tenant',
    entityId: id,
    meta: { changes: Object.keys(body) },
  });

  return NextResponse.json({ tenant });
}
