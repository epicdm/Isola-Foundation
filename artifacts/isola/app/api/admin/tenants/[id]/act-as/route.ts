/**
 * POST /api/admin/tenants/[id]/act-as
 * Body: { enabled: boolean }
 *
 * Admin: set or clear the act_as_tenant_id on their user record.
 * When enabled, subsequent requests from this admin are scoped to tenant [id].
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
  const { enabled } = await req.json() as { enabled: boolean };

  // Verify tenant exists
  if (enabled) {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  await prisma.user.update({
    where: { id: ctx.user.id },
    data: { act_as_tenant_id: enabled ? id : null },
  });

  await audit({
    tenantId: ctx.user.tenant_id,
    actorId: ctx.user.id,
    action: enabled ? 'admin.act_as.enable' : 'admin.act_as.disable',
    meta: { target_tenant_id: id },
  });

  return NextResponse.json({ ok: true, act_as_tenant_id: enabled ? id : null });
}
