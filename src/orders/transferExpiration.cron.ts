import cron from 'node-cron';
import { NotificationType, OrderStatus, PaymentMethod, Role } from '@prisma/client';
import { prismaGlobal } from '../config/prisma';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';

const LOCK_KEY = 'cron:orders:transfer_expiration:lock';
const TRANSFER_EXPIRATION_DAYS = 7;

export async function processExpiredTransferOrders(): Promise<number> {
  const lockAcquired = await RedisService.acquireLock(LOCK_KEY, 600);
  if (!lockAcquired) return 0;

  let canceledCount = 0;

  try {
    const cutoffDate = new Date(Date.now() - TRANSFER_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

    const expiredOrders = await prismaGlobal.order.findMany({
      where: {
        payment_method: PaymentMethod.TRANSFERENCIA,
        status: OrderStatus.PENDING,
        created_at: { lte: cutoffDate },
      },
      select: {
        id: true,
        coupon_id: true,
        customer: {
          select: { user_id: true },
        },
        items: {
          select: {
            product_id: true,
            quantity: true,
            product: {
              select: {
                is_combo: true,
                combo_parts: {
                  select: {
                    product_id: true,
                    quantity: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (expiredOrders.length === 0) return 0;

    for (const order of expiredOrders) {
      try {
        const transitioned = await prismaGlobal.$transaction(async (tx) => {
          const updated = await tx.order.updateMany({
            where: {
              id: order.id,
              status: OrderStatus.PENDING,
              payment_method: PaymentMethod.TRANSFERENCIA,
            },
            data: {
              status: OrderStatus.CANCELED,
            },
          });

          if (updated.count === 0) {
            return false;
          }

          if (order.coupon_id) {
            await tx.coupon.updateMany({
              where: {
                id: order.coupon_id,
                used_count: { gt: 0 },
              },
              data: {
                used_count: { decrement: 1 },
              },
            });
          }

          for (const item of order.items) {
            if (!item.product_id || !item.product) continue;

            if (item.product.is_combo && item.product.combo_parts.length > 0) {
              for (const part of item.product.combo_parts) {
                await tx.product.update({
                  where: { id: part.product_id },
                  data: {
                    physical_stock: { increment: part.quantity * item.quantity },
                    version: { increment: 1 },
                  },
                });
              }
            } else {
              await tx.product.update({
                where: { id: item.product_id },
                data: {
                  physical_stock: { increment: item.quantity },
                  version: { increment: 1 },
                },
              });
            }
          }

          return true;
        });

        if (transitioned) {
          canceledCount += 1;

          if (order.customer?.user_id) {
            const shortOrderId = order.id.slice(0, 8).toUpperCase();
            await NotificationsService.notify({
              userId: order.customer.user_id,
              role: Role.CUSTOMER,
              type: NotificationType.ORDER_CANCELLED,
              title: `Pedido #${shortOrderId} cancelado por vencimiento`,
              message: `Pasaron ${TRANSFER_EXPIRATION_DAYS} días sin acreditación de transferencia para tu pedido #${shortOrderId}. El pedido fue cancelado y se liberó la reserva de stock.`,
              actionUrl: `/orders/${order.id}`,
              metadata: {
                order_id: order.id,
                reason: 'TRANSFER_EXPIRED_7_DAYS',
              },
              dedupKey: `order_canceled:${order.id}`,
            });
          }
        }
      } catch (orderErr) {
        console.error(`[CRON TransferExpiration] Error liberando orden ${order.id}:`, orderErr);
      }
    }

    if (canceledCount > 0) {
      console.log(`[CRON TransferExpiration] Órdenes vencidas canceladas y stock restituido: ${canceledCount}`);
    }

    return canceledCount;
  } catch (error) {
    console.error('[CRON TransferExpiration] Error crítico:', error);
    return canceledCount;
  } finally {
    await RedisService.releaseLock(LOCK_KEY);
  }
}

export const startTransferExpirationCron = () => {
  cron.schedule('0 * * * *', async () => {
    await processExpiredTransferOrders();
  });

  setTimeout(() => {
    processExpiredTransferOrders().catch((err) =>
      console.error('[CRON TransferExpiration] Error en barrido inicial:', err)
    );
  }, 15_000);
};