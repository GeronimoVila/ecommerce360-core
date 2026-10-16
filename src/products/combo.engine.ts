import { PrismaClient } from '@prisma/client';
import { RedisService } from '../redis/redis.service';

export class ComboEngine {

  static async recalculateAffectedCombos(partId: string, prismaBase: PrismaClient): Promise<void> {
    try {
      const affectedComboIds = await RedisService.getCombosByPart(partId);
      
      if (affectedComboIds.length === 0) return;

      for (const comboId of affectedComboIds) {
        const comboRecipe = await prismaBase.product.findUnique({
          where: { id: comboId },
          include: {
            combo_parts: {
              include: { product: { select: { physical_stock: true } } }
            }
          }
        });

        if (!comboRecipe || !comboRecipe.is_combo) continue;

        let minVirtualStock = Infinity;

        for (const item of comboRecipe.combo_parts) {
          const available = Math.floor(item.product.physical_stock / item.quantity);
          if (available < minVirtualStock) {
            minVirtualStock = available;
          }
        }

        const finalStock = minVirtualStock === Infinity ? 0 : minVirtualStock;

        await RedisService.setComboStock(comboId, finalStock);
      }
    } catch (error) {
      console.error(`[Combo Engine] Error crítico recalculando cascada para partId ${partId}:`, error);
    }
  }
}