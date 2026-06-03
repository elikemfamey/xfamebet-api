import { Router } from 'express';
import { supabase } from '../../config/supabase';
import { authenticate } from '../../middleware/auth';
import { sendSuccess } from '../../utils/response';

const router = Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const { data } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', req.user!.id)
    .order('created_at', { ascending: false })
    .limit(50);
  return sendSuccess(res, data ?? []);
});

router.patch('/:id/read', async (req, res) => {
  await supabase.from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id);
  return sendSuccess(res, { message: 'Marked as read' });
});

router.patch('/read-all', async (req, res) => {
  await supabase.from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', req.user!.id)
    .is('read_at', null);
  return sendSuccess(res, { message: 'All marked as read' });
});

export default router;
