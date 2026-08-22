import { RequestHandler, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { authenticate, requireAdmin } from '../../middleware/auth';
import { asyncHandler, sendError, sendPaginated, sendSuccess } from '../../utils/response';
import { AdminLogService } from '../../services/adminLogService';
import { NotificationService } from '../../services/notificationService';
import { emitTicket, ticketDetail, uploadAttachments } from '../support';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPG, PNG and WebP images are allowed')),
});
const statusSchema = z.enum(['open', 'in_progress', 'resolved']);
const assignmentSchema = z.object({ assigned_to: z.string().uuid().nullable() });
const statusUpdateSchema = z.object({ status: statusSchema });
const messageSchema = z.object({ message: z.string().trim().min(1).max(4000) });

router.use(authenticate, requireAdmin);

router.get('/tickets', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const status = req.query.status as string | undefined; const category = req.query.category as string | undefined;
  const assignee = req.query.assignee as string | undefined; const search = (req.query.search as string | undefined)?.trim();
  let userIds: string[] | undefined;
  if (search) {
    const { data: matchingUsers } = await supabase.from('users').select('id').or(`username.ilike.%${search}%,email.ilike.%${search}%`).limit(100);
    userIds = (matchingUsers ?? []).map(user => user.id);
  }
  let query = supabase.from('support_tickets').select('*, customer:users!support_tickets_user_id_fkey(username,email,country), assignee:users!support_tickets_assigned_to_fkey(username)', { count: 'exact' })
    .order('last_message_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  if (status && ['open', 'in_progress', 'resolved'].includes(status)) query = query.eq('status', status);
  if (category && ['payments', 'withdrawals', 'betting', 'account_kyc', 'bonuses', 'technical', 'other'].includes(category)) query = query.eq('category', category);
  if (assignee === 'unassigned') query = query.is('assigned_to', null); else if (assignee) query = query.eq('assigned_to', assignee);
  if (search) query = userIds?.length ? query.or(`subject.ilike.%${search}%,user_id.in.(${userIds.join(',')})`) : query.ilike('subject', `%${search}%`);
  const { data, count, error } = await query; if (error) return sendError(res, error.message, 500);
  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
}));

router.get('/admins', asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from('users').select('id,username,email').in('role', ['admin', 'super_admin']).eq('account_status', 'active').order('username');
  if (error) return sendError(res, error.message, 500); return sendSuccess(res, data ?? []);
}));

router.get('/tickets/:id', asyncHandler(async (req, res) => {
  const detail = await ticketDetail(req.params.id); if (!detail) return sendError(res, 'Support ticket not found', 404);
  await supabase.from('support_tickets').update({ staff_last_read_at: new Date().toISOString() }).eq('id', req.params.id);
  const { data: customer } = await supabase.from('users').select('id,username,email,country,kyc_status,account_status,created_at').eq('id', detail.user_id).single();
  return sendSuccess(res, { ...detail, customer });
}));

router.patch('/tickets/:id/assignment', asyncHandler(async (req, res) => {
  const parsed = assignmentSchema.safeParse(req.body); if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 400);
  if (parsed.data.assigned_to) {
    const { data: assignee } = await supabase.from('users').select('id').eq('id', parsed.data.assigned_to).in('role', ['admin', 'super_admin']).single();
    if (!assignee) return sendError(res, 'Assignee must be an active support administrator', 400);
  }
  const changes: Record<string, unknown> = { assigned_to: parsed.data.assigned_to };
  if (parsed.data.assigned_to) changes.status = 'in_progress';
  const { data: ticket } = await supabase.from('support_tickets').update(changes).eq('id', req.params.id).select().single();
  if (!ticket) return sendError(res, 'Support ticket not found', 404);
  await AdminLogService.log(req.user!.id, parsed.data.assigned_to ? 'assign_support_ticket' : 'unassign_support_ticket', 'support_tickets', ticket.id, { assigned_to: parsed.data.assigned_to });
  const detail = await ticketDetail(ticket.id); emitTicket(detail!, ticket.user_id); return sendSuccess(res, detail);
}));

router.patch('/tickets/:id/status', asyncHandler(async (req, res) => {
  const parsed = statusUpdateSchema.safeParse(req.body); if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 400);
  const resolving = parsed.data.status === 'resolved';
  const { data: ticket } = await supabase.from('support_tickets').update({ status: parsed.data.status, resolved_at: resolving ? new Date().toISOString() : null, resolved_by: resolving ? req.user!.id : null }).eq('id', req.params.id).select().single();
  if (!ticket) return sendError(res, 'Support ticket not found', 404);
  await AdminLogService.log(req.user!.id, `${parsed.data.status}_support_ticket`, 'support_tickets', ticket.id, {});
  const detail = await ticketDetail(ticket.id); emitTicket(detail!, ticket.user_id); return sendSuccess(res, detail);
}));

router.post('/tickets/:id/messages', upload.array('attachments', 3) as unknown as RequestHandler, asyncHandler(async (req, res) => {
  const parsed = messageSchema.safeParse(req.body); if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 400);
  const { data: ticket } = await supabase.from('support_tickets').select('*').eq('id', req.params.id).single();
  if (!ticket) return sendError(res, 'Support ticket not found', 404);
  const { data: message, error } = await supabase.from('support_messages').insert({ ticket_id: ticket.id, author_id: req.user!.id, sender_type: 'staff', body: parsed.data.message }).select().single();
  if (error || !message) return sendError(res, error?.message ?? 'Could not send message', 500);
  await uploadAttachments(req.files as Express.Multer.File[] | undefined, ticket.id, message.id);
  await supabase.from('support_tickets').update({ status: ticket.status === 'resolved' ? 'in_progress' : ticket.status, resolved_at: null, resolved_by: null, last_message_at: new Date().toISOString(), last_message_sender_type: 'staff' }).eq('id', ticket.id);
  await NotificationService.send(ticket.user_id, 'support_reply', 'New support reply', `Our support team replied to: ${ticket.subject}`, { ticket_id: ticket.id });
  await AdminLogService.log(req.user!.id, 'reply_support_ticket', 'support_tickets', ticket.id, {});
  const detail = await ticketDetail(ticket.id); emitTicket(detail!, ticket.user_id); return sendSuccess(res, detail, 201);
}));

export default router;
