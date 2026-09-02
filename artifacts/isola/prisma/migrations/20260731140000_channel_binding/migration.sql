-- Foundation-owned business record of a channel request and Lane 2's reported result.
-- No provider credentials are stored here by design; see lib/channels/channel-binding.ts.

CREATE TABLE "ChannelBinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "requested_type" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "clawith_agent_ref" TEXT,
    "chatwoot_team_ref" TEXT,
    "operating_policy" TEXT,
    "approval_required" BOOLEAN NOT NULL DEFAULT true,
    "accepted_classification" TEXT,
    "accepted_at" TIMESTAMP(3),
    "accepted_by" TEXT,
    "provisioning_status" TEXT NOT NULL DEFAULT 'requested',
    "provider_ref" TEXT,
    "inbox_ref" TEXT,
    "agent_ref" TEXT,
    "lane2_contract_version" TEXT,
    "lane2_evidence_ref" TEXT,
    "readiness" TEXT NOT NULL DEFAULT 'not_ready',
    "health" TEXT NOT NULL DEFAULT 'unknown',
    "last_verified_at" TIMESTAMP(3),
    "chatwoot_deep_link" TEXT,
    "clawith_deep_link" TEXT,
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelBinding_tenant_id_purpose_requested_type_key"
    ON "ChannelBinding"("tenant_id", "purpose", "requested_type");
CREATE INDEX "ChannelBinding_tenant_id_idx" ON "ChannelBinding"("tenant_id");
CREATE INDEX "ChannelBinding_tenant_id_classification_idx"
    ON "ChannelBinding"("tenant_id", "classification");

ALTER TABLE "ChannelBinding" ADD CONSTRAINT "ChannelBinding_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
