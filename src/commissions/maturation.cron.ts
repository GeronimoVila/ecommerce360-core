import cron from 'node-cron';
import { PrismaClient, CommissionStatus, NotificationType, Role } from '@prisma/client';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';

const prisma = new PrismaClient();
const LOCK_KEY = 'cron:commissions:maturation:lock';

export const startMaturationCron = () => {
  cron.schedule('0 2 * * *', async () => {
    const lockAcquired = await RedisService.acquireLock(LOCK_KEY, 600);
    if (!lockAcquired) return;

    try {
      const targetDate = new Date();
      const dateStamp = targetDate.toISOString().slice(0, 10);

      const eligible = await prisma.commissionLedger.findMany({
        where: {
          status: CommissionStatus.PENDING_CLEARANCE,
          clearing_date: { lte: targetDate },
        },
        select: {
          id: true,
          seller_id: true,
          amount: true,
          seller: { select: { user_id: true } },
        },
      });

      if (eligible.length === 0) return;

      const eligibleIds = eligible.map((e) => e.id);

      const result = await prisma.commissionLedger.updateMany({
        where: {
          id: { in: eligibleIds },
          status: CommissionStatus.PENDING_CLEARANCE,
        },
        data: { status: CommissionStatus.AVAILABLE },
      });

      const bySeller = new Map<string, { userId: string; total: number; count: number }>();
      for (const item of eligible) {
        const current = bySeller.get(item.seller_id) || {
          userId: item.seller.user_id,
          total: 0,
          count: 0,
        };
        current.total += Number(item.amount);
        current.count += 1;
        bySeller.set(item.seller_id, current);
      }

      for (const [sellerId, info] of bySeller.entries()) {
        await NotificationsService.notify({
          userId: info.userId,
          role: Role.SELLER,
          type: NotificationType.COMMISSION_RELEASED,
          title: 'Comisiones disponibles para retiro',
          message: `Se liberaron $${info.total.toFixed(2)} (${info.count} ${info.count === 1 ? 'comisión' : 'comisiones'}). Ya puedes solicitar tu liquidación.`,
          actionUrl: '/commissions',
          metadata: { amount: info.total, count: info.count },
          dedupKey: `commission_released:${sellerId}:${dateStamp}`,
        });
      }

      console.log(`[CRON] Maduración exitosa. Registros actualizados: ${result.count}`);
    } catch (error) {
      console.error('[CRON] Error crítico durante la maduración:', error);
    } finally {
      await RedisService.releaseLock(LOCK_KEY);
    }
  });
};