-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "clawith_tenant_id" TEXT,
ADD COLUMN     "paperclip_company_id" TEXT,
ADD COLUMN     "odoo_instance_type" TEXT,
ADD COLUMN     "odoo_db" TEXT,
ADD COLUMN     "odoo_url" TEXT,
ADD COLUMN     "waba_id" TEXT,
ADD COLUMN     "wa_phone_number_id" TEXT,
ADD COLUMN     "chatwoot_account_id" TEXT,
ADD COLUMN     "reseller_id" TEXT,
ADD COLUMN     "billing" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_clawith_tenant_id_key" ON "Tenant"("clawith_tenant_id");
