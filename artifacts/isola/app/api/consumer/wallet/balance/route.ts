import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { prisma } from '@/lib/prisma';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { getBalance } from '@/engines/magnus';

/** GET /api/consumer/wallet/balance — mirrors /api/wallet/balance, scoped to ConsumerAccount. */
export async function GET(_req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wallet = await prisma.wallet.findUnique({ where: { consumer_account_id: account.id } });

  if (!wallet) {
    return NextResponse.json({ balance: null, currency: 'EC$', magnus_configured: false });
  }

  if (isMagnusConfigured() && wallet.magnus_user_id) {
    try {
      const config = getMagnusConfig();
      const live = await getBalance(config, wallet.magnus_user_id);
      if (live) {
        await prisma.wallet.update({ where: { id: wallet.id }, data: { balance_cache: live.balance } });
        return NextResponse.json({ balance: live.balance, currency: live.currency, magnus_configured: true });
      }
    } catch (e: any) {
      console.error('[consumer/wallet/balance] Magnus error:', e.message);
    }
  }

  return NextResponse.json({
    balance: wallet.balance_cache,
    currency: wallet.currency,
    magnus_configured: isMagnusConfigured(),
    cached: true,
  });
}
