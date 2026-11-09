import { PrismaClient, Prisma } from '@prisma/client';
import { ComboEngine } from '../products/combo.engine';

const prismaBase = new PrismaClient({
  log: ['error', 'warn'],
});

export const connectDatabase = async () => {
  try {
    await prismaBase.$connect();
    console.log("✅ Conexión exitosa al SSOT (Neon Tech - PostgreSQL).");
  } catch (error) {
    console.error("❌ Error fatal al conectar con Neon Tech:", error);
    process.exit(1);
  }
};

export const prismaGlobal = prismaBase.$extends({
  query: {
    product: {
      async update({ args, query }) {
        const result = await query(args);
        if (args.data.physical_stock !== undefined && !result.is_combo) {
          const targetId = result.id || (args.where as any).id;
          if (targetId) {
            ComboEngine.recalculateAffectedCombos(targetId as string, prismaBase).catch(console.error);
          }
        }
        return result;
      }
    }
  }
});

export const getPrismaContext = (user?: { sub: string; role: string }) => {
  if (!user || user.role === 'ADMIN') return prismaGlobal;

  return prismaGlobal.$extends({
    query: {
      order: {
        async findMany({ args, query }) { args.where = { ...args.where, seller_id: user.sub }; return query(args); },
        async findFirst({ args, query }) { args.where = { ...args.where, seller_id: user.sub }; return query(args); },
        async findUnique({ args, query }) {
          return prismaGlobal.order.findFirst({ ...args, where: { ...args.where, seller_id: user.sub } as any });
        }
      },
      commissionLedger: {
        async findMany({ args, query }) { args.where = { ...args.where, seller_id: user.sub }; return query(args); },
        async aggregate({ args, query }) { args.where = { ...args.where, seller_id: user.sub }; return query(args); },
        async groupBy({ args, query }) { args.where = { ...args.where, seller_id: user.sub }; return query(args); }
      },
      payout: {
        async findMany({ args, query }) { args.where = { ...args.where, seller_id: user.sub }; return query(args); }
      }
    }
  });
};

export default prismaGlobal;