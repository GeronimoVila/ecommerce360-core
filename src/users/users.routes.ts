import { Router } from 'express';
import { createSeller, updateUser, deactivateUser, validateSellerId, getSellers } from './users.controller';
import { getMyProfile, updateMyProfile, changeMyPassword } from './profile.controller';
import { requireAuth } from '../common/guards/auth.guard';

const router = Router();

router.get('/sellers', requireAuth(['ADMIN']), getSellers);
router.post('/seller', requireAuth(['ADMIN']), createSeller);
router.get('/me', requireAuth([]), getMyProfile);
router.patch('/me', requireAuth([]), updateMyProfile);
router.post('/me/password', requireAuth([]), changeMyPassword);
router.get('/validate/:id', validateSellerId);
router.patch('/:id', requireAuth(['ADMIN']), updateUser);
router.delete('/:id', requireAuth(['ADMIN']), deactivateUser);

export default router;