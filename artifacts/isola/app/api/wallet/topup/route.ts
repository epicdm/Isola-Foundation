/**
 * POST /api/wallet/topup
 *
 * Charges a credit card via Fiserv, then credits Magnus + records WalletTxn.
 * IMPORTANT: Fiserv is gated by FISERV_CHARGE_ENABLED logic in this handler.
 * The engine's charge() function makes a REAL charge on every call — the gate lives here.
 *
 * Body: { cardNumber, expMonth, expYear, cvv, amount, currency, payerName, payerEmail, payerAddress }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getFiservConfig, getMagnusConfig, isMagnusConfigured, isFiservConfigured } from '@/lib/engines';
import { audit } from '@/lib/audit';
import { charge } from '@/engines/fiserv';
import { addCredit } from '@/engines/magnus';
import { usdToEcd } from '@/lib/currency';

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isFiservConfigured()) {
    return NextResponse.json({ error: 'Payment gateway not configured (FISERV_API_KEY)' }, { status: 503 });
  }

  // Explicit kill-switch: FISERV_CHARGE_ENABLED must be set to "true" before
  // real card charges are permitted.  This prevents accidental charges during
  // development or staging.
  if (process.env.FISERV_CHARGE_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Payment processing is disabled — set FISERV_CHARGE_ENABLED=true to enable live charges' },
      { status: 503 },
    );
  }

  const body = await req.json();
  const {
    cardNumber, expMonth, expYear, cvv,
    amount, currency = 'XCD',
    payerName, payerEmail, payerAddress,
  } = body;

  if (!cardNumber || !expMonth || !expYear || !cvv || !amount || !payerName) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const amountNum = parseFloat(String(amount));
  if (isNaN(amountNum) || amountNum <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  // FX: Magnus (and this app's Wallet balance) is EC$-denominated (see
  // lib/currency.ts). Fiserv charges the CARD in `currency` as-is — that
  // part was always correct. But the amount credited to the wallet must be
  // converted to EC$ when the charge currency is USD, or a US$10 charge was
  // silently crediting only EC$10 instead of ~EC$27 (the 1:1 FX bug, fixed
  // 2026-07-13). XCD/EC$ charges are already EC$ — no conversion needed.
  const isUsd = currency.toUpperCase() === 'USD' || currency === 'US$';
  const ecAmount = isUsd ? usdToEcd(amountNum) : amountNum;

  const fiservConfig = getFiservConfig();

  // ── Gate: real charge ──────────────────────────────────────────────────────
  const result = await charge(fiservConfig, {
    cardNumber, expMonth, expYear, cvv,
    amount: amountNum,
    currency,
    payerName,
    payerEmail: payerEmail ?? '',
    payerAddress: payerAddress ?? '',
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Card declined' }, { status: 402 });
  }

  // ── Credit Magnus if wallet has a magnus_user_id ──────────────────────────
  const wallet = await prisma.wallet.findUnique({
    where: { tenant_id: ctx.effectiveTenantId },
  });

  let magnusCredited = false;
  if (wallet?.magnus_user_id && isMagnusConfigured()) {
    try {
      const magResult = await addCredit(getMagnusConfig(), wallet.magnus_user_id, ecAmount);
      magnusCredited = magResult.success;
      if (!magResult.success) {
        console.error('[topup] Magnus credit failed:', magResult.error);
      }
    } catch (e: any) {
      console.error('[topup] Magnus error:', e.message);
    }
  }

  // ── Record WalletTxn ──────────────────────────────────────────────────────
  // amount_usd stores the EC$ amount credited (matches convention elsewhere
  // in this table — see admin credits route / voice-provisioning-consumer —
  // NOT the raw charge amount in whatever currency the card was billed in).
  //
  // idempotency_key = result.ref (Fiserv's transaction reference), claimed via
  // WalletTxn.idempotency_key's UNIQUE constraint (ledger-phase-a) rather than
  // a check-then-act read — same race-safe pattern as lib/inbound-dedup.ts. A
  // duplicate delivery of the same successful charge (e.g. a client retry that
  // Fiserv itself resolves to the same ref) must credit the wallet at most
  // once. amount_minor is the integer-cents mirror of ecAmount, written
  // alongside amount_usd/balance_cache (not yet the read path — see L-C).
  let alreadyCredited = false;
  if (wallet) {
    const amountMinor = Math.round(ecAmount * 100);
    try {
      await prisma.$transaction([
        prisma.walletTxn.create({
          data: {
            tenant_id: ctx.effectiveTenantId,
            wallet_id: wallet.id,
            type: 'topup',
            amount_usd: ecAmount,
            amount_minor: amountMinor,
            currency: 'EC$',
            idempotency_key: result.ref,
            description: isUsd
              ? `Top-up via card — ${amountNum.toFixed(2)} USD → ${ecAmount.toFixed(2)} EC$`
              : `Top-up via card — ${currency}`,
            ref: result.ref,
          },
        }),
        prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            balance_cache: { increment: ecAmount },
            balance_minor: { increment: amountMinor },
          },
        }),
      ]);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Fiserv ref already recorded — the charge succeeded once already and
        // was credited then. Do NOT re-credit; the card was charged exactly
        // once regardless (Fiserv resolved the retry to the same ref), so
        // crediting again here would be the double-credit this phase closes.
        alreadyCredited = true;
        console.error(`[topup] Duplicate Fiserv ref ${result.ref} — wallet already credited, skipping re-credit`);
      } else {
        throw err;
      }
    }
  }

  await audit({
    tenantId: ctx.effectiveTenantId,
    actorId: ctx.user.id,
    action: 'wallet.topup',
    meta: { amount: amountNum, currency, ec_credited: ecAmount, ref: result.ref, magnus_credited: magnusCredited, already_credited: alreadyCredited },
  });

  return NextResponse.json({ ok: true, ref: result.ref, status: result.status, already_credited: alreadyCredited });
}
