import { Router } from 'express';
import { createCheckoutIntent } from './checkout.controller';
import { syncCart, validateCoupon } from './cart.controller';

const router = Router();

router.post('/intent', createCheckoutIntent);
router.post('/cart/sync', syncCart);
router.post('/coupons/validate', validateCoupon);

export default router;