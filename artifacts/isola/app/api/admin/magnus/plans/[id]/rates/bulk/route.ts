/**
 * POST /api/admin/magnus/plans/[id]/rates/bulk
 *
 * Batch rate-set for many rate rows on one plan in a single confirm step.
 * Body:
 *   {
 *     request_id: string,
 *     targets: Array<{ rate_id: string, rateinitial: number }>  // already-
 *       // computed final EC$/min values — the UI computes flat / cost+% /
 *       // delta client-side so the operator can preview from→to before
 *       // this call ever fires.
 *   }
 *
 * Real-money-adjacent, same audit-before-dispatch idempotency contract as
 * the single-rate route: one AuditLog row covers the whole batch, keyed on
 * `request_id`, written BEFORE any Magnus call and updated with per-target
 * results after. A retry with the same request_id never re-dispatches.
 * Writes are issued sequentially against Magnus (no batch endpoint exists
 * there); one target failing does not abort the rest — every result is
 * reported so the operator can see exactly which rates changed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { getPlanRate, updatePlanRateAmount } from '@/lib/magnus-rateplan';

type Params = { params: Promise<{ id: string }> };

interface Target {
  rate_id: string;
  rateinitial: number;
}

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });
  }

  const { id: idPlan } = await params;
  const body = await req.json();
  const { request_id } = body;
  const targets: Target[] = Array.isArray(body.targets) ? body.targets : [];

  if (typeof request_id !== 'string' || !request_id.trim()) {
    return NextResponse.json({ error: 'request_id required' }, { status: 400 });
  }
  if (targets.length === 0) {
    return NextResponse.json({ error: 'At least one target rate is required' }, { status: 400 });
  }
  for (const t of targets) {
    if (!t.rate_id || typeof t.rateinitial !== 'number' || isNaN(t.rateinitial) || t.rateinitial < 0) {
      return NextResponse.json({ error: `Invalid target: ${JSON.stringify(t)}` }, { status: 400 });
    }
  }
  if (targets.length > 500) {
    return NextResponse.json({ error: 'Batch too large (max 500 rates per confirm)' }, { status: 400 });
  }

  // ── Idempotency — a repeated request_id must never re-issue the batch.
  const existing = await prisma.auditLog.findFirst({
    where: { action: 'admin.magnus_rate.bulk_set', request_id },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    const meta = existing.meta as Record<string, unknown>;
    if (meta.dispatching) {
      return NextResponse.json(
        { error: 'A bulk rate change with this request_id was already dispatched and did not finish — verify rates in Magnus manually before retrying with a new request_id.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, results: meta.results, idempotent_replay: true });
  }

  const preRow = await prisma.auditLog.create({
    data: {
      actor_id: ctx.user.id,
      action: 'admin.magnus_rate.bulk_set',
      entity: 'magnus_rate',
      entity_id: idPlan,
      request_id,
      meta: { dispatching: true, id_plan: idPlan, target_count: targets.length },
    },
  });

  const config = getMagnusConfig();
  const results: Array<{ rate_id: string; ok: boolean; rateinitial?: number; previous_rateinitial?: string; error?: string }> = [];

  for (const t of targets) {
    const before = await getPlanRate(config, t.rate_id);
    if (!before || before.idPlan !== idPlan) {
      results.push({ rate_id: t.rate_id, ok: false, error: 'Rate row not found on this plan' });
      continue;
    }
    const result = await updatePlanRateAmount(config, t.rate_id, t.rateinitial);
    if (!result.success) {
      results.push({ rate_id: t.rate_id, ok: false, error: result.error, previous_rateinitial: before.rateinitial });
    } else {
      results.push({ rate_id: t.rate_id, ok: true, rateinitial: t.rateinitial, previous_rateinitial: before.rateinitial });
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;

  await prisma.auditLog.update({
    where: { id: preRow.id },
    data: {
      meta: {
        dispatching: false,
        id_plan: idPlan,
        target_count: targets.length,
        failed_count: failedCount,
        results,
      },
    },
  });

  return NextResponse.json({ ok: failedCount === 0, audit_id: preRow.id, results });
}
