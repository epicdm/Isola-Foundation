-- P0: cross-path WhatsApp inbound idempotency (dedup by Meta message id)
-- NOT APPLIED by this PR — paired with schema.prisma InboundDedup model.
-- See lib/inbound-dedup.ts for rationale.

-- CreateTable
CREATE TABLE "InboundDedup" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundDedup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundDedup_message_id_key" ON "InboundDedup"("message_id");
