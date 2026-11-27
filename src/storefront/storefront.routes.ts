import { Router } from 'express';
import {
  getPublicStorefrontHome,
  getAdminStorefrontConfig,
  requestBannerPresignedUpload,
  createStorefrontBanner,
  updateStorefrontBanner,
  deleteStorefrontBanner,
  syncFeaturedProducts,
} from './storefront.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/home', getPublicStorefrontHome);
router.get('/admin', requireAuth(['ADMIN']), getAdminStorefrontConfig);
router.post('/banners/presign', requireAuth(['ADMIN']), requestBannerPresignedUpload);
router.post('/banners', requireAuth(['ADMIN']), createStorefrontBanner);
router.patch('/banners/:id', requireAuth(['ADMIN']), updateStorefrontBanner);
router.delete('/banners/:id', requireAuth(['ADMIN']), deleteStorefrontBanner);
router.put('/featured-products', requireAuth(['ADMIN']), syncFeaturedProducts);

export default router;