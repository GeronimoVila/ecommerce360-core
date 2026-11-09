import { Request, Response } from 'express';
import { CommissionStatus } from '@prisma/client';

export const getAvailableCommissions = async (req: Request, res: Response): Promise<void> => {
  try {
    const aggregates = await req.prisma.commissionLedger.groupBy({
      by: ['seller_id'],
      where: { status: CommissionStatus.AVAILABLE },
      _sum: { amount: true },
      _count: { id: true }
    });

    if (aggregates.length === 0) {
      res.status(200).json({ data: [] });
      return;
    }

    const sellerIds = aggregates.map(a => a.seller_id);

    const [sellers, rawIds] = await Promise.all([
      req.prisma.sellerProfile.findMany({
        where: { user_id: { in: sellerIds } },
        select: { user_id: true, first_name: true, last_name: true, cbu_alias: true }
      }),
      req.prisma.commissionLedger.findMany({
        where: { status: CommissionStatus.AVAILABLE, seller_id: { in: sellerIds } },
        select: { id: true, seller_id: true }
      })
    ]);

    const sellerMap = new Map(sellers.map(s => [s.user_id, s]));
    
    const commissionIdsMap = new Map<string, string[]>();
    rawIds.forEach(record => {
      if (!commissionIdsMap.has(record.seller_id)) {
        commissionIdsMap.set(record.seller_id, []);
      }
      commissionIdsMap.get(record.seller_id)!.push(record.id);
    });

    const formattedData = aggregates.map(agg => {
      const seller = sellerMap.get(agg.seller_id);
      return {
        seller_id: agg.seller_id,
        seller_name: seller ? `${seller.first_name} ${seller.last_name}`.trim() : 'Vendedor Desconocido',
        cbu_alias: seller?.cbu_alias || 'No registrado',
        total_amount: Number(agg._sum.amount || 0),
        count: agg._count.id,
        commission_ids: commissionIdsMap.get(agg.seller_id) || []
      };
    });

    res.status(200).json({ data: formattedData });
  } catch (error) {
    console.error('[Commissions] Error al agrupar el ledger de comisiones:', error);
    res.status(500).json({ error: 'Error interno procesando las métricas de liquidación' });
  }
};

export const liquidateCommissions = async (req: Request, res: Response): Promise<void> => {
  const { seller_id, transaction_ref, commission_ids } = req.body;

  if (!seller_id || !transaction_ref || !commission_ids || !Array.isArray(commission_ids)) {
    res.status(400).json({ error: 'Datos inválidos para la liquidación.' });
    return;
  }

  try {
    const result = await req.prisma.$transaction(async (tx) => {
      const commissions = await tx.commissionLedger.findMany({
        where: {
          id: { in: commission_ids },
          seller_id: seller_id,
          status: CommissionStatus.AVAILABLE,
        },
      });

      if (commissions.length !== commission_ids.length) {
        throw new Error('Algunas comisiones no están disponibles o no existen.');
      }

      const totalAmount = commissions.reduce((acc, curr) => acc + Number(curr.amount), 0);

      const payout = await tx.payout.create({
        data: {
          seller_id,
          total_amount: totalAmount,
          transaction_ref,
          status: 'COMPLETED',
        },
      });

      await tx.commissionLedger.updateMany({
        where: {
          id: { in: commission_ids },
        },
        data: {
          status: CommissionStatus.LIQUIDATED,
          clearing_date: new Date(),
          payout_id: payout.id,
        },
      });

      return payout;
    });

    res.status(200).json({ message: 'Liquidación completada con éxito', data: result });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'La referencia de transacción ya ha sido procesada.' });
      return;
    }
    res.status(400).json({ error: error.message });
  }
};

export const getPayoutHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawPayouts = await req.prisma.payout.findMany({
      orderBy: { created_at: 'desc' },
      include: {
        seller: {
          select: { first_name: true, last_name: true }
        }
      }
    });

    const formattedPayouts = rawPayouts.map(p => ({
      id: p.id,
      seller_id: p.seller_id,
      seller_name: p.seller ? `${p.seller.first_name} ${p.seller.last_name}`.trim() : 'Vendedor Desconocido',
      total_amount: Number(p.total_amount),
      transaction_ref: p.transaction_ref,
      status: p.status,
      created_at: p.created_at
    }));

    res.status(200).json({ data: formattedPayouts });
  } catch (error) {
    console.error('[Commissions] Error al obtener el historial de liquidaciones:', error);
    res.status(500).json({ error: 'Error interno del servidor al consultar historial.' });
  }
};