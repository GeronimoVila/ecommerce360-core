-- DropIndex
DROP INDEX "products_category_id_idx";

-- CreateTable
CREATE TABLE "payment_gateway_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" VARCHAR(64) NOT NULL DEFAULT 'DEFAULT_STORE',
    "provider" VARCHAR(20) NOT NULL,
    "connect_id" VARCHAR(120),
    "access_token_encrypted" TEXT,
    "merchant_cuit" VARCHAR(20),
    "merchant_name" VARCHAR(150),
    "is_test_mode" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DISCONNECTED',
    "connected_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_gateway_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "product_id" UUID,
    "url" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "alt_text" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_committed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_configs_tenant_id_provider_key" ON "payment_gateway_configs"("tenant_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_storage_key_key" ON "product_images"("storage_key");

-- CreateIndex
CREATE INDEX "product_images_product_id_position_idx" ON "product_images"("product_id", "position");

-- CreateIndex
CREATE INDEX "product_images_is_committed_created_at_idx" ON "product_images"("is_committed", "created_at");

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
