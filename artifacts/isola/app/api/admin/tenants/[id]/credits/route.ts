/**
 * POST /api/admin/tenants/[id]/credits
 * Body: { amount: number, description: string, request_id: string }
 *
 * Admin credit adjustment — positive = add credit, negative = debit.
 * This is real money: it funds the SAME Magnus (MagnusBilling) account
 * balance that gates outbound calls, not just a local display number.
 *
 * Money-safety contract (see .agents/memory for the live verification this
 * was built against):
 *   1. When the tenant has a linked, configured Magnus account, the Magnus
 *      refill call is the gate — it MUST succeed before any local wallet
 *      ledger/balance write happens. addCredit()/debitCredit() never throw;
 *      their `.success` field must be checked explicitly (verified live that
 *      a resolved-but-failed refill/save leaves user.credit unchanged).
 *   2. Idempotent via `request_id` (same convention as
 *      /api/agent-tools/invoke): an AuditLog row is written BEFORE the
 *      Magnus call ("dispatching"), then updated with the outcome. A retry
 *      with the same request_id never re-issues the Magnus call — it either
 *      replays the prior result (already ok/failed) or, for a request
 *      interrupted mid-flight, is rejected with 409 rather than guessing.
 *   3. Negative adjustments (debits) use a symmetric Magnus debit
 *      (refill/save with credit=-amount) — verified live against production
 *      `refill` rows (reversals/consolidations already use this exact
 *      pattern) — rather than being blocked, since Magnus does support it
 *      cleanly with no floor-at-zero or rejection behavior observed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { addCredit, debitCredit } from '@/engines/magnus';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const { amount, description, request_id } = await req.json();

  const amountNum = parseFloat(String(amount));
  if (isNaN(amountNum) || amountNum === 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }
  if (!description?.trim()) {
    return NextResponse.json({ error: 'description required' }, { status: 400 });
  }
  if (typeof request_id !== 'string' || !request_id.trim()) {
    return NextResponse.json({ error: 'request_id required' }, { status: 400 });
  }

  // ── Idempotency — a repeated request_id must never re-issue the Magnus call.
  const existing = await prisma.auditLog.findFirst({
    where: { tenant_id: id, action: 'admin.credits.adjust', request_id },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    const meta = existing.meta as Record<string, unknown>;
    if (meta.dispatching) {
      return NextResponse.json(
        {
          error:
            'An adjustment with this request_id was already dispatched and did not finish — verify the Magnus balance manually before retrying with a new request_id.',
        },
        { status: 409 },
      );
    }
    if (meta.ok === false) {
      return NextResponse.json({ error: meta.error ?? 'Adjustment failed on a previous attempt' }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      new_balance_cache: meta.new_balance_cache,
      magnus_synced: meta.magnus_synced,
      idempotent_replay: true,
    });
  }

  const wallet = await prisma.wallet.findUnique({ where: { tenant_id: id } });
  if (!wallet) return NextResponse.json({ error: 'Wallet not found for tenant' }, { status: 404 });

  // AUDIT-BEFORE-DISPATCH — the row exists before the Magnus call fires, so an
  // interrupted request is detectable on retry instead of silently re-firing.
  const preRow = await prisma.auditLog.create({
    data: {
      tenant_id: ctx.user.tenant_id,
      actor_id: ctx.user.id,
      action: 'admin.credits.adjust',
      entity: 'wallet',
      entity_id: wallet.id,
      request_id,
      meta: { dispatching: true, amount: amountNum, description: description.trim(), target_tenant_id: id },
    },
  });

  const magnusEligible = !!wallet.magnus_user_id && isMagnusConfigured();
  let magnusSynced = false;

  if (magnusEligible) {
    const magnusConfig = getMagnusConfig();
    const magResult = amountNum > 0
      ? await addCredit(magnusConfig, wallet.magnus_user_id!, amountNum, description.trim())
      : await debitCredit(magnusConfig, wallet.magnus_user_id!, Math.abs(amountNum), description.trim());

    if (!magResult.success) {
      // Do NOT touch the local ledger/balance — funding did not happen.
      await prisma.auditLog.update({
        where: { id: preRow.id },
        data: {
          meta: { dispatching: false, ok: false, amount: amountNum, description: description.trim(), target_tenant_id: id, error: magResult.error },
        },
      });
      return NextResponse.json({ error: `Magnus funding failed: ${magResult.error}`, audit_id: preRow.id }, { status: 502 });
    }
    magnusSynced = true;
  }

  // Local ledger — only reached once Magnus succeeded (or there was nothing
  // to sync, e.g. tenant has no linked Magnus account yet).
  const [, updatedWallet] = await prisma.$transaction([
    prisma.walletTxn.create({
      data: {
        tenant_id: id,
        wallet_id: wallet.id,
        type: 'credit_adjust',
        amount_usd: amountNum,
        description: description.trim(),
        ref: `admin:${ctx.user.id}`,
      },
    }),
    prisma.wallet.update({
      where: { id: wallet.id },
      data: { balance_cache: { increment: amountNum } },
    }),
  ]);

  await prisma.auditLog.update({
    where: { id: preRow.id },
    data: {
      meta: {
        dispatching: false,
        ok: true,
        amount: amountNum,
        description: description.trim(),
        target_tenant_id: id,
        magnus_synced: magnusSynced,
        new_balance_cache: updatedWallet.balance_cache,
      },
    },
  });

  return NextResponse.json({ ok: true, new_balance_cache: updatedWallet.balance_cache, magnus_synced: magnusSynced, audit_id: preRow.id });
}
