import { Router } from 'express';
import { NotificationService } from '../../services/notificationService';
import { authenticate } from '../../middleware/auth';
import { sendSuccess } from '../../utils/response';

const router = Router();
router.use(authenticate);

// GET /notifications
router.get('/', async (req, res) => {
  const notifications = await NotificationService.getAll(req.user!.id);
  return sendSuccess(res, notifications);
});

// PATCH /notifications/:id/read — `all` is retained for the existing client.
router.patch('/:id/read', async (req, res) => {
  if (req.params.id === 'all') await NotificationService.markAllRead(req.user!.id);
  else await NotificationService.markRead(req.user!.id, req.params.id);
  return sendSuccess(res, { message: req.params.id === 'all' ? 'All marked as read' : 'Marked as read' });
});

export default router;
