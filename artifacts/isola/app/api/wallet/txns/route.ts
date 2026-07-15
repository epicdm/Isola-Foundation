import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wallet = await prisma.wallet.findUnique({ where: { tenant_id: ctx.effectiveTenantId } });
  if (!wallet) return NextResponse.json({ txns: [] });

  const txns = await prisma.walletTxn.findMany({
    where: { wallet_id: wallet.id },
    orderBy: { created_at: 'desc' },
    take: 50,
  });
  return NextResponse.json({ txns });
}
