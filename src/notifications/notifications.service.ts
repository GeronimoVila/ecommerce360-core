import { EventEmitter } from 'events';
import { NotificationType, Role, Prisma } from '@prisma/client';
import { prismaGlobal } from '../config/prisma';
import { RedisService } from '../redis/redis.service';

export interface CreateNotificationInput {
  userId: string;
  role: Role;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl?: string;
  metadata?: Prisma.InputJsonValue;
  dedupKey?: string;
}

export const notificationBus = new EventEmitter();
notificationBus.setMaxListeners(0);

const UNREAD_CACHE_TTL = 300;
const unreadKey = (userId: string) => `notif:unread:${userId}`;

export class NotificationsService {
  static async notify(input: CreateNotificationInput): Promise<void> {
    try {
      const created = await prismaGlobal.notification.create({
        data: {
          user_id: input.userId,
          role: input.role,
          type: input.type,
          title: input.title,
          message: input.message,
          action_url: input.actionUrl || null,
          metadata: input.metadata ?? Prisma.JsonNull,
          dedup_key: input.dedupKey || null,
        },
      });

      await this.invalidateUnreadCache(input.userId);
      notificationBus.emit(`user:${input.userId}`, created);
    } catch (error: any) {
      if (error?.code === 'P2002') {
        return;
      }
      console.error(`[NotificationsService.notify] Error creando notificación (${input.type}):`, error.message);
    }
  }

  static async notifyAdmins(
    payload: Omit<CreateNotificationInput, 'userId' | 'role' | 'dedupKey'> & { baseDedupKey?: string }
  ): Promise<void> {
    try {
      const admins = await prismaGlobal.user.findMany({
        where: { role: Role.ADMIN, is_active: true },
        select: { id: true },
      });

      await Promise.all(
        admins.map((admin) =>
          this.notify({
            userId: admin.id,
            role: Role.ADMIN,
            type: payload.type,
            title: payload.title,
            message: payload.message,
            actionUrl: payload.actionUrl,
            metadata: payload.metadata,
            dedupKey: payload.baseDedupKey ? `${payload.baseDedupKey}:${admin.id}` : undefined,
          })
        )
      );
    } catch (error: any) {
      console.error('[NotificationsService.notifyAdmins] Error:', error.message);
    }
  }

  static async checkAndNotifyLowStock(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;

    try {
      const uniqueIds = Array.from(new Set(productIds));
      const products = await prismaGlobal.product.findMany({
        where: {
          id: { in: uniqueIds },
          is_active: true,
          is_combo: false,
          low_stock_alerted: false,
        },
        select: {
          id: true,
          sku: true,
          name: true,
          physical_stock: true,
          low_stock_threshold: true,
        },
      });

      for (const product of products) {
        if (product.physical_stock <= product.low_stock_threshold) {
          const claimed = await prismaGlobal.product.updateMany({
            where: { id: product.id, low_stock_alerted: false },
            data: { low_stock_alerted: true },
          });

          if (claimed.count > 0) {
            const isOut = product.physical_stock === 0;
            await this.notifyAdmins({
              type: NotificationType.CRITICAL_STOCK_SHORTAGE,
              title: isOut ? `Sin stock: ${product.sku}` : `Stock crítico: ${product.sku}`,
              message: isOut
                ? `El producto "${product.name}" (SKU: ${product.sku}) llegó a 0 unidades.`
                : `El producto "${product.name}" (SKU: ${product.sku}) quedó con ${product.physical_stock} unidades (mínimo: ${product.low_stock_threshold}).`,
              actionUrl: `/products?search=${encodeURIComponent(product.sku)}`,
              metadata: {
                product_id: product.id,
                sku: product.sku,
                physical_stock: product.physical_stock,
                threshold: product.low_stock_threshold,
              },
            });
          }
        }
      }
    } catch (error: any) {
      console.error('[NotificationsService.checkAndNotifyLowStock] Error:', error.message);
    }
  }

  static async getUnreadCount(userId: string): Promise<number> {
    try {
      const cached = await RedisService.get(unreadKey(userId));
      if (cached !== null) {
        return parseInt(cached, 10);
      }
    } catch {
    }

    const count = await prismaGlobal.notification.count({
      where: { user_id: userId, read_at: null },
    });

    try {
      await RedisService.set(unreadKey(userId), count.toString(), UNREAD_CACHE_TTL);
    } catch {}

    return count;
  }

  static async invalidateUnreadCache(userId: string): Promise<void> {
    try {
      await RedisService.releaseLock(unreadKey(userId));
    } catch {}
  }
}