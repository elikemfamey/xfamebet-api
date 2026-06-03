import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { authenticate, requireAdmin, requireFraudAnalyst } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { FraudService } from '../../services/fraudService';
import { AdminLogService } from '../../services/adminLogService';

const router = Router();

// POST /fraud/fingerprint - capture device fingerprint (public with auth)
router.post('/fingerprint', authenticate, validateBody(z.object({
  device_hash: z.string(), browser: z.string(), os: z.string(),
  screen_resolution: z.string().optional(), timezone: z.string().optional(),
  language: z.string().optional(), webgl_data: z.string().optional(),
  canvas_fingerprint: z.string().optional(),
  vpn_detected: z.boolean().optional(), proxy_detected: z.boolean().optional(),
  emulator_detected: z.boolean().optional(),
})), async (req, res) => {
  const result = await FraudService.captureDeviceFingerprint(req.user!.id, {
    ...req.body, ip_address: req.ip ?? '0.0.0.0',
  });

  if (result.banned) {
    return sendError(res, 'Device is banned', 403);
  }
  return sendSuccess(res, { captured: true });
});

// ==================== FRAUD ANALYST / ADMIN ====================
router.use(authenticate, requireFraudAnalyst);

// GET /fraud/events
router.get('/events', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const userId = req.query.user_id as string;
  const eventType = req.query.event_type as string;

  let query = supabase.from('fraud_events')
    .select('*, users(username, email)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (userId) query = query.eq('user_id', userId);
  if (eventType) query = query.eq('event_type', eventType);

  const { data, count } = await query;
  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// GET /fraud/user/:userId/profile
router.get('/user/:userId/profile', async (req, res) => {
  const { userId } = req.params;

  const [userResult, riskResult, devicesResult, eventsResult, betsResult, depositsResult, affiliateResult] = await Promise.all([
    supabase.from('users').select('*').eq('id', userId).single(),
    supabase.from('risk_scores').select('*').eq('user_id', userId).single(),
    supabase.from('device_fingerprints').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('fraud_events').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
    supabase.from('bets').select('stake, status, placed_at').eq('user_id', userId).order('placed_at', { ascending: false }).limit(20),
    supabase.from('deposit_requests').select('amount, status, payment_provider, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('affiliate_referrals').select('*').eq('referred_user_id', userId).single(),
  ]);

  return sendSuccess(res, {
    user: userResult.data,
    risk_score: riskResult.data,
    devices: devicesResult.data,
    recent_fraud_events: eventsResult.data,
    recent_bets: betsResult.data,
    recent_deposits: depositsResult.data,
    affiliate_connection: affiliateResult.data,
  });
});

// GET /fraud/cases/:id
router.get('/cases/:id', async (req, res) => {
  const { data } = await supabase.from('fraud_cases')
    .select('*, users(username, email), risk_scores(score, level, factors)')
    .eq('id', req.params.id).single();
  if (!data) return sendError(res, 'Case not found', 404);
  return sendSuccess(res, data);
});

// POST /fraud/cases/:id/assign
router.post('/cases/:id/assign', validateBody(z.object({ admin_id: z.string().uuid() })), async (req, res) => {
  await supabase.from('fraud_cases').update({ assigned_admin: req.body.admin_id, status: 'investigating' }).eq('id', req.params.id);
  return sendSuccess(res, { message: 'Case assigned' });
});

// POST /fraud/cases/:id/resolve
router.post('/cases/:id/resolve', validateBody(z.object({ resolution: z.string(), status: z.enum(['resolved', 'dismissed']) })), async (req, res) => {
  const { resolution, status } = req.body;
  await supabase.from('fraud_cases').update({ status, resolution, resolved_at: new Date().toISOString() }).eq('id', req.params.id);
  await AdminLogService.log(req.user!.id, 'resolve_fraud_case', 'fraud_cases', req.params.id, { resolution, status });
  return sendSuccess(res, { message: 'Case resolved' });
});

// POST /fraud/ban-ip
router.post('/ban-ip', requireAdmin, validateBody(z.object({ ip_address: z.string() })), async (req, res) => {
  const { ip_address } = req.body;
  await supabase.from('device_fingerprints').update({ banned: true }).eq('ip_address', ip_address);
  await AdminLogService.log(req.user!.id, 'ban_ip', 'device_fingerprints', ip_address, {});
  return sendSuccess(res, { message: 'IP banned' });
});

export default router;
