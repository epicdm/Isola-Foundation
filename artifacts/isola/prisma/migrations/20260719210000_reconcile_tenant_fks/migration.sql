-- Migrate-deploy foundation: reconcile Wallet/WalletTxn/AuditLog tenant_id FKs.
-- Declared in schema.prisma (ON DELETE SET NULL ON UPDATE CASCADE) and created
-- on fresh DBs/helium, but never applied to Neon because instrumentation.ts
-- runMigrations() only issued ADD COLUMN/CREATE TABLE, never ADD CONSTRAINT.
-- Surfaced by Gate 0d migrate diff once bookkeeping was populated. Zero
-- orphaned tenant_ids confirmed read-only before authoring. Replay-safe
-- (DROP IF EXISTS + ADD): harmless re-add where they exist, real add on Neon.
ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_tenant_id_fkey";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WalletTxn" DROP CONSTRAINT IF EXISTS "WalletTxn_tenant_id_fkey";
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_tenant_id_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
