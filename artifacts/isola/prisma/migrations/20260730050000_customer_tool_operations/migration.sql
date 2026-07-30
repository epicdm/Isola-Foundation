-- Governed customer-tool operations: the exactly-once ledger for Tools 2-5.
--
-- Additive only. One new table, its indexes and one foreign key. Nothing is
-- altered, renamed or dropped.
--
-- SCOPE NOTE, read this before regenerating.
--   `prisma migrate diff --from-url <production>` against this datamodel also
--   emits ALTER/RENAME statements for the legacy `sessions` and `users` tables
--   (varchar -> text, index renames). That drift PRE-DATES this change, is
--   unrelated to it, and is deliberately NOT included here. A migration that
--   quietly carries someone elses pending drift is how an additive slice
--   becomes an incident. The drift is recorded as a separate finding.
--
-- IF THIS RE-RUNS: it will fail on the duplicate table rather than silently
-- diverge. `IF NOT EXISTS` is deliberately absent - a migration that cannot
-- tell "already applied" from "applied differently" is worse than one that
-- stops.

-- CreateTable
CREATE TABLE "CustomerToolOperation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "agent_session_id" TEXT,
    "state" TEXT NOT NULL DEFAULT claimed,
    "result_model" TEXT,
    "result_id" INTEGER,
    "result" JSONB,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerToolOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerToolOperation_tenant_id_tool_name_idx" ON "CustomerToolOperation"("tenant_id", "tool_name");

-- CreateIndex
CREATE INDEX "CustomerToolOperation_conversation_id_idx" ON "CustomerToolOperation"("conversation_id");

-- CreateIndex
CREATE INDEX "CustomerToolOperation_correlation_id_idx" ON "CustomerToolOperation"("correlation_id");

-- CreateIndex
-- THE exactly-once constraint. Everything else in this table is bookkeeping;
-- this is the line that makes a concurrent duplicate impossible rather than
-- unlikely.
CREATE UNIQUE INDEX "CustomerToolOperation_tenant_id_operation_id_key" ON "CustomerToolOperation"("tenant_id", "operation_id");

-- AddForeignKey
ALTER TABLE "CustomerToolOperation" ADD CONSTRAINT "CustomerToolOperation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
