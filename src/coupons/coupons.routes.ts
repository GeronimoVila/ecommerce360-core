import { Router } from 'express';
import { getCoupons, createCoupon, updateCoupon, deleteCoupon } from './coupons.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/', requireAuth(['ADMIN']), getCoupons);
router.post('/', requireAuth(['ADMIN']), createCoupon);
router.patch('/:id', requireAuth(['ADMIN']), updateCoupon);
router.delete('/:id', requireAuth(['ADMIN']), deleteCoupon);

export default router;