-- Migrate-deploy foundation Phase A: adopt ConsumerLead into tracked
-- migration history.
--
-- This table has existed on both helium and neon since P6 (EMA landing-page
-- funnel attribution), created only via instrumentation.ts's runMigrations()
-- raw SQL — no tracked migration authored it, so it was invisible to
-- `prisma migrate diff` / `migrate deploy` bookkeeping (see
-- bt-neon-schema-reconciliation-campaign Phase 0 findings). This migration
-- matches schema.prisma's ConsumerLead model and the existing raw-SQL shape
-- exactly (same columns, same index names as the raw
-- CREATE TABLE/CREATE INDEX IF NOT EXISTS statements), so on helium/neon
-- it is adopted via `prisma migrate resolve --applied` (bookkeeping only,
-- not executed) and on any fresh database it is a real CREATE.
--
-- See bt-migrate-deploy-foundation Phase A.

-- CreateTable
CREATE TABLE "ConsumerLead" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "referrer" TEXT,
    "landing_path" TEXT,
    "cta" TEXT,
    "odoo_lead_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumerLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsumerLead_created_at_idx" ON "ConsumerLead"("created_at");

-- CreateIndex
CREATE INDEX "ConsumerLead_utm_source_utm_campaign_idx" ON "ConsumerLead"("utm_source", "utm_campaign");
