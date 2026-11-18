import { Router } from 'express';
import {
  requestPresignedUpload,
  syncProductImages,
  deleteProductImage,
} from './media.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/presign', requireAuth(['ADMIN']), requestPresignedUpload);
router.patch('/product/:productId/sync', requireAuth(['ADMIN']), syncProductImages);
router.delete('/:imageId', requireAuth(['ADMIN']), deleteProductImage);

export default router;