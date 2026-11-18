import { prismaGlobal } from '../config/prisma';
import { R2Service } from './r2.service';

const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export async function purgeOrphanedMedia(): Promise<void> {
  try {
    const cutoffDate = new Date(Date.now() - ORPHAN_TTL_MS);

    const orphans = await prismaGlobal.productImage.findMany({
      where: {
        is_committed: false,
        created_at: { lt: cutoffDate },
      },
      take: 100,
    });

    if (orphans.length === 0) return;

    for (const orphan of orphans) {
      try {
        await R2Service.deleteObject(orphan.storage_key);
        await prismaGlobal.productImage.delete({ where: { id: orphan.id } });
      } catch (err) {
        console.error(`[MediaCron] Fallo purgando imagen huérfana ${orphan.id}:`, err);
      }
    }

    console.log(`🧹 [MediaCron] Purgadas ${orphans.length} imágenes huérfanas de Cloudflare R2.`);
  } catch (error) {
    console.error('[MediaCron] Error en ciclo de limpieza:', error);
  }
}

export function startMediaCleanupCron(): void {
  setTimeout(() => {
    purgeOrphanedMedia();
  }, 30_000);

  setInterval(() => {
    purgeOrphanedMedia();
  }, CLEANUP_INTERVAL_MS);
}