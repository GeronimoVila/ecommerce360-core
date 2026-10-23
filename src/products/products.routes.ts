import { Router } from 'express';
import { 
  createProduct, 
  updateProduct, 
  deactivateProduct,
  getProducts,
  getProductById,
  reactivateProduct,
  createCombo,
  getAdminCatalog
} from './products.controller';
import { processRestock, getSupplierPurchases, updateSupplierPurchaseMetadata } from './inventory.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();


router.get('/', getProducts);
router.get('/admin', requireAuth(['ADMIN']), getAdminCatalog);
router.post('/restock', requireAuth(['ADMIN']), processRestock);
router.get('/restock/all', requireAuth(['ADMIN']), getSupplierPurchases);
router.post('/combos', requireAuth(['ADMIN']), createCombo);
router.post('/', requireAuth(['ADMIN']), createProduct);
router.get('/:id', getProductById);
router.patch('/:id', requireAuth(['ADMIN']), updateProduct);
router.delete('/:id', requireAuth(['ADMIN']), deactivateProduct);
router.patch('/:id/restore', requireAuth(['ADMIN']), reactivateProduct);
router.patch('/restock/:id', requireAuth(['ADMIN']), updateSupplierPurchaseMetadata);

export default router;