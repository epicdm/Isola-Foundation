/**
 * Ledger Phase A — minor-unit backfill.
 *
 * Populates WalletTxn.amount_minor = round(amount_usd*100) and
 * Wallet.balance_minor = round(balance_cache*100) for every existing row.
 * Data-only: amount_minor/balance_minor are not read anywhere yet, so this
 * is safe to run repeatedly (idempotent) and safe to roll back.
 *
 * Rounding is done in Postgres (round()), not in JS, so the value written
 * here always matches whatever an independent SQL verify computes.
 *
 * Usage:
 *   DATABASE_URL="<neon>" npx tsx scripts/backfill-ledger-minor.ts --dry-run
 *   DATABASE_URL="<neon>" npx tsx scripts/backfill-ledger-minor.ts --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function countPending(): Promise<{ walletTxn: number; wallet: number }> {
  const walletTxnPending = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "WalletTxn"
    WHERE amount_minor IS DISTINCT FROM ROUND(amount_usd * 100)::int
  `;
  const walletPending = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "Wallet"
    WHERE balance_minor IS DISTINCT FROM ROUND(balance_cache * 100)::int
  `;
  return {
    walletTxn: Number(walletTxnPending[0].count),
    wallet: Number(walletPending[0].count),
  };
}

async function main() {
  console.log(`=== Ledger minor-unit backfill — mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log(`DATABASE_URL host: ${new URL(process.env.DATABASE_URL || '').host}`);

  const walletTxnTotal = await prisma.walletTxn.count();
  const walletTotal = await prisma.wallet.count();
  const before = await countPending();

  console.log(`WalletTxn: ${walletTxnTotal} total, ${before.walletTxn} would change`);
  console.log(`Wallet: ${walletTotal} total, ${before.wallet} would change`);

  if (APPLY) {
    const txnResult = await prisma.$executeRaw`
      UPDATE "WalletTxn"
      SET amount_minor = ROUND(amount_usd * 100)::int
      WHERE amount_minor IS DISTINCT FROM ROUND(amount_usd * 100)::int
    `;
    const walletResult = await prisma.$executeRaw`
      UPDATE "Wallet"
      SET balance_minor = ROUND(balance_cache * 100)::int
      WHERE balance_minor IS DISTINCT FROM ROUND(balance_cache * 100)::int
    `;
    console.log(`WalletTxn rows updated: ${txnResult}`);
    console.log(`Wallet rows updated: ${walletResult}`);

    const after = await countPending();
    console.log('\n=== VERIFY (post-run) ===');
    console.log(`WalletTxn rows NOT matching round(amount_usd*100): ${after.walletTxn}`);
    console.log(`Wallet rows NOT matching round(balance_cache*100): ${after.wallet}`);
  }

  console.log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'} complete ===`);
}

main()
  .catch((e) => {
    console.error('ERR', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
