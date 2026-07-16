import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { isMagnusConfigured } from '@/lib/engines';
import { callEngine } from '@/lib/connector';

// ── Resolve import path for the engine client ────────────────────────────────
// Engine clients live at artifacts/isola/engines/ (imported relative to app/api/wallet/)

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wallet = await prisma.wallet.findUnique({
    where: { tenant_id: ctx.effectiveTenantId },
  });

  if (!wallet) {
    return NextResponse.json({ balance: null, currency: 'EC$', magnus_configured: false });
  }

  // If Magnus is configured + wallet has a magnus_user_id, fetch live balance
  if (isMagnusConfigured() && wallet.magnus_user_id) {
    try {
      const live = await callEngine('magnus', 'getBalance', [wallet.magnus_user_id], {
        tenant: { tenantId: ctx.effectiveTenantId },
        actorId: ctx.user.id,
        entity: 'wallet',
        entityId: wallet.id,
      });
      if (live) {
        // Update cached balance
        await prisma.wallet.update({
          where: { id: wallet.id },
          data: { balance_cache: live.balance },
        });
        return NextResponse.json({
          balance: live.balance,
          currency: live.currency,
          magnus_configured: true,
        });
      }
    } catch (e: any) {
      console.error('[wallet/balance] Magnus error:', e.message);
    }
  }

  return NextResponse.json({
    balance: wallet.balance_cache,
    currency: wallet.currency,
    magnus_configured: isMagnusConfigured(),
    cached: true,
  });
}
