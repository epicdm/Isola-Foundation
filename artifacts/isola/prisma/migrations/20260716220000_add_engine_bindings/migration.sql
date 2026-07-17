-- CreateTable
CREATE TABLE "OdooBinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "db" TEXT NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "instance_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OdooBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiservBinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "base_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiservBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BffBinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "internal_secret_enc" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BffBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OdooBinding_tenant_id_key" ON "OdooBinding"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "FiservBinding_tenant_id_key" ON "FiservBinding"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "BffBinding_tenant_id_key" ON "BffBinding"("tenant_id");

-- AddForeignKey
ALTER TABLE "OdooBinding" ADD CONSTRAINT "OdooBinding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiservBinding" ADD CONSTRAINT "FiservBinding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BffBinding" ADD CONSTRAINT "BffBinding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
