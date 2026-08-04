-- Additive only: one nullable column, no default, no index, no constraint,
-- no backfill. See xp-foundation-staff-chat-clawith-tenant-id-correction-2026-08-04.
ALTER TABLE "ClawithBinding" ADD COLUMN "clawith_tenant_id" TEXT;
