import { Request, Response } from 'express';
import { prismaGlobal } from '../config/prisma';
import { NotificationsService, notificationBus } from './notifications.service';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const getMyNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'No autorizado.' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 15));
    const unreadOnly = req.query.unreadOnly === 'true';
    const skip = (page - 1) * limit;

    const whereClause = {
      user_id: userId,
      ...(unreadOnly ? { read_at: null } : {}),
    };

    const [items, total, unreadCount] = await Promise.all([
      prismaGlobal.notification.findMany({
        where: whereClause,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      prismaGlobal.notification.count({ where: whereClause }),
      NotificationsService.getUnreadCount(userId),
    ]);

    res.status(200).json({
      success: true,
      data: items,
      unread_count: unreadCount,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('[NotificationsController.getMyNotifications] Error:', error.message);
    res.status(500).json({ error: 'Error al obtener notificaciones.' });
  }
};

export const getUnreadCount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'No autorizado.' });
      return;
    }

    const count = await NotificationsService.getUnreadCount(userId);
    res.status(200).json({ unread_count: count });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al consultar contador de notificaciones.' });
  }
};

export const markNotificationAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.sub;
    const id = req.params.id as string;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado.' });
      return;
    }

    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'ID de notificación inválido.' });
      return;
    }

    await prismaGlobal.notification.updateMany({
      where: { id, user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });

    await NotificationsService.invalidateUnreadCache(userId);
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al marcar notificación como leída.' });
  }
};

export const markAllNotificationsAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'No autorizado.' });
      return;
    }

    await prismaGlobal.notification.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });

    await NotificationsService.invalidateUnreadCache(userId);
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al marcar todas las notificaciones como leídas.' });
  }
};

export const streamNotifications = (req: Request, res: Response): void => {
  const userId = req.user?.sub;
  if (!userId) {
    res.status(401).end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const channel = `user:${userId}`;
  const onNotification = (notification: any) => {
    res.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
  };

  notificationBus.on(channel, onNotification);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    notificationBus.off(channel, onNotification);
  });
};