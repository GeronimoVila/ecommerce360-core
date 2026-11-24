import { Router } from 'express';
import { requireAuth } from '../common/guards/auth.guard';
import {
  getMyNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  streamNotifications,
} from './notifications.controller';

const router = Router();

router.get('/', requireAuth(), getMyNotifications);
router.get('/unread-count', requireAuth(), getUnreadCount);
router.get('/stream', requireAuth(), streamNotifications);
router.patch('/read-all', requireAuth(), markAllNotificationsAsRead);
router.patch('/:id/read', requireAuth(), markNotificationAsRead);

export default router;