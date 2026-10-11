-- Personal Line -> SeldonFrame journey-event OUTBOX (slice 2a item 4; ops/personal-line/specs/pl-journey-events-contract-v1.md).
-- ADDITIVE ONLY: one new table + indexes. No existing table is touched. Zero rows on creation.
-- One row per outbound lifecycle event, written IN THE SAME TRANSACTION as the engine change that causes it.
-- Production apply is a separate, owner-gated deploy step (`prisma migrate deploy`).
--   event_id      deterministic uuid derived from dedupe_key (same logical event => same id, so the receiver's inbox dedupes)
--   dedupe_key    the logical identity of the event ("line_created:<acct>", "app_activated:<acct>", ...); UNIQUE => idempotent enqueue
--   version       monotonic per pl_account_id (assigned under a per-account advisory lock inside the enqueueing transaction)
--   payload       the contract `facts` object only; wa_id is resolved at delivery from the account, never copied here
--   attempts / next_attempt_at   retry bookkeeping (a claim also leases the row by pushing next_attempt_at)
--   delivered_at  set on a 2xx (a duplicate-event 200 included); dead_at + last_error = permanent failure, visible, requeue-able
CREATE TABLE "sf_event_outbox" (
    "event_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pl_account_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "dead_at" TIMESTAMP(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sf_event_outbox_pkey" PRIMARY KEY ("event_id")
);
CREATE UNIQUE INDEX "sf_event_outbox_dedupe_key_key" ON "sf_event_outbox"("dedupe_key");
CREATE UNIQUE INDEX "sf_event_outbox_pl_account_id_version_key" ON "sf_event_outbox"("pl_account_id", "version");
CREATE INDEX "sf_event_outbox_delivered_at_dead_at_next_attempt_at_idx" ON "sf_event_outbox"("delivered_at", "dead_at", "next_attempt_at");
CREATE INDEX "sf_event_outbox_type_created_at_idx" ON "sf_event_outbox"("type", "created_at");
