import { Router } from 'express';
import { createSeller } from './users.controller';
import { getMyProfile } from './profile.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/seller', requireAuth(['ADMIN']), createSeller);
router.get('/me', requireAuth([]), getMyProfile);

export default router;