import { Router } from 'express';
import {
  createCategory,
  getCategoryTree,
  updateCategory,
  deleteCategory
} from './categories.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/tree', getCategoryTree);
router.post('/', requireAuth(['ADMIN']), createCategory);
router.patch('/:id', requireAuth(['ADMIN']), updateCategory);
router.delete('/:id', requireAuth(['ADMIN']), deleteCategory);

export default router;