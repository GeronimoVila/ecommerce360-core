import { Router } from 'express';
import { 
  createProduct, 
  updateProduct, 
  deactivateProduct,
  getProducts,
  getProductById,
  reactivateProduct,
  createCombo
} from './products.controller';
import { processRestock, getSupplierPurchases, updateSupplierPurchaseMetadata } from './inventory.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

// Rutas públicas
router.get('/', getProducts);
router.get('/:id', getProductById);

// Rutas privadas (requieren autenticación y rol ADMIN)
router.post('/', requireAuth(['ADMIN']), createProduct);
router.patch('/:id', requireAuth(['ADMIN']), updateProduct);
router.delete('/:id', requireAuth(['ADMIN']), deactivateProduct);
router.patch('/:id/restore', requireAuth(['ADMIN']), reactivateProduct);
router.post('/combos', requireAuth(['ADMIN']), createCombo);
router.post('/restock', requireAuth(['ADMIN']), processRestock);
router.get('/restock/all', requireAuth(['ADMIN']), getSupplierPurchases);
router.patch('/restock/:id', requireAuth(['ADMIN']), updateSupplierPurchaseMetadata);

export default router;