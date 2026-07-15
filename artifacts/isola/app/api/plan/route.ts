import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getCurrentUsage } from '@/lib/meter';
import { PLAN_PRICES } from '@/lib/plans';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [subscription, usage] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenant_id: ctx.effectiveTenantId } }),
    getCurrentUsage(ctx.effectiveTenantId),
  ]);

  return NextResponse.json({
    subscription,
    usage,
    plans: PLAN_PRICES,
  });
}
