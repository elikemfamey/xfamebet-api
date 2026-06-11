import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { authenticate, requireAffiliate } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { WalletService } from '../../services/walletService';
import { generateReferralCode } from '../../utils/crypto';

const router = Router();
router.use(authenticate);

const registerSchema = z.object({
  commission_type: z.enum(['cpa', 'revenue_share', 'hybrid']).default('revenue_share'),
  website_url: z.string().url().optional(),
  marketing_channels: z.array(z.string()).optional(),
});

const generateLinkSchema = z.object({
  campaign: z.string().optional(),
});

const withdrawSchema = z.object({
  amount: z.number().positive(),
  payment_provider: z.enum(['momo_mtn', 'momo_telecel', 'momo_airteltigo', 'ng_bank_transfer', 'usdt_trc20']),
  account_details: z.record(z.string()),
});

// POST /affiliates/register
router.post('/register', validateBody(registerSchema), async (req, res) => {
  const { commission_type, website_url, marketing_channels } = req.body;

  const { data: existing } = await supabase.from('affiliates').select('id').eq('user_id', req.user!.id).single();
  if (existing) return sendError(res, 'Already registered as affiliate', 409);

  const { data } = await supabase.from('affiliates').insert({
    user_id: req.user!.id,
    commission_type,
    commission_rate: commission_type === 'cpa' ? 0 : 0.15,
    website_url,
    marketing_channels,
    approval_status: 'pending',
  }).select().single();

  await supabase.from('users').update({ role: 'affiliate' }).eq('id', req.user!.id);

  return sendSuccess(res, data, 201);
});

// GET /affiliates/dashboard
router.get('/dashboard', requireAffiliate, async (req, res) => {
  const { data: affiliate } = await supabase.from('affiliates')
    .select('*').eq('user_id', req.user!.id).single();
  if (!affiliate) return sendError(res, 'Affiliate not found', 404);

  const { count: totalReferrals } = await supabase.from('affiliate_referrals')
    .select('id', { count: 'exact' }).eq('affiliate_id', affiliate.id);

  const { data: referrals } = await supabase.from('affiliate_referrals')
    .select('deposit_total, betting_volume, commission_earned')
    .eq('affiliate_id', affiliate.id);

  const totalDeposits = referrals?.reduce((s, r) => s + r.deposit_total, 0) ?? 0;
  const totalVolume = referrals?.reduce((s, r) => s + r.betting_volume, 0) ?? 0;

  const { count: clickCount } = await supabase.from('affiliate_clicks')
    .select('id', { count: 'exact' }).eq('affiliate_id', affiliate.id);

  const { count: convertedCount } = await supabase.from('affiliate_clicks')
    .select('id', { count: 'exact' }).eq('affiliate_id', affiliate.id).eq('converted', true);

  const conversionRate = (clickCount ?? 0) > 0
    ? (((convertedCount ?? 0) / (clickCount ?? 1)) * 100).toFixed(2)
    : '0.00';

  return sendSuccess(res, {
    affiliate,
    stats: {
      total_referrals: totalReferrals ?? 0,
      total_clicks: clickCount ?? 0,
      converted_clicks: convertedCount ?? 0,
      conversion_rate: conversionRate,
      total_deposits: totalDeposits,
      total_volume: totalVolume,
      total_earnings: affiliate.total_earnings,
      withdrawal_balance: affiliate.withdrawal_balance,
    },
  });
});

// GET /affiliates/earnings
router.get('/earnings', requireAffiliate, async (req, res) => {
  const { data: affiliate } = await supabase.from('affiliates').select('id').eq('user_id', req.user!.id).single();
  if (!affiliate) return sendError(res, 'Affiliate not found', 404);

  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data: logs, count } = await supabase
    .from('affiliate_commission_logs')
    .select('*, users!affiliate_commission_logs_referred_user_id_fkey(username)', { count: 'exact' })
    .eq('affiliate_id', affiliate.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Fallback: if FK join fails, enrich manually
  let enriched = logs ?? [];
  if (enriched.length > 0 && !(enriched[0] as Record<string, unknown>).users) {
    const userIds = [...new Set(enriched.map((l: Record<string, unknown>) => l.referred_user_id as string))];
    const { data: users } = await supabase.from('users').select('id, username').in('id', userIds);
    const userMap = Object.fromEntries((users ?? []).map((u: Record<string, unknown>) => [u.id, u]));
    enriched = enriched.map((l: Record<string, unknown>) => ({ ...l, users: userMap[l.referred_user_id as string] ?? null }));
  }

  return sendPaginated(res, enriched, count ?? 0, page, limit);
});

// GET /affiliates/referrals
router.get('/referrals', requireAffiliate, async (req, res) => {
  const { data: affiliate } = await supabase.from('affiliates').select('id').eq('user_id', req.user!.id).single();
  if (!affiliate) return sendError(res, 'Affiliate not found', 404);

  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data, count } = await supabase
    .from('affiliate_referrals')
    .select('*, users(username, country, created_at)', { count: 'exact' })
    .eq('affiliate_id', affiliate.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// GET /affiliates/earnings-chart
router.get('/earnings-chart', requireAffiliate, async (req, res) => {
  const { data: affiliate } = await supabase.from('affiliates').select('id').eq('user_id', req.user!.id).single();
  if (!affiliate) return sendError(res, 'Affiliate not found', 404);

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600000).toISOString();
  const { data: logs } = await supabase.from('affiliate_commission_logs')
    .select('created_at, commission_amount')
    .eq('affiliate_id', affiliate.id)
    .gte('created_at', ninetyDaysAgo)
    .order('created_at', { ascending: true });

  if (!logs || logs.length === 0) return sendSuccess(res, []);

  const byDay: Record<string, number> = {};
  for (const log of logs) {
    const day = (log.created_at as string).slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + (log.commission_amount as number);
  }

  let cumulative = 0;
  const points = Object.entries(byDay).map(([date, amount]) => {
    cumulative += amount;
    return { date, amount: parseFloat(amount.toFixed(2)), cumulative: parseFloat(cumulative.toFixed(2)) };
  });

  return sendSuccess(res, points);
});

// POST /affiliates/generate-link
router.post('/generate-link', requireAffiliate, validateBody(generateLinkSchema), async (req, res) => {
  const { campaign } = req.body;
  const { data: user } = await supabase.from('users').select('referral_code').eq('id', req.user!.id).single();
  if (!user) return sendError(res, 'User not found', 404);

  const baseUrl = (process.env.FRONTEND_URL ?? 'https://xfamebet.com').split(',')[0].trim();
  const link = `${baseUrl}/register?ref=${user.referral_code}${campaign ? `&campaign=${encodeURIComponent(campaign)}` : ''}`;

  return sendSuccess(res, { link, referral_code: user.referral_code });
});

// POST /affiliates/generate-promo
router.post('/generate-promo', requireAffiliate, async (req, res) => {
  const { data: affiliate } = await supabase.from('affiliates').select('id, approval_status').eq('user_id', req.user!.id).single();
  if (!affiliate || affiliate.approval_status !== 'approved') return sendError(res, 'Affiliate not approved', 403);

  const code = `AFF${generateReferralCode()}`;
  const { data } = await supabase.from('promo_codes').insert({
    code, promotion_type: 'affiliate_promo', affiliate_id: affiliate.id,
    value: 20, value_type: 'fixed', usage_limit: 100, status: 'active',
  }).select().single();

  return sendSuccess(res, data, 201);
});

// POST /affiliates/withdraw
router.post('/withdraw', requireAffiliate, validateBody(withdrawSchema), async (req, res) => {
  const { amount, payment_provider, account_details } = req.body;
  const { data: affiliate } = await supabase.from('affiliates').select('*').eq('user_id', req.user!.id).single();
  if (!affiliate) return sendError(res, 'Affiliate not found', 404);
  if (affiliate.withdrawal_balance < amount) return sendError(res, 'Insufficient affiliate earnings', 400);

  const { data: wallet } = await supabase.from('wallets').select('id').eq('user_id', req.user!.id).single();
  if (!wallet) return sendError(res, 'Wallet not found', 404);

  await supabase.from('withdrawal_requests').insert({
    user_id: req.user!.id,
    amount,
    currency: 'USD',
    payment_provider,
    account_details: { ...account_details, type: 'affiliate_earnings' },
    status: 'pending',
  });

  await supabase.from('affiliates')
    .update({ withdrawal_balance: affiliate.withdrawal_balance - amount })
    .eq('id', affiliate.id);

  await supabase.from('transactions').insert({
    user_id: req.user!.id,
    wallet_id: wallet.id,
    type: 'affiliate_commission',
    amount: -amount,
    currency: 'USD',
    status: 'pending',
    description: 'Affiliate commission withdrawal',
  });

  return sendSuccess(res, { message: 'Withdrawal request submitted. Awaiting admin approval.' }, 201);
});

// GET /affiliates/clicks
router.get('/clicks', requireAffiliate, async (req, res) => {
  const { data: affiliate } = await supabase.from('affiliates').select('id').eq('user_id', req.user!.id).single();
  if (!affiliate) return sendError(res, 'Affiliate not found', 404);

  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data, count } = await supabase
    .from('affiliate_clicks')
    .select('*', { count: 'exact' })
    .eq('affiliate_id', affiliate.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

export default router;
