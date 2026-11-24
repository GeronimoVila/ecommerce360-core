import { Request, Response } from 'express';
import { CommissionStatus, NotificationType, Role } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

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

    const sellerProfileIds = aggregates.map(a => a.seller_id);

    const [sellers, rawIds] = await Promise.all([
      req.prisma.sellerProfile.findMany({
        where: { id: { in: sellerProfileIds } },
        select: { id: true, user_id: true, first_name: true, last_name: true, cbu_alias: true }
      }),
      req.prisma.commissionLedger.findMany({
        where: { status: CommissionStatus.AVAILABLE, seller_id: { in: sellerProfileIds } },
        select: { id: true, seller_id: true }
      })
    ]);

    const sellerMap = new Map(sellers.map(s => [s.id, s]));

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
          payoutId: payout.id,
        },
      });

      return payout;
    });

    const seller = await req.prisma.sellerProfile.findUnique({
      where: { id: seller_id },
      select: { user_id: true },
    });

    if (seller) {
      await NotificationsService.notify({
        userId: seller.user_id,
        role: Role.SELLER,
        type: NotificationType.PAYOUT_PROCESSED,
        title: 'Liquidación transferida',
        message: `Se liquidaron $${Number(result.total_amount).toFixed(2)} a tu cuenta (Ref: ${transaction_ref}).`,
        actionUrl: '/commissions/payouts',
        metadata: {
          payout_id: result.id,
          amount: Number(result.total_amount),
          transaction_ref,
        },
        dedupKey: `payout_processed:${result.id}`,
      });
    }

    res.status(200).json({ message: 'Liquidación completada con éxito', data: result });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'La referencia de transacción ya ha sido procesada.' });
      return;
    }
    res.status(400).json({ error: error.message });
  }
};

export const requestPayout = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado.' });
      return;
    }

    const seller = await req.prisma.sellerProfile.findUnique({
      where: { user_id: userId },
      select: { id: true, first_name: true, last_name: true, cbu_alias: true },
    });

    if (!seller) {
      res.status(404).json({ error: 'Perfil de vendedor no encontrado.' });
      return;
    }

    if (!seller.cbu_alias) {
      res.status(400).json({ error: 'Debes configurar tu CBU o Alias antes de solicitar un retiro.' });
      return;
    }

    const availableAgg = await req.prisma.commissionLedger.aggregate({
      where: { seller_id: seller.id, status: CommissionStatus.AVAILABLE },
      _sum: { amount: true },
      _count: { id: true },
    });

    const amount = Number(availableAgg._sum.amount || 0);
    if (amount <= 0) {
      res.status(400).json({ error: 'No tienes saldo disponible para retirar.' });
      return;
    }

    const sellerName = `${seller.first_name} ${seller.last_name}`.trim();
    const todayStamp = new Date().toISOString().slice(0, 10);

    await NotificationsService.notifyAdmins({
      type: NotificationType.PAYOUT_REQUESTED,
      title: `Solicitud de retiro: $${amount.toFixed(2)}`,
      message: `${sellerName} solicitó retirar $${amount.toFixed(2)} (${availableAgg._count.id} comisiones) hacia ${seller.cbu_alias}.`,
      actionUrl: '/commissions/liquidations',
      metadata: {
        seller_id: seller.id,
        amount,
        cbu_alias: seller.cbu_alias,
        commissions_count: availableAgg._count.id,
      },
      baseDedupKey: `payout_req:${seller.id}:${todayStamp}`,
    });

    res.status(200).json({
      success: true,
      message: 'Solicitud de retiro enviada a administración.',
      requested_amount: amount,
    });
  } catch (error) {
    console.error('[Commissions] Error al solicitar retiro:', error);
    res.status(500).json({ error: 'Error interno al procesar la solicitud de retiro.' });
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

export const getMyCommissions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado.' });
      return;
    }

    const sellerProfile = await req.prisma.sellerProfile.findUnique({
      where: { user_id: userId },
      select: { id: true, first_name: true, last_name: true, cbu_alias: true }
    });

    if (!sellerProfile) {
      res.status(404).json({ error: 'Perfil de vendedor no encontrado para este usuario.' });
      return;
    }

    const statusParam = req.query.status as string | undefined;
    const validStatuses = Object.values(CommissionStatus);
    const statusFilter =
      statusParam && validStatuses.includes(statusParam as CommissionStatus)
        ? (statusParam as CommissionStatus)
        : undefined;

    const [groupedTotals, ledgerRecords] = await Promise.all([
      req.prisma.commissionLedger.groupBy({
        by: ['status'],
        where: { seller_id: sellerProfile.id },
        _sum: { amount: true },
        _count: { id: true }
      }),
      req.prisma.commissionLedger.findMany({
        where: {
          seller_id: sellerProfile.id,
          ...(statusFilter ? { status: statusFilter } : {})
        },
        orderBy: { created_at: 'desc' },
        include: {
          order: {
            select: {
              id: true,
              created_at: true,
              total_amount: true,
              status: true,
              customer: {
                select: { first_name: true, last_name: true }
              },
              items: {
                select: {
                  quantity: true,
                  applied_commission_rate: true,
                  product: {
                    select: { name: true, sku: true }
                  }
                }
              }
            }
          }
        }
      })
    ]);

    let availableBalance = 0;
    let pendingClearanceBalance = 0;
    let liquidatedTotal = 0;
    const counts = {
      available: 0,
      pending_clearance: 0,
      liquidated: 0,
      canceled: 0
    };

    for (const group of groupedTotals) {
      const sum = Number(group._sum.amount || 0);
      const count = group._count.id;

      if (group.status === CommissionStatus.AVAILABLE) {
        availableBalance = sum;
        counts.available = count;
      } else if (group.status === CommissionStatus.PENDING_CLEARANCE) {
        pendingClearanceBalance = sum;
        counts.pending_clearance = count;
      } else if (group.status === CommissionStatus.LIQUIDATED) {
        liquidatedTotal = sum;
        counts.liquidated = count;
      } else if (group.status === CommissionStatus.CANCELED) {
        counts.canceled = count;
      }
    }

    const formattedCommissions = ledgerRecords.map((entry) => {
      const customerName = entry.order?.customer
        ? `${entry.order.customer.first_name || ''} ${entry.order.customer.last_name || ''}`.trim() || 'Cliente Web'
        : 'Cliente Web';

      const itemsSummary = entry.order?.items?.length
        ? entry.order.items
            .map(
              (item) =>
                `${item.quantity}x ${item.product?.name || 'Producto'} (${Number(item.applied_commission_rate)}%)`
            )
            .join(', ')
        : 'Venta atribuida';

      return {
        id: entry.id,
        order_id: entry.order_id,
        order_date: entry.order?.created_at || entry.created_at,
        order_total: Number(entry.order?.total_amount || 0),
        order_status: entry.order?.status || 'PAID',
        customer_name: customerName,
        items_summary: itemsSummary,
        amount: Number(entry.amount),
        status: entry.status,
        clearing_date: entry.clearing_date,
        payout_id: entry.payout_id || entry.payoutId || null,
        created_at: entry.created_at
      };
    });

    res.status(200).json({
      summary: {
        seller_id: sellerProfile.id,
        seller_name: `${sellerProfile.first_name} ${sellerProfile.last_name}`.trim(),
        cbu_alias: sellerProfile.cbu_alias || null,
        available_balance: availableBalance,
        pending_clearance_balance: pendingClearanceBalance,
        liquidated_total: liquidatedTotal,
        counts
      },
      commissions: formattedCommissions
    });
  } catch (error) {
    console.error('[Commissions] Error al obtener comisiones del vendedor:', error);
    res.status(500).json({ error: 'Error interno al consultar tus comisiones.' });
  }
};

export const getMyPayouts = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado.' });
      return;
    }

    const sellerProfile = await req.prisma.sellerProfile.findUnique({
      where: { user_id: userId },
      select: { id: true }
    });

    if (!sellerProfile) {
      res.status(404).json({ error: 'Perfil de vendedor no encontrado.' });
      return;
    }

    const payouts = await req.prisma.payout.findMany({
      where: { seller_id: sellerProfile.id },
      orderBy: { created_at: 'desc' },
      include: {
        _count: {
          select: { commissions: true }
        }
      }
    });

    const formattedPayouts = payouts.map((p) => ({
      id: p.id,
      total_amount: Number(p.total_amount),
      transaction_ref: p.transaction_ref,
      status: p.status,
      commissions_count: p._count.commissions,
      created_at: p.created_at
    }));

    res.status(200).json({ data: formattedPayouts });
  } catch (error) {
    console.error('[Commissions] Error al obtener liquidaciones del vendedor:', error);
    res.status(500).json({ error: 'Error interno al consultar tu historial de pagos.' });
  }
};