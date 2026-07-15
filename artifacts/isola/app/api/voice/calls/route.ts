import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { syncMinutesFromCDR } from '@/lib/meter';
import { getCalls } from '@/engines/magnus';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ calls: [], magnus_configured: false });
  }

  const wallet = await prisma.wallet.findUnique({
    where: { tenant_id: ctx.effectiveTenantId },
    select: { magnus_user_id: true },
  });

  if (!wallet?.magnus_user_id) {
    return NextResponse.json({ calls: [], magnus_configured: true, magnus_user_id_missing: true });
  }

  const limitParam = new URL(req.url).searchParams.get('limit');
  const displayLimit = limitParam ? parseInt(limitParam, 10) : 30;

  try {
    // Fetch a broader set so we can meter the full current month accurately.
    // The display slice is returned to the UI; the full set is used for metering.
    const allCalls = await getCalls(getMagnusConfig(), wallet.magnus_user_id, 500);

    // Sync this month's answered-call minutes to the usage meter (idempotent).
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthBillsec = (allCalls as any[])
      .filter((c) => c.disposition === 'ANSWERED' && new Date(c.call_date) >= monthStart)
      .reduce((sum, c) => sum + (Number(c.billsec) || 0), 0);

    // Fire-and-forget — don't block the response on meter write
    syncMinutesFromCDR(ctx.effectiveTenantId, monthBillsec).catch((e) =>
      console.error('[voice/calls] meter sync failed:', e?.message),
    );

    const calls = (allCalls as any[]).slice(0, displayLimit);
    return NextResponse.json({ calls, magnus_configured: true });
  } catch (e: any) {
    console.error('[voice/calls]', e.message);
    return NextResponse.json({ error: 'Failed to fetch calls', calls: [] }, { status: 502 });
  }
}
