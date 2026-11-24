import { Router } from 'express';
import { getAvailableCommissions, liquidateCommissions, requestPayout, getPayoutHistory, getMyCommissions, getMyPayouts } from './commissions.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/available', requireAuth(['ADMIN']), getAvailableCommissions);
router.post('/liquidate', requireAuth(['ADMIN']), liquidateCommissions);
router.post('/request-payout', requireAuth(['SELLER']), requestPayout);
router.get('/payouts', requireAuth(['ADMIN']), getPayoutHistory);
router.get('/my-commissions', requireAuth(['SELLER']), getMyCommissions);
router.get('/my-payouts', requireAuth(['SELLER']), getMyPayouts);

export default router;