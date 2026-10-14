import { PrismaClient } from '@prisma/client';
import { ComboEngine } from '../products/combo.engine';

const prismaBase = new PrismaClient();

const prisma = prismaBase.$extends({
  query: {
    product: {
      async update({ args, query }) {
        const result = await query(args);

        if (args.data.physical_stock !== undefined && !result.is_combo) {
          
          const targetId = result.id || (args.where as any).id;

          if (targetId) {
            ComboEngine.recalculateAffectedCombos(targetId as string, prismaBase).catch(console.error);
          } else {
            console.warn('[Prisma Interceptor] No se pudo resolver el ID del producto para recalcular combos.');
          }
        }

        return result;
      }
    }
  }
});

export default prisma;