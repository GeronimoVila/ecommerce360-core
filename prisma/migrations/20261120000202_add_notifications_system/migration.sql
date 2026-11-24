-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('COMMISSION_EARNED', 'COMMISSION_RELEASED', 'COMMISSION_REVERSED', 'PAYOUT_PROCESSED', 'PAYMENT_ACTION_REQUIRED', 'SHIPPING_ISSUE', 'ORDER_OUT_FOR_DELIVERY', 'PAYOUT_REQUESTED', 'CRITICAL_STOCK_SHORTAGE', 'INTEGRATION_FAILURE');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "low_stock_alerted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "low_stock_threshold" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(140) NOT NULL,
    "message" TEXT NOT NULL,
    "action_url" VARCHAR(255),
    "metadata" JSONB,
    "dedup_key" VARCHAR(150),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
