import { Router } from 'express';
import { createCheckoutIntent, receiveMpWebhook } from './checkout.controller';
import { syncCart, validateCoupon } from './cart.controller';

const router = Router();

router.post('/intent', createCheckoutIntent);
router.post('/cart/sync', syncCart);
router.post('/coupons/validate', validateCoupon);
router.post('/webhook/mp', receiveMpWebhook);

export default router;