import { Router } from 'express';
import { getNetRevenue, getSellersDebt, getInventoryAlerts, getPerformanceChart, getTopSellers, getOperationalAlerts, getSellerDashboard } from './dashboard.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/revenue', requireAuth(['ADMIN']), getNetRevenue);
router.get('/debt', requireAuth(['ADMIN']), getSellersDebt);
router.get('/inventory-alerts', requireAuth(['ADMIN']), getInventoryAlerts);
router.get('/performance', requireAuth(['ADMIN']), getPerformanceChart);
router.get('/top-sellers', requireAuth(['ADMIN']), getTopSellers);
router.get('/alerts', requireAuth(['ADMIN']), getOperationalAlerts);

router.get('/seller/me', requireAuth(['SELLER']), getSellerDashboard);
        
export default router;