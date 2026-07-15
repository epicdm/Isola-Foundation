import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { prisma } from '@/lib/prisma';

export async function GET(_req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wallet = await prisma.wallet.findUnique({ where: { consumer_account_id: account.id } });
  if (!wallet) return NextResponse.json({ txns: [] });

  const txns = await prisma.walletTxn.findMany({
    where: { wallet_id: wallet.id },
    orderBy: { created_at: 'desc' },
    take: 50,
  });
  return NextResponse.json({ txns });
}
