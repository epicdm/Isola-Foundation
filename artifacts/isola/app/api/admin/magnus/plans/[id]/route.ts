/**
 * GET /api/admin/magnus/plans/[id]?search=... — a rate plan plus its
 * currently configured per-destination rates (operator-only, read-only).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { getRatePlan, listPlanRates } from '@/lib/magnus-rateplan';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });
  }

  const { id } = await params;
  const search = req.nextUrl.searchParams.get('search') ?? undefined;

  try {
    const config = getMagnusConfig();
    const [plan, { rates, totalForPlan }] = await Promise.all([
      getRatePlan(config, id),
      listPlanRates(config, id, { search }),
    ]);
    if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    return NextResponse.json({ plan, rates, totalForPlan });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
