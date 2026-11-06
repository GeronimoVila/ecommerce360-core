import { PrismaClient, CommissionStatus } from '@prisma/client';

const prisma = new PrismaClient();

export class CommissionsService {
  static async getAvailableBalances() {
    return await prisma.commissionLedger.groupBy({
      by: ['seller_id'],
      where: {
        status: CommissionStatus.AVAILABLE,
      },
      _sum: {
        amount: true,
      },
      _count: {
        id: true,
      },
    });
  }

  static async liquidate(sellerId: string, transactionRef: string, commissionIds: string[]) {
    return await prisma.$transaction(async (tx) => {
      const commissions = await tx.commissionLedger.findMany({
        where: {
          id: { in: commissionIds },
          seller_id: sellerId,
          status: CommissionStatus.AVAILABLE,
        },
      });

      if (commissions.length !== commissionIds.length) {
        throw new Error('Conflicto de estado: Comisiones no disponibles o ya liquidadas.');
      }

      const totalAmount = commissions.reduce((acc, curr) => acc + Number(curr.amount), 0);

      const payout = await tx.payout.create({
        data: {
          seller_id: sellerId,
          total_amount: totalAmount,
          transaction_ref: transactionRef,
          status: 'COMPLETED',
        },
      });

      await tx.commissionLedger.updateMany({
        where: { id: { in: commissionIds } },
        data: {
          status: CommissionStatus.LIQUIDATED,
          payout_id: payout.id,
        },
      });

      return payout;
    });
  }
}