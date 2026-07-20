-- ChatwootBinding: drop tenant_id unique constraint (allow multiple bindings per tenant),
-- add nullable agent_id FK so individual inboxes can route to a specific Agent.
DROP INDEX IF EXISTS "ChatwootBinding_tenant_id_key";
ALTER TABLE "ChatwootBinding" ADD COLUMN "agent_id" TEXT;
CREATE INDEX "ChatwootBinding_tenant_id_idx" ON "ChatwootBinding"("tenant_id");
ALTER TABLE "ChatwootBinding" ADD CONSTRAINT "ChatwootBinding_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ClawithBinding: drop tenant_id unique constraint (allow per-agent rows alongside
-- the per-tenant fallback row), add nullable agent_id FK with its own unique index
-- so findUnique({ where: { agent_id } }) works for the per-agent lookup path.
DROP INDEX IF EXISTS "ClawithBinding_tenant_id_key";
ALTER TABLE "ClawithBinding" ADD COLUMN "agent_id" TEXT;
CREATE UNIQUE INDEX "ClawithBinding_agent_id_key" ON "ClawithBinding"("agent_id");
CREATE INDEX "ClawithBinding_tenant_id_idx" ON "ClawithBinding"("tenant_id");
ALTER TABLE "ClawithBinding" ADD CONSTRAINT "ClawithBinding_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
