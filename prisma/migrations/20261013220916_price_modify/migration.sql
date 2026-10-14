-- AlterTable
ALTER TABLE "products" ADD COLUMN     "profit_margin" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "purchase_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 21;
