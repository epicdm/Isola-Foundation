-- Foundation's read model for Lane-2 events: the table behind `IngestPorts.project`
-- and `Lane2ProjectionStore.read`. See lib/events/projection-store.ts.
--
-- ADDITIVE ONLY. One CREATE TABLE, six CREATE INDEX, one ALTER TABLE ADD CONSTRAINT.
-- No DROP, no TRUNCATE, no ALTER COLUMN: nothing here can remove or retype an
-- existing column, so applying it to a populated database cannot lose data.
--
-- No provider credentials are stored here by design — ingestion refuses a
-- credential-shaped payload WHOLE before this table is ever reached.

CREATE TABLE "projected_activity" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,

    -- Lane 2's own identity for the event, and its transport dedup key. The
    -- tenant is part of BOTH unique keys below: an id that is unique only
    -- globally would let one tenant's event collide with another's.
    "event_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,

    "event_type" TEXT NOT NULL,
    "source_system" TEXT NOT NULL,
    "actor_class" TEXT NOT NULL,

    -- When it HAPPENED vs when it ARRIVED. Both are kept because a late
    -- delivery must land in its historical place, not at the top of the feed.
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,

    "channel_binding_id" TEXT,
    "agent_ref" TEXT,
    "conversation_ref" TEXT,
    "correlation_id" TEXT,

    "related_objects" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL DEFAULT '{}',

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projected_activity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "projected_activity_tenant_id_event_id_key"
    ON "projected_activity"("tenant_id", "event_id");
CREATE UNIQUE INDEX "projected_activity_tenant_id_dedupe_key_key"
    ON "projected_activity"("tenant_id", "dedupe_key");

CREATE INDEX "projected_activity_tenant_id_occurred_at_idx"
    ON "projected_activity"("tenant_id", "occurred_at");
CREATE INDEX "projected_activity_tenant_id_event_type_idx"
    ON "projected_activity"("tenant_id", "event_type");
CREATE INDEX "projected_activity_tenant_id_source_system_idx"
    ON "projected_activity"("tenant_id", "source_system");
-- Subject erasure names a tenant and a conversation; this is the index that read serves.
CREATE INDEX "projected_activity_tenant_id_conversation_ref_idx"
    ON "projected_activity"("tenant_id", "conversation_ref");

-- CASCADE, not RESTRICT: a deleted tenant must not leave activity rows behind
-- describing a tenant that no longer exists.
ALTER TABLE "projected_activity" ADD CONSTRAINT "projected_activity_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
