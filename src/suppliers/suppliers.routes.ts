import { Router } from 'express';
import { getSuppliers, createSupplier } from './suppliers.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/', requireAuth(['ADMIN']), getSuppliers);
router.post('/', requireAuth(['ADMIN']), createSupplier);

export default router;