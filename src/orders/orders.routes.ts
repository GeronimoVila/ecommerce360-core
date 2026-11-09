import { Router } from 'express';
import { getMySales } from './orders.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/my-sales', requireAuth(['SELLER', 'ADMIN']), getMySales);

export default router;