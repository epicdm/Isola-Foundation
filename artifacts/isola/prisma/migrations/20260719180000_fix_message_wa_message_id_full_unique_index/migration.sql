-- Neon-schema-reconciliation Phase 0c: Message_wa_message_id_key drift fix.
--
-- schema.prisma declares `wa_message_id String? @unique` (full/non-partial).
-- The baseline migration (20260712031920_baseline) creates it that way too.
-- But the LIVE index on neon is a PARTIAL index (WHERE wa_message_id IS NOT
-- NULL) because instrumentation.ts's hand-rolled runMigrations() created it
-- with that WHERE clause via raw SQL on cold start, before this migration
-- history was ever actually applied to neon (see PM plan
-- bt-neon-schema-reconciliation-campaign Phase 0). Helium already has the
-- full/non-partial index, matching schema.prisma.
--
-- This migration converges both databases on a full/non-partial unique
-- index, using create-concurrently-then-swap so uniqueness enforcement is
-- never dropped, even briefly, and the live table is never locked for
-- writes. Idempotent from either starting shape (partial [neon] or already
-- full [helium]) — same end state either way.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ DO NOT `prisma migrate deploy` THIS MIGRATION DIRECTLY.                 │
-- │                                                                         │
-- │ Confirmed empirically on Prisma 6.19.3 (helium, 2026-07-19): `migrate   │
-- │ deploy` wraps each migration.sql in a transaction with no bypass for    │
-- │ CONCURRENTLY, and fails with P3018 / Postgres 25001 ("CREATE INDEX      │
-- │ CONCURRENTLY cannot run inside a transaction block"). The failed        │
-- │ attempt applies zero steps (safe, no partial index left behind), but it│
-- │ leaves a failed row in _prisma_migrations that blocks all further      │
-- │ `migrate deploy` runs until resolved.                                  │
-- │                                                                         │
-- │ Apply this migration by hand instead, in this exact order:              │
-- │   1. psql "$DATABASE_URL" -c '<statement 1 below>'                     │
-- │   2. psql "$DATABASE_URL" -c '<statement 2 below>'                     │
-- │   3. psql "$DATABASE_URL" -c '<statement 3 below>'                     │
-- │   4. prisma migrate resolve --applied                                   │
-- │        20260719180000_fix_message_wa_message_id_full_unique_index      │
-- │ (bookkeeping only — tells Prisma this migration is done without asking │
-- │ it to execute the SQL). If `migrate deploy` was already attempted and   │
-- │ failed first, clear it with `migrate resolve --rolled-back <name>`      │
-- │ before running the manual steps.                                       │
-- └─────────────────────────────────────────────────────────────────────────┘

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Message_wa_message_id_key_v2" ON "Message"("wa_message_id");

DROP INDEX CONCURRENTLY IF EXISTS "Message_wa_message_id_key";

ALTER INDEX "Message_wa_message_id_key_v2" RENAME TO "Message_wa_message_id_key";
