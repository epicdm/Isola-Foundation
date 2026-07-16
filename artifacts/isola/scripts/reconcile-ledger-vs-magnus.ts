/**
 * Ledger Phase C — reconcile vs Magnus.
 *
 * For every Wallet with a live Magnus link (magnus_user_id set), compares
 * the local ledger balance (Wallet.balance_minor, integer cents) against
 * Magnus's live `user.credit` (the actual billing-gating balance). Read-only:
 * this script NEVER writes to Wallet or WalletTxn — drift is flagged, not
 * silently auto-corrected (a wrong auto-correction on a real-money ledger is
 * worse than a visible alert). Confirmed drift is written to AuditLog
 * (action `ledger.reconcile.drift`) so it survives past this run's stdout,
 * plus printed to the console either way.
 *
 * A one-cent tolerance absorbs float/rounding noise between amount_usd-based
 * float math and the minor-unit integer path — anything beyond that is a
 * real discrepancy (a write that skipped the ledger, an out-of-band Magnus
 * refill, etc.) and gets flagged.
 *
 * Usage:
 *   DATABASE_URL="<neon>" MAGNUS_URL=... MAGNUS_API_KEY=... MAGNUS_API_SECRET=... \
 *     npx tsx scripts/reconcile-ledger-vs-magnus.ts
 */
import { PrismaClient } from '@prisma/client';
import { getMagnusConfig, isMagnusConfigured } from '../lib/engines';
import { getBalance } from '../engines/magnus';

const prisma = new PrismaClient();
const TOLERANCE_MINOR = 1; // 1 cent

async function main() {
  if (!isMagnusConfigured()) {
    console.error('Magnus not configured — set MAGNUS_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET');
    process.exit(1);
  }
  const config = getMagnusConfig();

  console.log('=== Ledger vs Magnus reconcile ===');
  console.log(`DATABASE_URL host: ${new URL(process.env.DATABASE_URL || '').host}`);

  const wallets = await prisma.wallet.findMany({
    where: { magnus_user_id: { not: null } },
    select: { id: true, tenant_id: true, consumer_account_id: true, magnus_user_id: true, balance_minor: true, balance_cache: true },
  });

  console.log(`${wallets.length} wallet(s) with a Magnus link\n`);

  let okCount = 0;
  let driftCount = 0;
  let errorCount = 0;

  for (const wallet of wallets) {
    const owner = wallet.tenant_id ? `tenant:${wallet.tenant_id}` : `consumer:${wallet.consumer_account_id}`;
    try {
      const live = await getBalance(config, wallet.magnus_user_id!);
      if (!live) {
        console.log(`SKIP  wallet=${wallet.id} ${owner} magnus_user_id=${wallet.magnus_user_id} — Magnus user not found`);
        continue;
      }

      const liveMinor = Math.round(live.balance * 100);
      const localMinor = wallet.balance_minor ?? Math.round(wallet.balance_cache * 100);
      const diffMinor = liveMinor - localMinor;

      if (Math.abs(diffMinor) <= TOLERANCE_MINOR) {
        okCount++;
        console.log(`OK    wallet=${wallet.id} ${owner} local=${localMinor} magnus=${liveMinor}`);
        continue;
      }

      driftCount++;
      console.error(
        `DRIFT wallet=${wallet.id} ${owner} local=${localMinor} magnus=${liveMinor} diff=${diffMinor} (EC$${(diffMinor / 100).toFixed(2)})`,
      );

      await prisma.auditLog.create({
        data: {
          tenant_id: wallet.tenant_id ?? undefined,
          consumer_account_id: wallet.consumer_account_id ?? undefined,
          actor_id: 'system:reconcile-ledger-vs-magnus',
          action: 'ledger.reconcile.drift',
          entity: 'wallet',
          entity_id: wallet.id,
          meta: {
            magnus_user_id: wallet.magnus_user_id,
            local_balance_minor: localMinor,
            magnus_balance_minor: liveMinor,
            diff_minor: diffMinor,
          },
        },
      });
    } catch (e: any) {
      errorCount++;
      console.error(`ERROR wallet=${wallet.id} ${owner}: ${e?.message ?? e}`);
    }
  }

  console.log(`\n=== Summary: ${okCount} ok, ${driftCount} drift, ${errorCount} error (of ${wallets.length}) ===`);
  if (driftCount > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('ERR', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
