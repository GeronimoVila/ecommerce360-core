import cron from 'node-cron';
import { PrismaClient, CommissionStatus } from '@prisma/client';
import { RedisService } from '../redis/redis.service';

const prisma = new PrismaClient();
const LOCK_KEY = 'cron:commissions:maturation:lock';

export const startMaturationCron = () => {
  cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] Iniciando proceso de maduración de comisiones...');

    const lockAcquired = await RedisService.acquireLock(LOCK_KEY, 600);
    
    if (!lockAcquired) {
      console.log('[CRON] El proceso ya está siendo ejecutado por otra instancia.');
      return;
    }

    try {
      const targetDate = new Date();
      console.log(`[DEBUG] Fecha UTC de corte enviada a Prisma: ${targetDate.toISOString()}`);

      const pendingRecords = await prisma.commissionLedger.findMany({
        where: {
          status: CommissionStatus.PENDING_CLEARANCE,
        },
        select: { id: true, clearing_date: true }
      });
      
      console.log(`[DEBUG] Comisiones totales PENDING_CLEARANCE en BD: ${pendingRecords.length}`);
      pendingRecords.forEach(record => {
         console.log(` -> ID: ${record.id} | clearing_date: ${record.clearing_date}`);
      });

      const result = await prisma.commissionLedger.updateMany({
        where: {
          status: CommissionStatus.PENDING_CLEARANCE,
          clearing_date: {
            lte: targetDate, 
          },
        },
        data: {
          status: CommissionStatus.AVAILABLE,
        },
      });

      console.log(`[CRON] Maduración exitosa. Registros actualizados: ${result.count}`);
    } catch (error) {
      console.error('[CRON] Error crítico durante la maduración:', error);
    } finally {
      await RedisService.releaseLock(LOCK_KEY);
    }
  });
};