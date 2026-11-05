import { Router } from 'express';
import { createCheckoutIntent, receiveMpWebhook } from './checkout.controller';
import { syncCart, validateCoupon } from './cart.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/intent', requireAuth(['CUSTOMER']), createCheckoutIntent);
router.post('/cart/sync', syncCart);
router.post('/coupons/validate', validateCoupon);
router.post('/webhook/mp', receiveMpWebhook);

export default router;