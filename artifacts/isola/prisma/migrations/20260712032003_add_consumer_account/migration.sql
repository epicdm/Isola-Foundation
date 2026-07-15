-- DropForeignKey
ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "WalletTxn" DROP CONSTRAINT "WalletTxn_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_tenant_id_fkey";

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "consumer_account_id" TEXT,
ALTER COLUMN "tenant_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WalletTxn" ADD COLUMN     "consumer_account_id" TEXT,
ALTER COLUMN "tenant_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "consumer_account_id" TEXT,
ALTER COLUMN "tenant_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ConsumerAccount" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "display_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "voice_provisioning_state" TEXT NOT NULL DEFAULT 'none',
    "voice_provisioning_error" TEXT,
    "magnus_user_id" TEXT,
    "magnus_sip_id" TEXT,
    "magnus_sip_username" TEXT,
    "magnus_sip_password" TEXT,
    "magnus_callerid_id" TEXT,
    "magnus_did_id" TEXT,
    "magnus_did_number" TEXT,
    "magnus_diddestination_id" TEXT,
    "voice_forward_to_cell" BOOLEAN NOT NULL DEFAULT false,
    "voice_cell_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerAccount_phone_number_key" ON "ConsumerAccount"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_consumer_account_id_key" ON "Wallet"("consumer_account_id");

-- CreateIndex
CREATE INDEX "WalletTxn_consumer_account_id_created_at_idx" ON "WalletTxn"("consumer_account_id", "created_at");

-- CreateIndex
CREATE INDEX "AuditLog_consumer_account_id_created_at_idx" ON "AuditLog"("consumer_account_id", "created_at");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "ConsumerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "ConsumerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "ConsumerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

