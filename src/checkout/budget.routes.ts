import { Router } from 'express';
import { createBudget, payBudget } from './budget.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post( '/create', requireAuth(['SELLER', 'ADMIN']), createBudget );
router.post( '/:id/pay', payBudget );

export default router;