/**
 * POST /api/admin/magnus/plans/[id]/rates
 * Body (edit existing rate):
 *   { rate_id: string, rateinitial: number, request_id: string }
 * Body (create a new rate for a prefix not yet configured on this plan):
 *   { id_prefix: string, id_trunk_group: string, rateinitial: number, request_id: string }
 *
 * Real-money-adjacent: `rateinitial` is the live per-minute sell rate that
 * gates what a customer on this plan is billed. Same audit-before-dispatch
 * idempotency contract as /api/admin/tenants/[id]/credits — an AuditLog row
 * is written BEFORE the Magnus call, then updated with the outcome, keyed on
 * `request_id` so a retry never re-issues the write.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { updatePlanRateAmount, createPlanRate, getPlanRate } from '@/lib/magnus-rateplan';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });
  }

  const { id: idPlan } = await params;
  const body = await req.json();
  const { rate_id, id_prefix, id_trunk_group, rateinitial, request_id } = body;

  const rateNum = parseFloat(String(rateinitial));
  if (isNaN(rateNum) || rateNum < 0) {
    return NextResponse.json({ error: 'Invalid rateinitial' }, { status: 400 });
  }
  if (typeof request_id !== 'string' || !request_id.trim()) {
    return NextResponse.json({ error: 'request_id required' }, { status: 400 });
  }
  const isEdit = !!rate_id;
  if (!isEdit && (!id_prefix || !id_trunk_group)) {
    return NextResponse.json({ error: 'id_prefix and id_trunk_group required to create a new rate' }, { status: 400 });
  }

  // ── Idempotency — a repeated request_id must never re-issue the Magnus call.
  const existing = await prisma.auditLog.findFirst({
    where: { action: 'admin.magnus_rate.set', request_id },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    const meta = existing.meta as Record<string, unknown>;
    if (meta.dispatching) {
      return NextResponse.json(
        { error: 'A rate change with this request_id was already dispatched and did not finish — verify the rate in Magnus manually before retrying with a new request_id.' },
        { status: 409 },
      );
    }
    if (meta.ok === false) {
      return NextResponse.json({ error: meta.error ?? 'Rate change failed on a previous attempt' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, rate_id: meta.rate_id, idempotent_replay: true });
  }

  const preRow = await prisma.auditLog.create({
    data: {
      actor_id: ctx.user.id,
      action: 'admin.magnus_rate.set',
      entity: 'magnus_rate',
      entity_id: rate_id ?? null,
      request_id,
      meta: { dispatching: true, id_plan: idPlan, rate_id: rate_id ?? null, id_prefix: id_prefix ?? null, rateinitial: rateNum },
    },
  });

  const config = getMagnusConfig();

  if (isEdit) {
    // Confirm the rate row actually belongs to this plan before writing.
    const before = await getPlanRate(config, rate_id);
    if (!before || before.idPlan !== idPlan) {
      await prisma.auditLog.update({
        where: { id: preRow.id },
        data: { meta: { dispatching: false, ok: false, error: 'Rate row not found on this plan' } },
      });
      return NextResponse.json({ error: 'Rate row not found on this plan' }, { status: 404 });
    }
    const result = await updatePlanRateAmount(config, rate_id, rateNum);
    if (!result.success) {
      await prisma.auditLog.update({
        where: { id: preRow.id },
        data: { meta: { dispatching: false, ok: false, error: result.error, id_plan: idPlan, rate_id } },
      });
      return NextResponse.json({ error: `Magnus rejected the rate update: ${result.error}`, audit_id: preRow.id }, { status: 502 });
    }
    await prisma.auditLog.update({
      where: { id: preRow.id },
      data: { meta: { dispatching: false, ok: true, id_plan: idPlan, rate_id, rateinitial: rateNum, previous_rateinitial: before.rateinitial } },
    });
    return NextResponse.json({ ok: true, rate_id, audit_id: preRow.id });
  }

  const result = await createPlanRate(config, { idPlan, idPrefix: id_prefix, idTrunkGroup: id_trunk_group, rateinitial: rateNum });
  if (!result.success) {
    await prisma.auditLog.update({
      where: { id: preRow.id },
      data: { meta: { dispatching: false, ok: false, error: result.error, id_plan: idPlan, id_prefix } },
    });
    return NextResponse.json({ error: `Magnus rejected the new rate: ${result.error}`, audit_id: preRow.id }, { status: 502 });
  }
  await prisma.auditLog.update({
    where: { id: preRow.id },
    data: { meta: { dispatching: false, ok: true, id_plan: idPlan, rate_id: result.rateId, id_prefix, rateinitial: rateNum } },
  });
  return NextResponse.json({ ok: true, rate_id: result.rateId, audit_id: preRow.id });
}
