import { Router } from 'express';
import { getAvailableCommissions, liquidateCommissions, getPayoutHistory } from './commissions.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/available', requireAuth(['ADMIN']), getAvailableCommissions);
router.post('/liquidate', requireAuth(['ADMIN']), liquidateCommissions);
router.get('/payouts', requireAuth(['ADMIN']), getPayoutHistory);
router.get('/my-commissions', requireAuth(['SELLER', 'ADMIN']), getAvailableCommissions);
router.get('/my-payouts', requireAuth(['SELLER', 'ADMIN']), getPayoutHistory);

export default router;