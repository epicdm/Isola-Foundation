import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';

// GET /api/admin/tenants — list all tenants
export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const tenants = await prisma.tenant.findMany({
    // The tenant LIST returned every tenant's plaintext SIP registration
    // password to any staff admin. Same reasoning as
    // `app/api/admin/tenants/[id]/route.ts`: the owner-visible surface for this
    // credential is `/api/voice/line`, not the admin console, and nothing in
    // the admin UI reads it.
    omit: { magnus_sip_password: true },
    include: {
      subscription: true,
      wallet: { select: { balance_cache: true, currency: true } },
      agents: { select: { id: true, name: true, brain_provider: true, flowise_flow_id: true } },
      _count: { select: { users: true, conversations: true } },
    },
    orderBy: { created_at: 'desc' },
  });

  return NextResponse.json({ tenants });
}

// POST /api/admin/tenants — admin onboards a new tenant
export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { business_name, plan = 'starter', owner_email } = await req.json();
  if (!business_name?.trim()) {
    return NextResponse.json({ error: 'business_name required' }, { status: 400 });
  }

  // Create tenant shell
  const tenant = await prisma.tenant.create({
    data: { business_name: business_name.trim(), plan, status: 'active' },
  });

  await prisma.subscription.create({
    data: { tenant_id: tenant.id, plan, status: 'active' },
  });
  await prisma.wallet.create({
    data: { tenant_id: tenant.id, balance_cache: 0, balance_minor: 0 },
  });
  const agent = await prisma.agent.create({
    data: {
      tenant_id: tenant.id,
      name: 'Isola Assistant',
      greeting: 'Hello! How can I help you today?',
      intelligence_tier: 'standard',
    },
  });

  // Pre-create owner user if email supplied (replit_id left null until they sign in)
  if (owner_email?.trim()) {
    await prisma.user.create({
      data: {
        tenant_id: tenant.id,
        replit_id: `pending:${owner_email.trim()}`,  // placeholder until linked
        role: 'owner',
        email: owner_email.trim(),
      },
    });
  }

  await audit({
    tenantId: ctx.user.tenant_id, // admin's own tenant
    actorId: ctx.user.id,
    action: 'admin.tenant.create',
    entity: 'tenant',
    entityId: tenant.id,
    meta: { business_name, plan, owner_email, agent_id: agent.id },
  });

  return NextResponse.json({ tenant, agent }, { status: 201 });
}
