-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "chatwoot_inbox_id" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "chatwoot_binding_id" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_chatwoot_binding_id_idx" ON "Conversation"("chatwoot_binding_id");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_chatwoot_binding_id_fkey" FOREIGN KEY ("chatwoot_binding_id") REFERENCES "ChatwootBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;
