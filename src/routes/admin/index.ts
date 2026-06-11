import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { authenticate, requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { AdminLogService } from '../../services/adminLogService';
import { WalletService } from '../../services/walletService';
import { NotificationService } from '../../services/notificationService';

const router = Router();
router.use(authenticate, requireAdmin);

// ==================== USERS ====================

// GET /admin/users
router.get('/users', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const search = req.query.search as string;
  const status = req.query.status as string;
  const kyc = req.query.kyc as string;
  const country = req.query.country as string;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('users')
    .select('id, username, email, phone, country, kyc_status, account_status, role, created_at, last_login_at, wallets(balance, frozen)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) query = query.or(`username.ilike.%${search}%,email.ilike.%${search}%`);
  if (status) query = query.eq('account_status', status);
  if (kyc) query = query.eq('kyc_status', kyc);
  if (country) query = query.eq('country', country);

  const { data, count } = await query;
  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// GET /admin/users/:id
router.get('/users/:id', async (req, res) => {
  const { data } = await supabase.from('users')
    .select('*, wallets(*), risk_scores(*)')
    .eq('id', req.params.id).single();
  if (!data) return sendError(res, 'User not found', 404);
  return sendSuccess(res, data);
});

// POST /admin/users/:id/suspend
router.post('/users/:id/suspend', validateBody(z.object({ reason: z.string() })), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  await supabase.from('users').update({ account_status: 'suspended' }).eq('id', id);
  await AdminLogService.log(req.user!.id, 'suspend_user', 'users', id, { reason });
  return sendSuccess(res, { message: 'User suspended' });
});

// POST /admin/users/:id/activate
router.post('/users/:id/activate', async (req, res) => {
  const { id } = req.params;
  await supabase.from('users').update({ account_status: 'active' }).eq('id', id);
  await AdminLogService.log(req.user!.id, 'activate_user', 'users', id, {});
  return sendSuccess(res, { message: 'User activated' });
});

// POST /admin/users/:id/ban
router.post('/users/:id/ban', validateBody(z.object({ reason: z.string() })), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  await supabase.from('users').update({ account_status: 'banned' }).eq('id', id);
  await supabase.from('wallets').update({ frozen: true }).eq('user_id', id);
  await AdminLogService.log(req.user!.id, 'ban_user', 'users', id, { reason });
  return sendSuccess(res, { message: 'User banned' });
});

// POST /admin/users/:id/freeze-wallet
router.post('/users/:id/freeze-wallet', async (req, res) => {
  await WalletService.freeze(req.params.id);
  await AdminLogService.log(req.user!.id, 'freeze_wallet', 'wallets', req.params.id, {});
  return sendSuccess(res, { message: 'Wallet frozen' });
});

// POST /admin/users/:id/unfreeze-wallet
router.post('/users/:id/unfreeze-wallet', async (req, res) => {
  await WalletService.unfreeze(req.params.id);
  await AdminLogService.log(req.user!.id, 'unfreeze_wallet', 'wallets', req.params.id, {});
  return sendSuccess(res, { message: 'Wallet unfrozen' });
});

// POST /admin/users/:id/freeze-withdrawals
router.post('/users/:id/freeze-withdrawals', async (req, res) => {
  await supabase.from('wallets').update({ withdrawal_frozen: true }).eq('user_id', req.params.id);
  await AdminLogService.log(req.user!.id, 'freeze_withdrawals', 'users', req.params.id, {});
  return sendSuccess(res, { message: 'Withdrawals frozen' });
});

// POST /admin/users/:id/revoke-sessions
router.post('/users/:id/revoke-sessions', async (req, res) => {
  await supabase.from('sessions').update({ revoked_at: new Date().toISOString() }).eq('user_id', req.params.id);
  await AdminLogService.log(req.user!.id, 'revoke_sessions', 'users', req.params.id, {});
  return sendSuccess(res, { message: 'All sessions revoked' });
});

// ==================== KYC ====================

// GET /admin/kyc/pending
router.get('/kyc/pending', async (req, res) => {
  const { data } = await supabase.from('kyc_documents')
    .select('*, users(username, email, country)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return sendSuccess(res, data ?? []);
});

// POST /admin/kyc/:id/approve
router.post('/kyc/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { data: doc } = await supabase.from('kyc_documents').select('user_id').eq('id', id).single();
  if (!doc) return sendError(res, 'Document not found', 404);

  await supabase.from('kyc_documents').update({ status: 'approved', reviewed_by: req.user!.id, reviewed_at: new Date().toISOString() }).eq('id', id);
  await supabase.from('users').update({ kyc_status: 'approved' }).eq('id', doc.user_id);
  await NotificationService.send(doc.user_id, 'kyc_approved', 'KYC Approved', 'Your identity has been verified.');
  await AdminLogService.log(req.user!.id, 'approve_kyc', 'kyc_documents', id, {});

  return sendSuccess(res, { message: 'KYC approved' });
});

// POST /admin/kyc/:id/reject
router.post('/kyc/:id/reject', validateBody(z.object({ reason: z.string() })), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const { data: doc } = await supabase.from('kyc_documents').select('user_id').eq('id', id).single();
  if (!doc) return sendError(res, 'Document not found', 404);

  await supabase.from('kyc_documents').update({ status: 'rejected', rejection_reason: reason, reviewed_by: req.user!.id, reviewed_at: new Date().toISOString() }).eq('id', id);
  await supabase.from('users').update({ kyc_status: 'rejected' }).eq('id', doc.user_id);
  await NotificationService.send(doc.user_id, 'kyc_rejected', 'KYC Rejected', `Your document was rejected: ${reason}`);
  await AdminLogService.log(req.user!.id, 'reject_kyc', 'kyc_documents', id, { reason });

  return sendSuccess(res, { message: 'KYC rejected' });
});

// ==================== FRAUD ====================

// GET /admin/fraud/cases
router.get('/fraud/cases', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const status = req.query.status as string;

  let query = supabase.from('fraud_cases')
    .select('*, users(username, email), risk_scores(score, level)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, count } = await query;
  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// GET /admin/fraud/risk-scores
router.get('/fraud/risk-scores', async (req, res) => {
  const { data } = await supabase.from('risk_scores')
    .select('*, users(username, email)')
    .gte('score', 31)
    .order('score', { ascending: false })
    .limit(100);
  return sendSuccess(res, data ?? []);
});

// POST /admin/fraud/ban-device
router.post('/fraud/ban-device', validateBody(z.object({ device_hash: z.string() })), async (req, res) => {
  const { device_hash } = req.body;
  await supabase.from('device_fingerprints').update({ banned: true }).eq('device_hash', device_hash);
  await AdminLogService.log(req.user!.id, 'ban_device', 'device_fingerprints', device_hash, {});
  return sendSuccess(res, { message: 'Device banned' });
});

// POST /admin/fraud/reverse-bonus/:id
router.post('/fraud/reverse-bonus/:id', validateBody(z.object({ reason: z.string() })), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const { data: grant } = await supabase.from('user_bonus_grants').select('*').eq('id', id).single();
  if (!grant) return sendError(res, 'Bonus grant not found', 404);

  await supabase.from('user_bonus_grants').update({
    status: 'reversed', reversed_by: req.user!.id, reversed_at: new Date().toISOString(), reverse_reason: reason,
  }).eq('id', id);

  const { data: wallet } = await supabase.from('wallets').select('id, bonus_balance').eq('user_id', grant.user_id).single();
  if (wallet && wallet.bonus_balance >= grant.amount) {
    await supabase.from('wallets').update({ bonus_balance: wallet.bonus_balance - grant.amount }).eq('id', wallet.id);
  }

  await AdminLogService.log(req.user!.id, 'reverse_bonus', 'user_bonus_grants', id, { reason });
  return sendSuccess(res, { message: 'Bonus reversed' });
});

// ==================== ANALYTICS ====================

// GET /admin/revenue
router.get('/revenue', async (req, res) => {
  const from = req.query.from as string ?? new Date(Date.now() - 30 * 24 * 3600000).toISOString();
  const to = req.query.to as string ?? new Date().toISOString();

  const [betsResult, depositsResult, withdrawalsResult, usersResult] = await Promise.all([
    supabase.from('bets').select('stake, payout, status').gte('placed_at', from).lte('placed_at', to),
    supabase.from('deposit_requests').select('amount').eq('status', 'approved').gte('created_at', from).lte('created_at', to),
    supabase.from('withdrawal_requests').select('amount').eq('status', 'approved').gte('created_at', from).lte('created_at', to),
    supabase.from('users').select('id', { count: 'exact' }).gte('created_at', from).lte('created_at', to),
  ]);

  const totalBetVolume = betsResult.data?.reduce((s, b) => s + b.stake, 0) ?? 0;
  const totalWinnings = betsResult.data?.filter(b => b.status === 'won').reduce((s, b) => s + b.payout, 0) ?? 0;
  const grossRevenue = totalBetVolume - totalWinnings;
  const totalDeposits = depositsResult.data?.reduce((s, d) => s + d.amount, 0) ?? 0;
  const totalWithdrawals = withdrawalsResult.data?.reduce((s, w) => s + w.amount, 0) ?? 0;

  return sendSuccess(res, {
    period: { from, to },
    bets: { total_volume: totalBetVolume, total_winnings: totalWinnings, gross_revenue: grossRevenue, count: betsResult.data?.length ?? 0 },
    deposits: { total: totalDeposits, count: depositsResult.data?.length ?? 0 },
    withdrawals: { total: totalWithdrawals, count: withdrawalsResult.data?.length ?? 0 },
    new_users: usersResult.count ?? 0,
    net_revenue: grossRevenue - totalWithdrawals,
  });
});

// GET /admin/affiliates/stats
router.get('/affiliates/stats', async (_req, res) => {
  const [
    { data: affRows },
    { data: refRows },
    { count: totalReferred },
    { data: topRows },
  ] = await Promise.all([
    // Aggregate per-status counts and monetary totals from affiliates table
    supabase.from('affiliates').select('approval_status, total_earnings, withdrawal_balance'),
    // Aggregate deposit and betting volume from referrals
    supabase.from('affiliate_referrals').select('deposit_total, betting_volume'),
    // Total unique referred users
    supabase.from('affiliate_referrals').select('id', { count: 'exact' }),
    // Top 5 affiliates by total earnings
    supabase.from('affiliates')
      .select('id, total_earnings, withdrawal_balance, commission_type, commission_rate, users(username)')
      .eq('approval_status', 'approved')
      .order('total_earnings', { ascending: false })
      .limit(5),
  ]);

  const approved = (affRows ?? []).filter(a => a.approval_status === 'approved').length;
  const pending = (affRows ?? []).filter(a => a.approval_status === 'pending').length;
  const blocked = (affRows ?? []).filter(a => a.approval_status === 'blocked').length;
  const totalCommissionsEarned = (affRows ?? []).reduce((s, a) => s + (a.total_earnings ?? 0), 0);
  const totalCommissionsOwed = (affRows ?? []).reduce((s, a) => s + (a.withdrawal_balance ?? 0), 0);
  const totalCommissionsPaid = totalCommissionsEarned - totalCommissionsOwed;
  const totalAffiliateDeposits = (refRows ?? []).reduce((s, r) => s + (r.deposit_total ?? 0), 0);
  const totalAffiliateBetVolume = (refRows ?? []).reduce((s, r) => s + (r.betting_volume ?? 0), 0);

  return sendSuccess(res, {
    counts: { approved, pending, blocked, total: (affRows ?? []).length },
    financials: {
      total_commissions_earned: totalCommissionsEarned,
      total_commissions_owed: totalCommissionsOwed,
      total_commissions_paid: totalCommissionsPaid,
      total_affiliate_deposits: totalAffiliateDeposits,
      total_affiliate_bet_volume: totalAffiliateBetVolume,
      total_referred_users: totalReferred ?? 0,
    },
    top_affiliates: (topRows ?? []).map(a => ({
      id: a.id,
      username: (a.users as unknown as { username: string })?.username ?? 'Unknown',
      total_earnings: a.total_earnings,
      withdrawal_balance: a.withdrawal_balance,
      commission_type: a.commission_type,
      commission_rate: a.commission_rate,
    })),
  });
});

// GET /admin/affiliates
router.get('/affiliates', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const status = req.query.status as string;

  let query = supabase.from('affiliates')
    .select('*, users(username, email, country)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('approval_status', status);

  const { data, count } = await query;
  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// GET /admin/affiliates/:id
router.get('/affiliates/:id', async (req, res) => {
  const { id } = req.params;

  const { data: aff } = await supabase.from('affiliates')
    .select('*, users(id, username, email, phone, referral_code)')
    .eq('id', id).single();

  if (!aff) return sendError(res, 'Affiliate not found', 404);

  const { data: referrals } = await supabase.from('affiliate_referrals')
    .select('referred_user_id, deposit_total, betting_volume, commission_earned')
    .eq('affiliate_id', id);

  const referredUserIds = (referrals ?? []).map(r => r.referred_user_id);
  const totalReferred = referredUserIds.length;
  const depositedUsers = (referrals ?? []).filter(r => r.deposit_total > 0).length;
  const totalDeposits = (referrals ?? []).reduce((s, r) => s + r.deposit_total, 0);
  const totalBetVolume = (referrals ?? []).reduce((s, r) => s + r.betting_volume, 0);

  const [{ count: totalClicks }, { count: convertedClicks }] = await Promise.all([
    supabase.from('affiliate_clicks').select('id', { count: 'exact' }).eq('affiliate_id', id),
    supabase.from('affiliate_clicks').select('id', { count: 'exact' }).eq('affiliate_id', id).eq('converted', true),
  ]);

  let totalBetsPlaced = 0;
  let revenueGenerated = 0;
  let totalWithdrawals = 0;
  let activeUsers30d = 0;

  if (referredUserIds.length > 0) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
    const [betsRes, withdrawalsRes, activeBetsRes] = await Promise.all([
      supabase.from('bets').select('stake, payout, status').in('user_id', referredUserIds),
      supabase.from('withdrawal_requests').select('amount').eq('status', 'approved').in('user_id', referredUserIds),
      supabase.from('bets').select('user_id').in('user_id', referredUserIds).gte('placed_at', thirtyDaysAgo),
    ]);

    const bets = betsRes.data ?? [];
    totalBetsPlaced = bets.length;
    const totalStake = bets.reduce((s: number, b: Record<string, unknown>) => s + (b.stake as number), 0);
    const totalWon = bets.filter((b: Record<string, unknown>) => b.status === 'won').reduce((s: number, b: Record<string, unknown>) => s + (b.payout as number), 0);
    revenueGenerated = totalStake - totalWon;
    totalWithdrawals = (withdrawalsRes.data ?? []).reduce((s: number, w: Record<string, unknown>) => s + (w.amount as number), 0);
    activeUsers30d = new Set((activeBetsRes.data ?? []).map((b: Record<string, unknown>) => b.user_id as string)).size;
  }

  const user = aff.users as unknown as { id: string; username: string; email?: string; phone?: string; referral_code: string };
  const baseUrl = ((process.env.FRONTEND_URL ?? 'https://xfamebet.com') as string).split(',')[0].trim();
  const totalPaidOut = (aff.total_earnings ?? 0) - (aff.withdrawal_balance ?? 0);
  const avgDepositPerUser = depositedUsers > 0 ? totalDeposits / depositedUsers : 0;

  return sendSuccess(res, {
    ...aff,
    users: { id: user.id, username: user.username, email: user.email, phone: user.phone },
    total_paid_out: parseFloat(totalPaidOut.toFixed(2)),
    referral_code: user.referral_code,
    referral_link: `${baseUrl}/register?ref=${user.referral_code}`,
    metrics: {
      total_referred: totalReferred,
      deposited_users: depositedUsers,
      active_users_30d: activeUsers30d,
      conversion_rate: totalReferred > 0 ? parseFloat(((depositedUsers / totalReferred) * 100).toFixed(1)) : 0,
      avg_deposit_per_user: parseFloat(avgDepositPerUser.toFixed(2)),
      total_deposits: parseFloat(totalDeposits.toFixed(2)),
      total_bet_volume: parseFloat(totalBetVolume.toFixed(2)),
      total_withdrawals: parseFloat(totalWithdrawals.toFixed(2)),
      total_bets_placed: totalBetsPlaced,
      revenue_generated: parseFloat(revenueGenerated.toFixed(2)),
      clicks: totalClicks ?? 0,
      click_to_reg_rate: (totalClicks ?? 0) > 0
        ? parseFloat(((totalReferred / (totalClicks ?? 1)) * 100).toFixed(1))
        : 0,
    },
  });
});

// GET /admin/affiliates/:id/users
router.get('/affiliates/:id/users', async (req, res) => {
  const { id } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const search = (req.query.search as string) ?? '';
  const sortBy = (req.query.sort_by as string) || 'total_deposits';
  const sortDir = (req.query.sort_dir as string) || 'desc';

  const { data: referrals } = await supabase.from('affiliate_referrals')
    .select('referred_user_id, deposit_total, betting_volume, commission_earned')
    .eq('affiliate_id', id);

  if (!referrals || referrals.length === 0) return sendPaginated(res, [], 0, page, limit);

  const referralMap = Object.fromEntries(referrals.map(r => [r.referred_user_id, r]));
  const userIds = referrals.map(r => r.referred_user_id);

  let userQuery = supabase.from('users')
    .select('id, username, email, phone, created_at, kyc_status, last_login_at')
    .in('id', userIds);

  if (search) userQuery = userQuery.or(`username.ilike.%${search}%,phone.ilike.%${search}%`);

  const { data: users } = await userQuery;
  if (!users || users.length === 0) return sendPaginated(res, [], 0, page, limit);

  const filteredIds = users.map(u => u.id);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString();

  const [walletsRes, betsRes, firstDepositsRes, withdrawalsRes] = await Promise.all([
    supabase.from('wallets').select('user_id, balance').in('user_id', filteredIds),
    supabase.from('bets').select('user_id, stake, placed_at').in('user_id', filteredIds),
    supabase.from('deposit_requests').select('user_id, created_at').eq('status', 'approved').in('user_id', filteredIds).order('created_at', { ascending: true }),
    supabase.from('withdrawal_requests').select('user_id, amount').eq('status', 'approved').in('user_id', filteredIds),
  ]);

  const walletMap: Record<string, number> = {};
  for (const w of walletsRes.data ?? []) walletMap[(w as Record<string, unknown>).user_id as string] = (w as Record<string, unknown>).balance as number;

  const betsByUser: Record<string, { count: number; lastAt?: string }> = {};
  for (const b of betsRes.data ?? []) {
    const bet = b as Record<string, unknown>;
    const uid = bet.user_id as string;
    if (!betsByUser[uid]) betsByUser[uid] = { count: 0 };
    betsByUser[uid].count++;
    if (!betsByUser[uid].lastAt || (bet.placed_at as string) > betsByUser[uid].lastAt!) {
      betsByUser[uid].lastAt = bet.placed_at as string;
    }
  }

  const firstDepositMap: Record<string, string> = {};
  for (const d of firstDepositsRes.data ?? []) {
    const dep = d as Record<string, unknown>;
    const uid = dep.user_id as string;
    if (!firstDepositMap[uid]) firstDepositMap[uid] = dep.created_at as string;
  }

  const withdrawalMap: Record<string, number> = {};
  for (const w of withdrawalsRes.data ?? []) {
    const wd = w as Record<string, unknown>;
    const uid = wd.user_id as string;
    withdrawalMap[uid] = (withdrawalMap[uid] ?? 0) + (wd.amount as number);
  }

  const rows = users.map(u => {
    const ref = referralMap[u.id];
    const bets = betsByUser[u.id] ?? { count: 0 };
    const lastBet = bets.lastAt;
    const lastActive = lastBet && (!u.last_login_at || lastBet > u.last_login_at) ? lastBet : u.last_login_at;
    const isActive = lastBet ? new Date(lastBet) > new Date(thirtyDaysAgo) : false;
    return {
      id: u.id, username: u.username, email: u.email, phone: u.phone,
      created_at: u.created_at, first_deposit_at: firstDepositMap[u.id] ?? null,
      total_deposits: ref?.deposit_total ?? 0,
      total_withdrawals: withdrawalMap[u.id] ?? 0,
      total_bets: bets.count,
      total_bet_volume: ref?.betting_volume ?? 0,
      wallet_balance: walletMap[u.id] ?? 0,
      kyc_status: u.kyc_status, is_active: isActive,
      last_active: lastActive ?? null,
      commission_earned: ref?.commission_earned ?? 0,
    };
  });

  rows.sort((a, b) => {
    let av = 0, bv = 0;
    if (sortBy === 'total_deposits') { av = a.total_deposits; bv = b.total_deposits; }
    else if (sortBy === 'total_bets') { av = a.total_bets; bv = b.total_bets; }
    else { av = new Date(a.created_at).getTime(); bv = new Date(b.created_at).getTime(); }
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  return sendPaginated(res, rows.slice(offset, offset + limit), rows.length, page, limit);
});

// GET /admin/affiliates/:id/earnings
router.get('/affiliates/:id/earnings', async (req, res) => {
  const { id } = req.params;

  const { data: logs } = await supabase.from('affiliate_commission_logs')
    .select('created_at, commission_amount')
    .eq('affiliate_id', id)
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

// POST /admin/affiliates/:id/payout
router.post('/affiliates/:id/payout', validateBody(z.object({
  amount: z.number().positive(),
  notes: z.string().optional(),
})), async (req, res) => {
  const { id } = req.params;
  const { amount, notes } = req.body;

  const { data: aff } = await supabase.from('affiliates')
    .select('withdrawal_balance').eq('id', id).single();

  if (!aff) return sendError(res, 'Affiliate not found', 404);
  if (aff.withdrawal_balance < amount) return sendError(res, 'Amount exceeds balance owed', 400);

  await supabase.from('affiliates')
    .update({ withdrawal_balance: aff.withdrawal_balance - amount })
    .eq('id', id);

  await AdminLogService.log(req.user!.id, 'payout_affiliate', 'affiliates', id, { amount, notes });

  return sendSuccess(res, { message: 'Payout recorded' });
});

// POST /admin/affiliates/:id/approve
router.post('/affiliates/:id/approve', async (req, res) => {
  const { id } = req.params;
  await supabase.from('affiliates').update({ approval_status: 'approved' }).eq('id', id);
  const { data: aff } = await supabase.from('affiliates').select('user_id').eq('id', id).single();
  if (aff) {
    await supabase.from('users').update({ role: 'affiliate' }).eq('id', aff.user_id);
  }
  await AdminLogService.log(req.user!.id, 'approve_affiliate', 'affiliates', id, {});
  return sendSuccess(res, { message: 'Affiliate approved' });
});

// POST /admin/affiliates/:id/adjust-commission
router.post('/affiliates/:id/adjust-commission', validateBody(z.object({
  commission_type: z.enum(['cpa', 'revenue_share', 'hybrid']).optional(),
  commission_rate: z.number().min(0).max(1).optional(),
  cpa_amount: z.number().min(0).optional(),
})), async (req, res) => {
  const { id } = req.params;
  await supabase.from('affiliates').update(req.body).eq('id', id);
  await AdminLogService.log(req.user!.id, 'adjust_affiliate_commission', 'affiliates', id, req.body);
  return sendSuccess(res, { message: 'Commission updated' });
});

// POST /admin/affiliates/:id/block
router.post('/affiliates/:id/block', async (req, res) => {
  await supabase.from('affiliates').update({ approval_status: 'blocked' }).eq('id', req.params.id);
  await AdminLogService.log(req.user!.id, 'block_affiliate', 'affiliates', req.params.id, {});
  return sendSuccess(res, { message: 'Affiliate blocked' });
});

// ==================== PROMOTIONS ====================

// GET /admin/promotions
router.get('/promotions', async (_req, res) => {
  const { data } = await supabase.from('bonus_promotions').select('*').order('created_at', { ascending: false });
  return sendSuccess(res, data ?? []);
});

// POST /admin/promotions
router.post('/promotions', validateBody(z.object({
  name: z.string(), type: z.string(), description: z.string().optional(),
  value: z.number(), value_type: z.enum(['fixed', 'percentage']),
  min_deposit: z.number().optional(), wagering_requirement: z.number().optional(),
  max_win: z.number().optional(), starts_at: z.string().optional(), expires_at: z.string().optional(),
})), async (req, res) => {
  const { data } = await supabase.from('bonus_promotions').insert({ ...req.body, status: 'active' }).select().single();
  await AdminLogService.log(req.user!.id, 'create_promotion', 'bonus_promotions', data?.id ?? '', req.body);
  return sendSuccess(res, data, 201);
});

// GET /admin/promo-codes
router.get('/promo-codes', async (_req, res) => {
  const { data } = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
  return sendSuccess(res, data ?? []);
});

// POST /admin/promo-codes
router.post('/promo-codes', validateBody(z.object({
  code: z.string().min(3).max(20),
  promotion_type: z.string(), value: z.number(),
  value_type: z.enum(['fixed', 'percentage']).default('fixed'),
  usage_limit: z.number().optional(), expires_at: z.string().optional(),
})), async (req, res) => {
  const { data } = await supabase.from('promo_codes').insert({ ...req.body, status: 'active' }).select().single();
  return sendSuccess(res, data, 201);
});

// DELETE /admin/promo-codes/:id
router.delete('/promo-codes/:id', async (req, res) => {
  await supabase.from('promo_codes').update({ status: 'inactive' }).eq('id', req.params.id);
  return sendSuccess(res, { message: 'Promo code disabled' });
});

// GET /admin/logs
router.get('/logs', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const { data, count } = await supabase.from('admin_logs')
    .select('*, users!admin_logs_admin_id_fkey(username)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

export default router;
