-- Hardens EscalationRef into a fully scoped capability
-- (def-clawith-escalation-shared-token-no-agent-principal-2026-07-21).
-- NOT APPLIED — hand-authored per repo convention for review before a
-- separately-approved `prisma migrate deploy` against Neon. Do NOT run
-- `prisma db push` / `migrate dev` against this database.

-- AlterTable
ALTER TABLE "EscalationRef" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'escalate_to_human';
ALTER TABLE "EscalationRef" ADD COLUMN "clawith_agent_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "EscalationRef" ADD COLUMN "chatwoot_binding_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "EscalationRef" ADD COLUMN "chatwoot_inbox_id" TEXT;
ALTER TABLE "EscalationRef" ADD COLUMN "correlation_id" TEXT;

-- Backfill correlation_id for any pre-existing rows (none expected in prod —
-- these tokens are 15-minute-TTL and this migration is not yet applied —
-- but keep the column populate-then-constrain to be safe if it ever is).
UPDATE "EscalationRef" SET "correlation_id" = "id" WHERE "correlation_id" IS NULL;
ALTER TABLE "EscalationRef" ALTER COLUMN "correlation_id" SET NOT NULL;

-- Drop the temporary defaults now that application code always supplies
-- real values — new rows must specify them explicitly.
ALTER TABLE "EscalationRef" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "EscalationRef" ALTER COLUMN "clawith_agent_id" DROP DEFAULT;
ALTER TABLE "EscalationRef" ALTER COLUMN "chatwoot_binding_id" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "EscalationRef_correlation_id_key" ON "EscalationRef"("correlation_id");
