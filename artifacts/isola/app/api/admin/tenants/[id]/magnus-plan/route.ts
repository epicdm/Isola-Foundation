/**
 * GET  /api/admin/tenants/[id]/magnus-plan — the tenant's CURRENT Magnus
 *   rate plan, read live from `user.id_plan` (NOT `Tenant.plan`, which is an
 *   unrelated internal starter/growth/pro label).
 * POST /api/admin/tenants/[id]/magnus-plan
 *   Body: { id_plan: string, request_id: string }
 *   Changes which Magnus rate plan the tenant is billed under. Real-money-
 *   adjacent (changes the sell rates applied to every future call) — same
 *   audit-before-dispatch idempotency contract as the credits route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { getUserRatePlanId, setUserRatePlanId, listRatePlans } from '@/lib/magnus-rateplan';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { magnus_user_id: true } });
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!tenant.magnus_user_id) return NextResponse.json({ id_plan: null, plans: [] });
  if (!isMagnusConfigured()) return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });

  try {
    const config = getMagnusConfig();
    const [idPlan, plans] = await Promise.all([
      getUserRatePlanId(config, tenant.magnus_user_id),
      listRatePlans(config),
    ]);
    return NextResponse.json({ id_plan: idPlan, plans });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const { id_plan, request_id } = await req.json();
  if (!id_plan) return NextResponse.json({ error: 'id_plan required' }, { status: 400 });
  if (typeof request_id !== 'string' || !request_id.trim()) {
    return NextResponse.json({ error: 'request_id required' }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { magnus_user_id: true } });
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!tenant.magnus_user_id) return NextResponse.json({ error: 'Tenant has no linked Magnus account' }, { status: 400 });
  if (!isMagnusConfigured()) return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });

  const existing = await prisma.auditLog.findFirst({
    where: { tenant_id: id, action: 'admin.magnus_plan.set', request_id },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    const meta = existing.meta as Record<string, unknown>;
    if (meta.dispatching) {
      return NextResponse.json(
        { error: 'A plan change with this request_id was already dispatched and did not finish — verify the plan in Magnus manually before retrying with a new request_id.' },
        { status: 409 },
      );
    }
    if (meta.ok === false) {
      return NextResponse.json({ error: meta.error ?? 'Plan change failed on a previous attempt' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, id_plan: meta.id_plan, idempotent_replay: true });
  }

  const preRow = await prisma.auditLog.create({
    data: {
      tenant_id: id,
      actor_id: ctx.user.id,
      action: 'admin.magnus_plan.set',
      entity: 'magnus_user',
      entity_id: tenant.magnus_user_id,
      request_id,
      meta: { dispatching: true, id_plan },
    },
  });

  const config = getMagnusConfig();
  const previousIdPlan = await getUserRatePlanId(config, tenant.magnus_user_id);
  const result = await setUserRatePlanId(config, tenant.magnus_user_id, String(id_plan));
  if (!result.success) {
    await prisma.auditLog.update({
      where: { id: preRow.id },
      data: { meta: { dispatching: false, ok: false, error: result.error, id_plan } },
    });
    return NextResponse.json({ error: `Magnus rejected the plan change: ${result.error}`, audit_id: preRow.id }, { status: 502 });
  }

  await prisma.auditLog.update({
    where: { id: preRow.id },
    data: { meta: { dispatching: false, ok: true, id_plan, previous_id_plan: previousIdPlan } },
  });
  return NextResponse.json({ ok: true, id_plan, audit_id: preRow.id });
}
