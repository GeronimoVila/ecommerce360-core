import { Router } from 'express';
import { createCheckoutIntent } from './checkout.controller';

const router = Router();

router.post('/intent', createCheckoutIntent);

export default router;