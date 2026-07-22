-- Repair migration for the "EscalationRef" table.
--
-- Defect: migration 20260721020000_harden_escalation_ref was marked "finished" in
-- _prisma_migrations (via `prisma migrate resolve --applied`, applied_steps_count=1,
-- the standard marker that command writes) but its DDL was never actually executed
-- against production. This left the live "EscalationRef" table at its original
-- 6-column shape (id, tenant_id, conversation_id, token, expires_at, created_at)
-- while prisma/schema.prisma and lib/escalation-ref.ts have assumed the hardened
-- 11-column/1-index shape since 2026-07-21. Confirmed via direct
-- information_schema/pg_catalog inspection of production Neon on 2026-07-22, and
-- reproduced byte-for-byte in a disposable database by deploying the pre-harden
-- migrations for real and then running `migrate resolve --applied` on the harden
-- migration without its SQL, per defect-foundation-migration-resolved-without-
-- execution-2026-07-22.
--
-- This migration is forward-only and does not edit, re-resolve, or replace
-- 20260721020000_harden_escalation_ref — that migration's ledger entry is left
-- exactly as-is; rewriting migration history is out of scope. Instead this adds
-- the missing columns/index directly, so `prisma migrate deploy` brings any
-- environment (fresh-from-zero, or already drifted like production) to the exact
-- schema Prisma has expected since 20260721020000 was authored. The added SQL was
-- derived from `prisma migrate diff --from-url <drifted db> --to-schema-datamodel
-- prisma/schema.prisma --script`, not hand-guessed.
--
-- State-dependent safety guard (revised per Codex review on PR #50 — the original
-- unconditional zero-row guard would have wrongly failed an already-hardened
-- database that happens to hold live rows, even though every statement below
-- would be a no-op there):
--
-- Column-by-column safety classification for adding to a table that may already
-- have rows, derived from prisma/schema.prisma and the three prior migrations:
--   "purpose"             -- SAFE:   NOT NULL, but has a DEFAULT. Postgres 11+
--                             backfills existing rows from the default without a
--                             table rewrite; no data loss, no manual backfill.
--   "chatwoot_inbox_id"   -- SAFE:   nullable; existing rows simply get NULL.
--   "clawith_agent_id"    -- UNSAFE: NOT NULL, no default. Cannot be added to a
--   "chatwoot_binding_id" --         populated table without a real backfill —
--   "correlation_id"      --         Postgres would reject every existing row.
--   unique index on
--   "correlation_id"       -- SELF-GUARDING: CREATE UNIQUE INDEX IF NOT EXISTS is
--                             a no-op if the index already exists, and Postgres
--                             itself will reject the CREATE (aborting the whole
--                             migration transaction) if "correlation_id" already
--                             holds duplicate non-null values — no separate check
--                             needed; native uniqueness enforcement is sufficient
--                             and this migration deliberately does not attempt to
--                             deduplicate or rewrite any existing row to work
--                             around that.
--
-- So the only state that is actually unsafe to run this migration's DDL against
-- is: the table has one or more rows, AND at least one of the three UNSAFE
-- columns above is still missing. In that state we stop before any DDL runs
-- (Postgres migrations run inside a transaction, so a RAISE EXCEPTION here rolls
-- back cleanly — no partial columns, no partial index, no row touched, and
-- `prisma migrate deploy` records the migration as failed, never as applied).
-- Every other state — zero rows regardless of which columns are missing, or a
-- fully/partially-hardened table with rows where only the SAFE objects above are
-- still missing — is left to proceed, because every remaining statement below is
-- provably safe (idempotent, default-backed, nullable, or self-guarding) for a
-- populated table. This migration never inspects or modifies the CONTENTS of any
-- existing row — only whether specific columns/index exist.
--
-- Out of scope, deliberately not touched: the Drizzle/Replit-Auth-owned "users"
-- and "sessions" tables surface unrelated drift (varchar-vs-text column types,
-- primary-key constraint recreation, an index rename, a dropped index) against
-- this same Prisma schema diff. Those tables are @@ignore'd in prisma/schema.prisma
-- (DrizzleUser / DrizzleSession models) and explicitly documented there as not
-- Prisma's to modify or drop — see Port decision
-- dec-prisma-drift-scope-managed-tables-2026-07-22. This migration touches
-- "EscalationRef" only.
--
-- Do NOT add any phone_number_id to ESCALATION_REF_ALLOWED_PNIDS until this
-- migration has been applied to production AND independently re-verified
-- (columns present, mint/resolve round-trip tested) — the allowlist gate in
-- lib/brain-provider.ts is the only thing currently preventing every
-- Clawith-routed inbound message from crashing on `column EscalationRef.purpose
-- does not exist` the moment escalate_to_human is invoked.

DO $$
DECLARE
  has_rows       boolean;
  missing_unsafe boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM "EscalationRef") INTO has_rows;

  SELECT
       NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'EscalationRef' AND column_name = 'clawith_agent_id'
       )
    OR NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'EscalationRef' AND column_name = 'chatwoot_binding_id'
       )
    OR NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'EscalationRef' AND column_name = 'correlation_id'
       )
  INTO missing_unsafe;

  IF has_rows AND missing_unsafe THEN
    RAISE EXCEPTION 'EscalationRef repair migration: table has existing rows and is still missing one or more of clawith_agent_id / chatwoot_binding_id / correlation_id (all NOT NULL with no default). These cannot be safely added to a populated table by this migration — Postgres would reject every existing row, and this migration deliberately does not backfill or guess values for them. Stopping before any DDL. Write and run an explicit, reviewed backfill migration for the existing rows first (populating all three fields from their real bound values), then re-run this repair, which will then find the unsafe columns already present and proceed safely.';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "EscalationRef"
  ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT 'escalate_to_human',
  ADD COLUMN IF NOT EXISTS "clawith_agent_id" TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS "chatwoot_binding_id" TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS "chatwoot_inbox_id" TEXT,
  ADD COLUMN IF NOT EXISTS "correlation_id" TEXT NOT NULL;

-- On a fresh-from-zero build, 20260721020000_harden_escalation_ref already added
-- "purpose" for real and then explicitly dropped its own temporary default,
-- so the ADD COLUMN IF NOT EXISTS above is a no-op for "purpose" in that path and
-- the default would otherwise be missing there while present on a drifted-then-
-- repaired database. Set it unconditionally so both paths converge on the same
-- schema, matching schema.prisma's `@default("escalate_to_human")`.
ALTER TABLE "EscalationRef" ALTER COLUMN "purpose" SET DEFAULT 'escalate_to_human';

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EscalationRef_correlation_id_key" ON "EscalationRef"("correlation_id");
