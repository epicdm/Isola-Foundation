-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "owner_phone" TEXT;

-- CreateTable
CREATE TABLE "tenant_voicemail_catches" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "msgId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "calledExten" TEXT NOT NULL,
    "origtime" INTEGER NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "transcript" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "urgency" TEXT NOT NULL DEFAULT 'normal',
    "callbackNumber" TEXT,
    "confident" BOOLEAN NOT NULL DEFAULT true,
    "isSpam" BOOLEAN NOT NULL DEFAULT false,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_voicemail_catches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_voicemail_catches_tenant_id_created_at_idx" ON "tenant_voicemail_catches"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_voicemail_catches_tenant_id_msgId_key" ON "tenant_voicemail_catches"("tenant_id", "msgId");

-- AddForeignKey
ALTER TABLE "tenant_voicemail_catches" ADD CONSTRAINT "tenant_voicemail_catches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
