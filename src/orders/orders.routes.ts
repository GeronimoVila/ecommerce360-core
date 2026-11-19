import { Router } from 'express';
import { getMySales, getManageableOrders, updateOrderStatus, getMyOrders, getMyOrderDetail, getOrderPublicStatus } from './orders.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/my-sales', requireAuth(['SELLER', 'ADMIN']), getMySales);
router.get('/manage', requireAuth(['SELLER', 'ADMIN']), getManageableOrders);
router.patch('/:id/status', requireAuth(['SELLER', 'ADMIN']), updateOrderStatus);
router.get('/my-orders', requireAuth(['CUSTOMER']), getMyOrders);
router.get('/my-orders/:id', requireAuth(['CUSTOMER']), getMyOrderDetail);
router.get('/:id/status', getOrderPublicStatus);

export default router;