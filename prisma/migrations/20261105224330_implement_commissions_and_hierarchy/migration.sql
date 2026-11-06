-- AlterTable
ALTER TABLE "commission_ledger" ADD COLUMN     "payoutId" UUID,
ADD COLUMN     "payout_id" UUID;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "applied_commission_rate" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "reserved_stock" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "manager_id" UUID;

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "transaction_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payouts_transaction_ref_key" ON "payouts"("transaction_ref");

-- AddForeignKey
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "seller_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
