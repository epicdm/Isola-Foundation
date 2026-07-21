-- CreateTable
CREATE TABLE "EscalationRef" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscalationRef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EscalationRef_token_key" ON "EscalationRef"("token");

-- CreateIndex
CREATE INDEX "EscalationRef_tenant_id_created_at_idx" ON "EscalationRef"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "EscalationRef_expires_at_idx" ON "EscalationRef"("expires_at");

-- AddForeignKey
ALTER TABLE "EscalationRef" ADD CONSTRAINT "EscalationRef_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationRef" ADD CONSTRAINT "EscalationRef_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
