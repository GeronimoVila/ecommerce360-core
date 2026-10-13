import { Router } from 'express';
import { login, logout, registerCustomer } from './auth.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/login', login);
router.post('/logout', requireAuth([]), logout);
router.post('/register', registerCustomer);

export default router;