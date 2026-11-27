-- CreateEnum
CREATE TYPE "BannerLinkType" AS ENUM ('PRODUCT', 'CATEGORY', 'OFFERS');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "featured_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "is_featured" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "storefront_banners" (
    "id" UUID NOT NULL,
    "badge_text" VARCHAR(80),
    "title" VARCHAR(140) NOT NULL,
    "highlight_text" VARCHAR(80),
    "subtitle" TEXT,
    "cta_text" VARCHAR(60) NOT NULL DEFAULT 'Ver Promociones',
    "payment_note" VARCHAR(80) DEFAULT 'Visa, Mastercard & MP',
    "image_url" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "image_badge_text" VARCHAR(60),
    "link_type" "BannerLinkType" NOT NULL DEFAULT 'OFFERS',
    "link_target" VARCHAR(150),
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefront_banners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storefront_banners_storage_key_key" ON "storefront_banners"("storage_key");

-- CreateIndex
CREATE INDEX "storefront_banners_is_active_position_idx" ON "storefront_banners"("is_active", "position");
