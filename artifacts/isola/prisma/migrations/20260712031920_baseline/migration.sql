-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "magnus_user_id" TEXT,
    "voice_provisioning_state" TEXT NOT NULL DEFAULT 'none',
    "voice_provisioning_error" TEXT,
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

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "replit_id" TEXT,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "email" TEXT,
    "name" TEXT,
    "profile_image_url" TEXT,
    "intelligence_tier" TEXT NOT NULL DEFAULT 'standard',
    "agent_took_over" BOOLEAN NOT NULL DEFAULT false,
    "act_as_tenant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Isola Assistant',
    "greeting" TEXT NOT NULL DEFAULT 'Hello! How can I help you today?',
    "business_info" TEXT NOT NULL DEFAULT '',
    "knowledge_text" TEXT NOT NULL DEFAULT '',
    "intelligence_tier" TEXT NOT NULL DEFAULT 'standard',
    "after_hours_start" TEXT,
    "after_hours_end" TEXT,
    "away_message" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'America/Dominica',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "brain_provider" TEXT NOT NULL DEFAULT 'native',
    "flowise_flow_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppNumber" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "display_name" TEXT,
    "access_token" TEXT NOT NULL,
    "token_env" TEXT,
    "coex_mode" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatwootBinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "inbox_id" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'mirror',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatwootBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'opted_in',
    "opted_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opted_out_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'inbound',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "whatsapp_number_id" TEXT,
    "chatwoot_conversation_id" INTEGER,
    "customer_phone" TEXT NOT NULL,
    "customer_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "agent_took_over" BOOLEAN NOT NULL DEFAULT false,
    "human_handling" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "wa_message_id" TEXT,
    "chatwoot_message_id" INTEGER,
    "tokens_used" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "magnus_user_id" TEXT,
    "balance_cache" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EC$',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTxn" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount_usd" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageMeter" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "minutes_used" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "minutes_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokens_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "status" TEXT NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "request_id" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "profile_image_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "sid" TEXT NOT NULL,
    "sess" JSONB NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_replit_id_key" ON "User"("replit_id");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_tenant_id_key" ON "Agent"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppNumber_phone_number_id_key" ON "WhatsAppNumber"("phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "ChatwootBinding_tenant_id_key" ON "ChatwootBinding"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_tenant_id_phone_key" ON "Consent"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "Conversation_tenant_id_status_idx" ON "Conversation"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Conversation_tenant_id_last_message_at_idx" ON "Conversation"("tenant_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tenant_id_chatwoot_conversation_id_key" ON "Conversation"("tenant_id", "chatwoot_conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_wa_message_id_key" ON "Message"("wa_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_chatwoot_message_id_key" ON "Message"("chatwoot_message_id");

-- CreateIndex
CREATE INDEX "Message_conversation_id_created_at_idx" ON "Message"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_tenant_id_key" ON "Wallet"("tenant_id");

-- CreateIndex
CREATE INDEX "WalletTxn_tenant_id_created_at_idx" ON "WalletTxn"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "UsageMeter_tenant_id_period_start_key" ON "UsageMeter"("tenant_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_tenant_id_key" ON "Subscription"("tenant_id");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_id_created_at_idx" ON "AuditLog"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_id_request_id_idx" ON "AuditLog"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppNumber" ADD CONSTRAINT "WhatsAppNumber_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatwootBinding" ADD CONSTRAINT "ChatwootBinding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_whatsapp_number_id_fkey" FOREIGN KEY ("whatsapp_number_id") REFERENCES "WhatsAppNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageMeter" ADD CONSTRAINT "UsageMeter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

