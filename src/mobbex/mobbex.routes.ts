import { Router } from 'express';
import {
  getMobbexStatus,
  initMobbexConnect,
  mobbexOAuthBridge,
  finalizeMobbexConnect,
  createMobbexCheckout,
  handleMobbexWebhook,
  simulateMobbexGateway,
  toggleMobbexMode
} from './mobbex.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/status', requireAuth(['ADMIN']), getMobbexStatus);
router.post('/connect', requireAuth(['ADMIN']), initMobbexConnect);
router.post('/finalize', requireAuth(['ADMIN']), finalizeMobbexConnect);
router.patch('/mode', requireAuth(['ADMIN']), toggleMobbexMode);
router.get('/oauth-bridge', mobbexOAuthBridge);
router.post('/checkout', requireAuth(['CUSTOMER']), createMobbexCheckout);
router.post('/webhook', handleMobbexWebhook);
if (process.env.NODE_ENV !== 'production') {
  router.get('/mock-gateway', simulateMobbexGateway);
}

export default router;