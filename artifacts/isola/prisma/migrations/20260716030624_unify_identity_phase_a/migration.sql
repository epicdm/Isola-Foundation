-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "identity_id" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "identity_id" TEXT;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "identity_id" TEXT;

-- AlterTable
ALTER TABLE "WalletTxn" ADD COLUMN     "identity_id" TEXT;

-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "display_name" TEXT,
    "replit_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceLine" (
    "id" TEXT NOT NULL,
    "owner_kind" TEXT NOT NULL,
    "identity_id" TEXT,
    "tenant_id" TEXT,
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
    "provisioning_state" TEXT NOT NULL DEFAULT 'none',
    "provisioning_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Identity_phone_key" ON "Identity"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_replit_id_key" ON "Identity"("replit_id");

-- CreateIndex
CREATE INDEX "Membership_tenant_id_idx" ON "Membership"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_identity_id_tenant_id_key" ON "Membership"("identity_id", "tenant_id");

-- CreateIndex
CREATE INDEX "VoiceLine_identity_id_idx" ON "VoiceLine"("identity_id");

-- CreateIndex
CREATE INDEX "VoiceLine_tenant_id_idx" ON "VoiceLine"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_identity_id_key" ON "Wallet"("identity_id");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceLine" ADD CONSTRAINT "VoiceLine_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceLine" ADD CONSTRAINT "VoiceLine_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
