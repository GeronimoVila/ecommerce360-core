import { Router } from 'express';
import { createBudget, payBudget, getBudgetById, mercadopagoWebhookHandler } from './budget.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/create', requireAuth(['SELLER', 'ADMIN']), createBudget);
router.get('/:id', getBudgetById); 
router.post('/:id/pay', payBudget);
router.post('/webhook/mp', mercadopagoWebhookHandler);

export default router;