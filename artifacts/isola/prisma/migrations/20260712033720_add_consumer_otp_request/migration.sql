-- CreateTable
CREATE TABLE "ConsumerOtpRequest" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumerOtpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsumerOtpRequest_phone_number_created_at_idx" ON "ConsumerOtpRequest"("phone_number", "created_at");

