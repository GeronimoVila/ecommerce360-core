import { Router } from 'express';
import { login, logout, registerCustomer, getSession } from './auth.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/login', login);
router.post('/logout', requireAuth([]), logout);
router.post('/register', registerCustomer);
router.get('/me', requireAuth(['SELLER', 'ADMIN']), getSession);

export default router;