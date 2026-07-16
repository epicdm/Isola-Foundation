/**
 * Ledger Phase B/C — write-path + read-cutover verification.
 *
 * Exercises the EXACT transaction shape used by app/api/wallet/topup/route.ts
 * (WalletTxn.create + Wallet.update increment, P2002-catch skip-on-duplicate)
 * against a disposable scratch Tenant/Wallet created and torn down within
 * this run. No real Fiserv charge — this proves the ledger write/read logic
 * itself (integer amount_minor math, idempotency-key dedup, balance_minor
 * read cutover), which is entirely local DB logic and doesn't depend on the
 * card network. The real end-to-end card path is validated separately
 * (Lane 6 — EPIC's live EC$249 charge).
 *
 * Usage:
 *   DATABASE_URL="<neon>" npx tsx scripts/verify-ledger-write-path.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FAKE_FISERV_REF = `verify-ledger-${Date.now()}`;
const TOPUP_EC_AMOUNT = 25; // EC$25.00
const TOPUP_AMOUNT_MINOR = Math.round(TOPUP_EC_AMOUNT * 100);

async function attemptTopup(walletId: string, tenantId: string) {
  try {
    await prisma.$transaction([
      prisma.walletTxn.create({
        data: {
          tenant_id: tenantId,
          wallet_id: walletId,
          type: 'topup',
          amount_usd: TOPUP_EC_AMOUNT,
          amount_minor: TOPUP_AMOUNT_MINOR,
          currency: 'EC$',
          idempotency_key: FAKE_FISERV_REF,
          description: 'ledger-write-path verification (synthetic, not a real charge)',
          ref: FAKE_FISERV_REF,
        },
      }),
      prisma.wallet.update({
        where: { id: walletId },
        data: {
          balance_cache: { increment: TOPUP_EC_AMOUNT },
          balance_minor: { increment: TOPUP_AMOUNT_MINOR },
        },
      }),
    ]);
    return { credited: true };
  } catch (err: any) {
    if (err?.code === 'P2002') return { credited: false, skipped: 'duplicate_idempotency_key' };
    throw err;
  }
}

async function main() {
  console.log('=== Ledger write-path verification ===');
  console.log(`DATABASE_URL host: ${new URL(process.env.DATABASE_URL || '').host}`);

  let pass = true;
  let tenantId: string | undefined;

  try {
    const tenant = await prisma.tenant.create({
      data: { business_name: 'LEDGER-VERIFY-SCRATCH (auto-deleted)', status: 'suspended' },
    });
    tenantId = tenant.id;
    const wallet = await prisma.wallet.create({
      data: { tenant_id: tenant.id, balance_cache: 0, balance_minor: 0 },
    });
    console.log(`Scratch tenant=${tenant.id} wallet=${wallet.id}`);

    // ── Call 1: fresh idempotency key → should credit ──────────────────────
    const r1 = await attemptTopup(wallet.id, tenant.id);
    console.log(`Call 1 (fresh ref): ${JSON.stringify(r1)}`);
    if (!r1.credited) {
      pass = false;
      console.error('FAIL: first topup with a fresh idempotency_key did not credit');
    }

    // ── Call 2: SAME idempotency key (simulated Fiserv retry) → must skip ──
    const r2 = await attemptTopup(wallet.id, tenant.id);
    console.log(`Call 2 (replayed ref): ${JSON.stringify(r2)}`);
    if (r2.credited) {
      pass = false;
      console.error('FAIL: replayed idempotency_key credited a SECOND time — double-credit bug');
    }

    // ── Verify integer amount_minor + no double-credit on balance ──────────
    const finalWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const txns = await prisma.walletTxn.findMany({ where: { wallet_id: wallet.id }, orderBy: { created_at: 'asc' } });

    console.log(`WalletTxn rows written: ${txns.length} (expected 1 — replay must not create a second row)`);
    console.log(`balance_minor=${finalWallet.balance_minor} balance_cache=${finalWallet.balance_cache} (expected ${TOPUP_AMOUNT_MINOR} / ${TOPUP_EC_AMOUNT})`);

    if (txns.length !== 1) {
      pass = false;
      console.error(`FAIL: expected exactly 1 WalletTxn row, found ${txns.length}`);
    }
    if (!Number.isInteger(finalWallet.balance_minor)) {
      pass = false;
      console.error('FAIL: balance_minor is not an integer');
    }
    if (finalWallet.balance_minor !== TOPUP_AMOUNT_MINOR) {
      pass = false;
      console.error(`FAIL: balance_minor=${finalWallet.balance_minor}, expected ${TOPUP_AMOUNT_MINOR} (no double-credit)`);
    }
    if (!Number.isInteger(txns[0]?.amount_minor)) {
      pass = false;
      console.error('FAIL: WalletTxn.amount_minor is not an integer');
    }

    // ── Verify read-cutover: balance_minor-derived read matches ────────────
    // Mirrors the exact expression in app/api/wallet/balance/route.ts L-C cutover.
    const readCutoverBalance = finalWallet.balance_minor != null ? finalWallet.balance_minor / 100 : finalWallet.balance_cache;
    console.log(`Read cutover (balance_minor/100)=${readCutoverBalance} vs legacy balance_cache=${finalWallet.balance_cache}`);
    if (readCutoverBalance !== finalWallet.balance_cache) {
      pass = false;
      console.error('FAIL: balance_minor-derived read does not match balance_cache — reads would diverge');
    }
  } finally {
    // ── Teardown: always remove scratch rows, pass or fail ─────────────────
    if (tenantId) {
      const wallet = await prisma.wallet.findUnique({ where: { tenant_id: tenantId } });
      if (wallet) {
        await prisma.walletTxn.deleteMany({ where: { wallet_id: wallet.id } });
        await prisma.wallet.delete({ where: { id: wallet.id } });
      }
      await prisma.tenant.delete({ where: { id: tenantId } });
      console.log(`Teardown complete — scratch tenant=${tenantId} removed`);
    }
  }

  console.log(pass ? '\n=== PASS ===' : '\n=== FAIL ===');
  if (!pass) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('ERR', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
