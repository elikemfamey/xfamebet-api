import { RequestHandler, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { authenticate } from '../../middleware/auth';
import { asyncHandler, sendError, sendPaginated, sendSuccess } from '../../utils/response';
import { getIO } from '../../socket';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPG, PNG and WebP images are allowed')),
});
const categorySchema = z.enum(['payments', 'withdrawals', 'betting', 'account_kyc', 'bonuses', 'technical', 'other']);
const ticketSchema = z.object({ category: categorySchema, subject: z.string().trim().min(3).max(120), message: z.string().trim().min(1).max(4000) });
const messageSchema = z.object({ message: z.string().trim().min(1).max(4000) });

type Attachment = { id: string; message_id: string; storage_path: string; file_name: string; mime_type: string; file_size: number };

async function signedAttachments(messageIds: string[]) {
  if (!messageIds.length) return new Map<string, Attachment[]>();
  const { data } = await supabase.from('support_message_attachments').select('*').in('message_id', messageIds);
  const result = new Map<string, Attachment[]>();
  await Promise.all((data ?? []).map(async (attachment: Attachment) => {
    const { data: signed } = await supabase.storage.from('support-attachments').createSignedUrl(attachment.storage_path, 3600);
    const item = { ...attachment, url: signed?.signedUrl ?? null } as Attachment;
    const list = result.get(attachment.message_id) ?? [];
    list.push(item); result.set(attachment.message_id, list);
  }));
  return result;
}

async function ticketDetail(ticketId: string) {
  const { data: ticket } = await supabase.from('support_tickets').select('*').eq('id', ticketId).single();
  if (!ticket) return null;
  const { data: messages } = await supabase.from('support_messages').select('*').eq('ticket_id', ticketId).order('created_at');
  const attachments = await signedAttachments((messages ?? []).map(message => message.id));
  return { ...ticket, messages: (messages ?? []).map(message => ({ ...message, attachments: attachments.get(message.id) ?? [] })) };
}

async function uploadAttachments(files: Express.Multer.File[] | undefined, ticketId: string, messageId: string) {
  const attachments = [] as Record<string, unknown>[];
  for (const file of files ?? []) {
    const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const path = `${ticketId}/${messageId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('support-attachments').upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(`Evidence upload failed: ${error.message}`);
    attachments.push({ message_id: messageId, storage_path: path, file_name: file.originalname.slice(0, 255), mime_type: file.mimetype, file_size: file.size });
  }
  if (attachments.length) {
    const { error } = await supabase.from('support_message_attachments').insert(attachments);
    if (error) throw error;
  }
}

function emitTicket(ticket: Record<string, unknown>, userId: string) {
  try { const io = getIO(); io.to(`user:${userId}`).emit('support:ticket:updated', ticket); io.to('admin').emit('support:ticket:updated', ticket); } catch {}
}

router.use(authenticate);

router.get('/tickets', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const status = req.query.status as string | undefined;
  let query = supabase.from('support_tickets').select('*', { count: 'exact' }).eq('user_id', req.user!.id).order('last_message_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  if (status && ['open', 'in_progress', 'resolved'].includes(status)) query = query.eq('status', status);
  const { data, count, error } = await query; if (error) return sendError(res, error.message, 500);
  const tickets = (data ?? []).map(ticket => ({ ...ticket, has_unread_reply: ticket.last_message_sender_type === 'staff' && (!ticket.customer_last_read_at || new Date(ticket.last_message_at) > new Date(ticket.customer_last_read_at)) }));
  return sendPaginated(res, tickets, count ?? 0, page, limit);
}));

router.get('/tickets/:id', asyncHandler(async (req, res) => {
  const { data: ticket } = await supabase.from('support_tickets').select('id').eq('id', req.params.id).eq('user_id', req.user!.id).single();
  if (!ticket) return sendError(res, 'Support ticket not found', 404);
  await supabase.from('support_tickets').update({ customer_last_read_at: new Date().toISOString() }).eq('id', ticket.id);
  return sendSuccess(res, await ticketDetail(ticket.id));
}));

router.post('/tickets', upload.array('attachments', 3) as unknown as RequestHandler, asyncHandler(async (req, res) => {
  const parsed = ticketSchema.safeParse(req.body); if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 400);
  const { data: ticket, error } = await supabase.from('support_tickets').insert({ user_id: req.user!.id, category: parsed.data.category, subject: parsed.data.subject }).select().single();
  if (error || !ticket) return sendError(res, error?.message ?? 'Could not create support ticket', 500);
  const { data: message, error: messageError } = await supabase.from('support_messages').insert({ ticket_id: ticket.id, author_id: req.user!.id, sender_type: 'customer', body: parsed.data.message }).select().single();
  if (messageError || !message) return sendError(res, messageError?.message ?? 'Could not create message', 500);
  await uploadAttachments(req.files as Express.Multer.File[] | undefined, ticket.id, message.id);
  const detail = await ticketDetail(ticket.id); emitTicket(detail!, req.user!.id);
  return sendSuccess(res, detail, 201);
}));

router.post('/tickets/:id/messages', upload.array('attachments', 3) as unknown as RequestHandler, asyncHandler(async (req, res) => {
  const parsed = messageSchema.safeParse(req.body); if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 400);
  const { data: ticket } = await supabase.from('support_tickets').select('*').eq('id', req.params.id).eq('user_id', req.user!.id).single();
  if (!ticket) return sendError(res, 'Support ticket not found', 404);
  const now = new Date().toISOString();
  const { data: message, error } = await supabase.from('support_messages').insert({ ticket_id: ticket.id, author_id: req.user!.id, sender_type: 'customer', body: parsed.data.message }).select().single();
  if (error || !message) return sendError(res, error?.message ?? 'Could not send message', 500);
  await uploadAttachments(req.files as Express.Multer.File[] | undefined, ticket.id, message.id);
  await supabase.from('support_tickets').update({ status: ticket.status === 'resolved' ? 'open' : ticket.status, resolved_at: ticket.status === 'resolved' ? null : ticket.resolved_at, resolved_by: ticket.status === 'resolved' ? null : ticket.resolved_by, last_message_at: now, last_message_sender_type: 'customer' }).eq('id', ticket.id);
  const detail = await ticketDetail(ticket.id); emitTicket(detail!, req.user!.id);
  return sendSuccess(res, detail, 201);
}));

export { ticketDetail, emitTicket, uploadAttachments };
export default router;
