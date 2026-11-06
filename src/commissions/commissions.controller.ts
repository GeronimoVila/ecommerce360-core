import { Request, Response } from 'express';
import { PrismaClient, CommissionStatus } from '@prisma/client';

const prisma = new PrismaClient();

export const getAvailableCommissions = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawCommissions = await prisma.commissionLedger.findMany({
      where: { status: CommissionStatus.AVAILABLE },
      include: {
        seller: {
          select: {
            first_name: true,
            last_name: true,
            cbu_alias: true
          }
        }
      }
    });

    const grouped = rawCommissions.reduce((acc: any, curr: any) => {
      if (!acc[curr.seller_id]) {
        acc[curr.seller_id] = { 
          seller_id: curr.seller_id,
          seller_name: curr.seller ? `${curr.seller.first_name} ${curr.seller.last_name}`.trim() : 'Vendedor Desconocido',
          cbu_alias: curr.seller?.cbu_alias || 'No registrado',
          total_amount: 0, 
          count: 0, 
          commission_ids: [] 
        };
      }
      acc[curr.seller_id].total_amount += Number(curr.amount);
      acc[curr.seller_id].count += 1;
      acc[curr.seller_id].commission_ids.push(curr.id);
      return acc;
    }, {});

    res.status(200).json({ data: Object.values(grouped) });
  } catch (error) {
    console.error('[Commissions] Error al obtener comisiones:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

export const liquidateCommissions = async (req: Request, res: Response): Promise<void> => {
  const { seller_id, transaction_ref, commission_ids } = req.body;

  if (!seller_id || !transaction_ref || !commission_ids || !Array.isArray(commission_ids)) {
    res.status(400).json({ error: 'Datos inválidos para la liquidación.' });
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
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
    const rawPayouts = await prisma.payout.findMany({
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