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
-- CONCURRENTLY cannot run inside a transaction; Prisma Migrate detects this
-- keyword and applies the migration outside its default transaction wrapper.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Message_wa_message_id_key_v2" ON "Message"("wa_message_id");

DROP INDEX CONCURRENTLY IF EXISTS "Message_wa_message_id_key";

ALTER INDEX "Message_wa_message_id_key_v2" RENAME TO "Message_wa_message_id_key";
