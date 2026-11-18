import cron from 'node-cron';
import { prismaGlobal } from '../config/prisma';
import { R2Service } from '../media/r2.service';
import { RedisService } from '../redis/redis.service';

const CLEANUP_LOCK_KEY = 'lock:cron:media-orphan-cleanup';
const LOCK_TTL_SECONDS = 300;
const DRAFT_MAX_AGE_HOURS = 24;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 10;

export async function runOrphanMediaCleanup(): Promise<void> {
  if (!R2Service.isConfigured()) {
    return;
  }

  const acquired = await RedisService.acquireLock(CLEANUP_LOCK_KEY, LOCK_TTL_SECONDS);
  if (!acquired) {
    return;
  }

  try {
    const cutoffDate = new Date(Date.now() - DRAFT_MAX_AGE_HOURS * 60 * 60 * 1000);
    let totalDeleted = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const orphanDrafts = await prismaGlobal.productImage.findMany({
        where: {
          is_committed: false,
          product_id: null,
          created_at: { lt: cutoffDate },
        },
        select: {
          id: true,
          storage_key: true,
        },
        take: BATCH_SIZE,
        orderBy: { created_at: 'asc' },
      });

      if (orphanDrafts.length === 0) {
        break;
      }

      const successfullyDeletedIds: string[] = [];

      const results = await Promise.allSettled(
        orphanDrafts.map(async (draft) => {
          await R2Service.deleteObject(draft.storage_key);
          return draft.id;
        })
      );

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successfullyDeletedIds.push(result.value);
        } else {
          console.error(
            `[MediaCleanupJob] Fallo eliminando objeto R2 (${orphanDrafts[index].storage_key}):`,
            result.reason
          );
        }
      });

      if (successfullyDeletedIds.length > 0) {
        const deleted = await prismaGlobal.productImage.deleteMany({
          where: {
            id: { in: successfullyDeletedIds },
            is_committed: false,
          },
        });
        totalDeleted += deleted.count;
      }

      if (orphanDrafts.length < BATCH_SIZE || successfullyDeletedIds.length === 0) {
        break;
      }
    }

    if (totalDeleted > 0) {
      console.log(
        `🧹 [MediaCleanupJob] Purgados ${totalDeleted} borradores huérfanos de R2 y PostgreSQL.`
      );
    }
  } catch (error) {
    console.error('[MediaCleanupJob] Error crítico ejecutando limpieza de medios:', error);
  } finally {
    await RedisService.releaseLock(CLEANUP_LOCK_KEY);
  }
}

export function initMediaCleanupJob(): void {
  cron.schedule(
    '30 3 * * *',
    () => {
      runOrphanMediaCleanup();
    },
    {
      timezone: 'America/Argentina/Buenos_Aires',
    }
  );

  console.log('⏰ [MediaCleanupJob] Programado diariamente a las 03:30 ART.');
}