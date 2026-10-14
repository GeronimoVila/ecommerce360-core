import { Router } from 'express';
import { createSeller, updateUser, deactivateUser } from './users.controller';
import { getMyProfile } from './profile.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.post('/seller', requireAuth(['ADMIN']), createSeller);
router.patch('/:id', requireAuth(['ADMIN']), updateUser);
router.delete('/:id', requireAuth(['ADMIN']), deactivateUser);
router.get('/me', requireAuth([]), getMyProfile);

export default router;