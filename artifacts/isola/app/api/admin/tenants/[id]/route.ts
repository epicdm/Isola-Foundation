import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import { getCurrentUsage } from '@/lib/meter';
import { WHATSAPP_NUMBER_PUBLIC_SELECT, toPublicWhatsAppNumbers } from '@/lib/whatsapp-number-public';
import { CHATWOOT_BINDING_PUBLIC_SELECT, toPublicChatwootBindings } from '@/lib/chatwoot-binding-public';

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
        // CB-0: both of these relations are credential-bearing —
        // `WhatsAppNumber.access_token` is a live Meta token and
        // `ChatwootBinding.token` is a Chatwoot Application API agent token.
        // `include: true` returned both to the browser. Admin is a role, not a
        // reason to ship credentials to a client.
        whatsapp_numbers: { select: WHATSAPP_NUMBER_PUBLIC_SELECT },
        chatwoot_bindings: { select: CHATWOOT_BINDING_PUBLIC_SELECT },
        _count: { select: { users: true, conversations: true, wallet_txns: true } },
      },
    }),
    getCurrentUsage(id),
  ]);

  if (!tenant) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Two layers, deliberately — same as `app/api/onboard/whatsapp/route.ts`.
  // The nested selects above keep the credentials out of process memory; these
  // serialisers clamp the response shape even if a select is ever dropped or
  // the rows arrive from somewhere else. A select alone is one edit away from
  // leaking again.
  return NextResponse.json({
    tenant: {
      ...tenant,
      whatsapp_numbers: toPublicWhatsAppNumbers(tenant.whatsapp_numbers),
      chatwoot_bindings: toPublicChatwootBindings(tenant.chatwoot_bindings),
    },
    usage,
  });
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
