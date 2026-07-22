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
-- Safe on zero rows: "EscalationRef" is a short-TTL (15 min), single-purpose
-- capability-token table gated behind an allowlist that is currently empty for
-- every phone_number_id, and was confirmed to hold 0 rows in production
-- immediately before this migration was authored. Adding NOT NULL columns with no
-- default therefore needs no backfill step. The guard below turns a would-be
-- generic Postgres NOT NULL violation into a clear, intentional stop if that
-- invariant ever turns out to be false at deploy time. The `IF NOT EXISTS` guards
-- make this migration idempotent if re-run, or if any of these objects already
-- exist for another reason.
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
BEGIN
  IF EXISTS (SELECT 1 FROM "EscalationRef") THEN
    RAISE EXCEPTION 'EscalationRef repair migration expects zero existing rows (confirmed empty in production on 2026-07-22); found existing rows instead. Stopping before the NOT NULL column adds below — review whether this invariant changed and what backfill those existing rows need before proceeding.';
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
