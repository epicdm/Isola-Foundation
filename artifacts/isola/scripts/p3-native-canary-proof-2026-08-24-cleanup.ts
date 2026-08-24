/**
 * Manual rollback for p3-native-canary-proof-2026-08-24.ts — use ONLY if
 * that script's process was killed/crashed after Step 2 (Foundation row
 * created) but before its `finally` block ran Step 6 (row removed). Under
 * normal termination (including any error inside the try block) the main
 * script's own finally already deletes the row; this is the manual fallback
 * for an external kill/crash that skipped even that.
 *
 * Touches ONLY rows carrying the exact synthetic test identity this proof
 * uses — never any real customer identity. Deletes ZERO Magnus state; this
 * is a Foundation-database-only cleanup.
 *
 * Run with: pnpm --filter @workspace/isola exec tsx scripts/p3-native-canary-proof-2026-08-24-cleanup.ts
 */
import { prisma } from '../lib/prisma';

const TEST_IDENTITY_ID = 'voice-p3-native-proof-2026-08-24';

async function main() {
  const existing = await prisma.voiceLine.findMany({ where: { identity_id: TEST_IDENTITY_ID } });
  console.log(JSON.stringify({ step: 'found', count: existing.length, ids: existing.map((l) => l.id) }));

  if (existing.length === 0) {
    console.log(JSON.stringify({ step: 'DONE', verdict: 'nothing to clean up — no row exists for the test identity' }));
    return;
  }

  const result = await prisma.voiceLine.deleteMany({ where: { identity_id: TEST_IDENTITY_ID } });
  console.log(JSON.stringify({ step: 'DONE', verdict: 'cleaned up', deletedCount: result.count }));
}

main()
  .catch((e) => {
    console.error(JSON.stringify({ step: 'FATAL', error: e?.message ?? String(e) }));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
