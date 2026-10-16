import { Router } from 'express';
import { 
  createPaymentRule, 
  getPaymentRules, 
  updatePaymentRule, 
  softDeletePaymentRule 
} from './payment-rules.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/', requireAuth(['ADMIN']), createPaymentRule);
router.get('/', getPaymentRules);
router.patch('/:id', requireAuth(['ADMIN']), updatePaymentRule);
router.delete('/:id', requireAuth(['ADMIN']), softDeletePaymentRule);

export default router;