-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "balance_minor" INTEGER;

-- AlterTable
ALTER TABLE "WalletTxn" ADD COLUMN     "amount_minor" INTEGER,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WalletTxn_idempotency_key_key" ON "WalletTxn"("idempotency_key");
