-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_PAID';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_DELIVERED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'ASSISTED_BUDGET_READY';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'CANCELED';
