import { Router } from 'express';
import { getMySales, getOrderPublicStatus } from './orders.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/my-sales', requireAuth(['SELLER', 'ADMIN']), getMySales);
router.get('/:id/status', getOrderPublicStatus);

export default router;