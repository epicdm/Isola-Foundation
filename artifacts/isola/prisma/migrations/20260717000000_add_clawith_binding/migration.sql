-- CreateTable
CREATE TABLE "ClawithBinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "clawith_agent_id" TEXT NOT NULL,
    "paperclip_agent_id" TEXT NOT NULL,
    "paperclip_company_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClawithBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClawithBinding_tenant_id_key" ON "ClawithBinding"("tenant_id");

-- AddForeignKey
ALTER TABLE "ClawithBinding" ADD CONSTRAINT "ClawithBinding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
