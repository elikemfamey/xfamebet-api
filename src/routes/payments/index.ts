import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import multer from 'multer';
import { supabase } from '../../config/supabase';
import { WalletService } from '../../services/walletService';
import { NotificationService } from '../../services/notificationService';
import { authenticate, requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated, asyncHandler } from '../../utils/response';
import { paymentLimiter } from '../../middleware/rateLimiter';
import { env } from '../../config/env';
import { AdminLogService } from '../../services/adminLogService';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG and WebP images are allowed'));
  },
});

const router = Router();

const paystackInitSchema = z.object({
  amount: z.number().min(10).max(100000),
  callback_url: z.string().url().optional(),
});

const manualMomoSchema = z.object({
  amount: z.number().min(5),
  provider: z.enum(['momo_mtn', 'momo_telecel', 'momo_airteltigo']),
  phone_number: z.string().optional(),
  sender_name: z.string().min(1),
  transaction_id: z.string().optional(),
  screenshot_url: z.string().optional(),
});

const payoutSettingsSchema = z.object({
  method_type: z.enum(['momo_mtn', 'momo_telecel', 'momo_airteltigo', 'ng_bank_transfer']),
  account_name: z.string().min(1),
  account_number: z.string().min(1),
  bank_name: z.string().optional(),
  is_default: z.boolean().optional().default(true),
});

const ngBankSchema = z.object({
  amount: z.number().min(100),
  bank_name: z.string(),
  account_name: z.string(),
  reference: z.string(),
  screenshot_url: z.string().optional(),
});

const usdtSchema = z.object({
  amount_usd: z.number().min(1),
  amount_ngn: z.number().optional(),
  tx_hash: z.string().min(10),
});

const withdrawSchema = z.object({
  amount: z.number().positive(),
  payment_provider: z.enum(['momo_mtn', 'momo_telecel', 'momo_airteltigo', 'ng_bank_transfer', 'usdt_trc20']),
  account_details: z.record(z.string()),
});

const approveRejectSchema = z.object({
  notes: z.string().optional(),
});

// POST /payments/paystack/initialize
router.post('/paystack/initialize', authenticate, paymentLimiter, validateBody(paystackInitSchema), asyncHandler(async (req, res) => {
  const { amount, callback_url } = req.body;
  const { data: user } = await supabase.from('users').select('email').eq('id', req.user!.id).single();
  if (!user) return sendError(res, 'User not found', 404);

  const reference = `PSK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      amount: amount * 100,
      reference,
      callback_url: callback_url ?? `${env.FRONTEND_URL}/wallet?deposit=success`,
      metadata: { user_id: req.user!.id },
    }),
  });

  const data = await response.json() as { status: boolean; data: { authorization_url: string; reference: string } };

  if (!data.status) return sendError(res, 'Paystack initialization failed', 500);

  await supabase.from('deposit_requests').insert({
    user_id: req.user!.id,
    amount,
    currency: 'GHS',
    payment_provider: 'paystack',
    reference: data.data.reference,
    status: 'pending',
  });

  return sendSuccess(res, {
    authorization_url: data.data.authorization_url,
    reference: data.data.reference,
  });
}));

// POST /payments/paystack/webhook
router.post('/paystack/webhook', asyncHandler(async (req, res) => {
  const signature = req.headers['x-paystack-signature'] as string;
  const payload = JSON.stringify(req.body);

  const hash = crypto.createHmac('sha512', env.PAYSTACK_WEBHOOK_SECRET).update(payload).digest('hex');
  if (hash !== signature) return res.status(400).json({ error: 'Invalid signature' });

  const event = req.body;

  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    const { data: deposit } = await supabase
      .from('deposit_requests').select('*').eq('reference', reference).single();

    if (deposit && deposit.status === 'pending') {
      await supabase.from('deposit_requests').update({ status: 'completed' }).eq('id', deposit.id);
      await WalletService.credit(
        deposit.user_id, deposit.amount, 'deposit', 'paystack', reference, 'Paystack deposit'
      );
      await NotificationService.send(deposit.user_id, 'deposit_approved',
        'Deposit Approved', `Your deposit of GHS ${deposit.amount} has been credited.`);
    }
  }

  return res.status(200).json({ received: true });
}));

// POST /payments/manual-momo/deposit
router.post('/manual-momo/deposit', authenticate, paymentLimiter, validateBody(manualMomoSchema), asyncHandler(async (req, res) => {
  const { amount, provider, phone_number, sender_name, transaction_id, screenshot_url } = req.body;

  await supabase.from('deposit_requests').insert({
    user_id: req.user!.id,
    amount,
    currency: 'GHS',
    payment_provider: provider,
    transaction_id: transaction_id || null,
    screenshot_url: screenshot_url || null,
    account_number: phone_number || null,
    account_name: sender_name,
    status: 'pending',
  });

  return sendSuccess(res, { message: 'Deposit request submitted. Awaiting admin approval.' }, 201);
}));

// POST /payments/ng-bank/deposit
router.post('/ng-bank/deposit', authenticate, paymentLimiter, validateBody(ngBankSchema), asyncHandler(async (req, res) => {
  const { amount, bank_name, account_name, reference, screenshot_url } = req.body;

  await supabase.from('deposit_requests').insert({
    user_id: req.user!.id,
    amount,
    currency: 'NGN',
    payment_provider: 'ng_bank_transfer',
    reference,
    screenshot_url,
    bank_name,
    account_name,
    status: 'pending',
  });

  return sendSuccess(res, { message: 'Bank transfer request submitted. Awaiting admin approval.' }, 201);
}));

// POST /payments/usdt-trc20/deposit
router.post('/usdt-trc20/deposit', authenticate, paymentLimiter, validateBody(usdtSchema), asyncHandler(async (req, res) => {
  const { amount_usd, tx_hash } = req.body;

  await supabase.from('deposit_requests').insert({
    user_id: req.user!.id,
    amount: amount_usd,
    currency: 'USDT',
    payment_provider: 'usdt_trc20',
    tx_hash,
    status: 'pending',
  });

  return sendSuccess(res, {
    message: 'Crypto deposit submitted. Awaiting blockchain verification.',
    wallet_address: env.CRYPTO_WALLET_ADDRESS,
  }, 201);
}));

// GET /payments/crypto-address
router.get('/crypto-address', authenticate, asyncHandler(async (_req, res) => {
  return sendSuccess(res, { address: env.CRYPTO_WALLET_ADDRESS, network: 'TRC20', binance_uid: env.BINANCE_UID || null, binance_name: env.BINANCE_NAME || null });
}));

// GET /payments/payment-info — company collection details for deposit page
router.get('/payment-info', authenticate, asyncHandler(async (_req, res) => {
  return sendSuccess(res, {
    momo: {
      network: env.COMPANY_MOMO_NETWORK,
      name: env.COMPANY_MOMO_NAME,
      number: env.COMPANY_MOMO_NUMBER,
    },
    bank: {
      bank_name: env.COMPANY_BANK_NAME || null,
      account_name: env.COMPANY_BANK_ACCOUNT_NAME || null,
      account_number: env.COMPANY_BANK_ACCOUNT_NUMBER || null,
      currency: env.COMPANY_BANK_CURRENCY,
    },
    crypto: {
      usdt_trc20: env.CRYPTO_WALLET_ADDRESS,
      binance_uid: env.BINANCE_UID || null,
      binance_name: env.BINANCE_NAME || null,
    },
    minimums: { crypto_usd: 30, momo_ghs: 300, bank_ngn: 5000 },
    quick_picks: {
      crypto_usd: [30, 50, 100, 200, 500],
      momo_ghs: [300, 500, 1000, 1500, 2000],
      bank_ngn: [5000, 10000, 20000, 50000, 100000],
    },
  });
}));

// POST /payments/upload-screenshot
router.post('/upload-screenshot', authenticate, upload.single('screenshot') as unknown as RequestHandler, asyncHandler(async (req, res) => {
  if (!req.file) return sendError(res, 'No file provided', 400);
  const ext = req.file.originalname.split('.').pop() ?? 'jpg';
  const path = `deposit-screenshots/${req.user!.id}/${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage
    .from('screenshots')
    .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (error) return sendError(res, 'Upload failed: ' + error.message, 500);

  const { data: { publicUrl } } = supabase.storage.from('screenshots').getPublicUrl(data.path);
  return sendSuccess(res, { url: publicUrl });
}));

// GET /payments/payout-settings
router.get('/payout-settings', authenticate, asyncHandler(async (req, res) => {
  const { data } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('user_id', req.user!.id)
    .eq('status', 'active')
    .order('is_default', { ascending: false });
  return sendSuccess(res, data ?? []);
}));

// POST /payments/payout-settings
router.post('/payout-settings', authenticate, validateBody(payoutSettingsSchema), asyncHandler(async (req, res) => {
  const { method_type, account_name, account_number, bank_name, is_default } = req.body;

  if (is_default) {
    await supabase
      .from('payment_methods')
      .update({ is_default: false })
      .eq('user_id', req.user!.id);
  }

  const { data: existing } = await supabase
    .from('payment_methods')
    .select('id')
    .eq('user_id', req.user!.id)
    .eq('method_type', method_type)
    .single();

  if (existing) {
    await supabase.from('payment_methods').update({
      account_name, account_number, bank_name: bank_name || null, is_default: is_default ?? true,
    }).eq('id', existing.id);
  } else {
    await supabase.from('payment_methods').insert({
      user_id: req.user!.id,
      method_type,
      account_name,
      account_number,
      bank_name: bank_name || null,
      is_default: is_default ?? true,
      status: 'active',
    });
  }

  return sendSuccess(res, { message: 'Payout settings saved' });
}));

// DELETE /payments/payout-settings/:id
router.delete('/payout-settings/:id', authenticate, asyncHandler(async (req, res) => {
  await supabase
    .from('payment_methods')
    .update({ status: 'inactive' })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id);
  return sendSuccess(res, { message: 'Payout method removed' });
}));

// POST /payments/withdraw
router.post('/withdraw', authenticate, paymentLimiter, validateBody(withdrawSchema), asyncHandler(async (req, res) => {
  const { amount, payment_provider, account_details } = req.body;

  const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', req.user!.id).single();
  if (!wallet) return sendError(res, 'Wallet not found', 404);
  if (wallet.frozen || wallet.withdrawal_frozen) return sendError(res, 'Withdrawals are frozen on your account', 403);
  if (wallet.balance < amount) return sendError(res, 'Insufficient balance', 400);

  // Check responsible gambling limits
  const { data: limit } = await supabase
    .from('responsible_gambling_limits')
    .select('*')
    .eq('user_id', req.user!.id)
    .eq('limit_type', 'withdrawal')
    .single();

  if (limit?.self_excluded) return sendError(res, 'Self-exclusion is active', 403);

  await supabase.from('withdrawal_requests').insert({
    user_id: req.user!.id,
    amount,
    currency: wallet.currency,
    payment_provider,
    account_details,
    status: 'pending',
  });

  // Freeze amount (debit pending)
  await WalletService.debit(req.user!.id, amount, 'withdrawal', 'Withdrawal request pending approval');

  return sendSuccess(res, { message: 'Withdrawal request submitted. Awaiting admin approval.' }, 201);
}));

// GET /payments/deposits (user's own deposits)
router.get('/deposits', authenticate, asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data, count } = await supabase
    .from('deposit_requests')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user!.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
}));

// GET /payments/withdrawals (user's own)
router.get('/withdrawals', authenticate, asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data, count } = await supabase
    .from('withdrawal_requests')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user!.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
}));

// ==================== ADMIN PAYMENT ENDPOINTS ====================

// GET /payments/admin/deposits
router.get('/admin/deposits', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;
  const provider = req.query.provider as string;
  const offset = (page - 1) * limit;

  // Try relational join first; if FK isn't declared in schema cache, fall back to manual enrichment
  let query = supabase
    .from('deposit_requests')
    .select('*, users(username, email, phone)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (provider) query = query.eq('payment_provider', provider);

  let { data, count, error } = await query;

  if (error) {
    // FK join not available — fetch deposits and enrich user data manually
    let fallback = supabase
      .from('deposit_requests')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) fallback = fallback.eq('status', status);
    if (provider) fallback = fallback.eq('payment_provider', provider);
    const { data: fbData, count: fbCount } = await fallback;

    if (fbData && fbData.length > 0) {
      const userIds = [...new Set(fbData.map((d: Record<string, unknown>) => d.user_id as string))];
      const { data: users } = await supabase
        .from('users').select('id, username, email, phone').in('id', userIds);
      const userMap = Object.fromEntries((users ?? []).map((u: Record<string, unknown>) => [u.id, u]));
      data = fbData.map((d: Record<string, unknown>) => ({ ...d, users: userMap[d.user_id as string] ?? null }));
    } else {
      data = fbData ?? [];
    }
    count = fbCount;
  }

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
}));

// POST /payments/admin/deposits/:id/approve
router.post('/admin/deposits/:id/approve', authenticate, requireAdmin, validateBody(approveRejectSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  const { data: deposit, error } = await supabase
    .from('deposit_requests').select('*').eq('id', id).single();
  if (error || !deposit) return sendError(res, 'Deposit not found', 404);
  if (deposit.status !== 'pending') return sendError(res, 'Deposit already processed', 400);

  await supabase.from('deposit_requests').update({
    status: 'approved', reviewed_by: req.user!.id,
    reviewed_at: new Date().toISOString(), notes,
  }).eq('id', id);

  await WalletService.credit(deposit.user_id, deposit.amount, 'deposit', deposit.payment_provider, undefined, `${deposit.payment_provider} deposit approved`);
  await NotificationService.send(deposit.user_id, 'deposit_approved', 'Deposit Approved', `Your deposit of ${deposit.currency} ${deposit.amount} has been approved and credited.`);

  await AdminLogService.log(req.user!.id, 'approve_deposit', 'deposit_request', id, { amount: deposit.amount, provider: deposit.payment_provider });
  await supabase.from('payment_audit_logs').insert({ entity_type: 'deposit_request', entity_id: id, action: 'approve', admin_id: req.user!.id, previous_status: 'pending', new_status: 'approved', amount: deposit.amount, notes });

  return sendSuccess(res, { message: 'Deposit approved and wallet credited' });
}));

// POST /payments/admin/deposits/:id/reject
router.post('/admin/deposits/:id/reject', authenticate, requireAdmin, validateBody(approveRejectSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  const { data: deposit } = await supabase.from('deposit_requests').select('*').eq('id', id).single();
  if (!deposit) return sendError(res, 'Deposit not found', 404);
  if (deposit.status !== 'pending') return sendError(res, 'Deposit already processed', 400);

  await supabase.from('deposit_requests').update({ status: 'rejected', reviewed_by: req.user!.id, reviewed_at: new Date().toISOString(), notes }).eq('id', id);
  await NotificationService.send(deposit.user_id, 'system', 'Deposit Rejected', `Your deposit of ${deposit.currency} ${deposit.amount} was rejected. ${notes ?? ''}`);
  await AdminLogService.log(req.user!.id, 'reject_deposit', 'deposit_request', id, { notes });

  return sendSuccess(res, { message: 'Deposit rejected' });
}));

// GET /payments/admin/withdrawals
router.get('/admin/withdrawals', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('withdrawal_requests')
    .select('*, users(username, email, phone)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  let { data, count, error } = await query;

  if (error) {
    let fallback = supabase
      .from('withdrawal_requests')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) fallback = fallback.eq('status', status);
    const { data: fbData, count: fbCount } = await fallback;

    if (fbData && fbData.length > 0) {
      const userIds = [...new Set(fbData.map((d: Record<string, unknown>) => d.user_id as string))];
      const { data: users } = await supabase
        .from('users').select('id, username, email, phone').in('id', userIds);
      const userMap = Object.fromEntries((users ?? []).map((u: Record<string, unknown>) => [u.id, u]));
      data = fbData.map((d: Record<string, unknown>) => ({ ...d, users: userMap[d.user_id as string] ?? null }));
    } else {
      data = fbData ?? [];
    }
    count = fbCount;
  }

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
}));

// POST /payments/admin/withdrawals/:id/approve
router.post('/admin/withdrawals/:id/approve', authenticate, requireAdmin, validateBody(z.object({ payout_reference: z.string().optional(), notes: z.string().optional() })), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { payout_reference, notes } = req.body;

  const { data: withdrawal } = await supabase.from('withdrawal_requests').select('*').eq('id', id).single();
  if (!withdrawal) return sendError(res, 'Withdrawal not found', 404);
  if (withdrawal.status !== 'pending') return sendError(res, 'Already processed', 400);

  await supabase.from('withdrawal_requests').update({ status: 'approved', reviewed_by: req.user!.id, reviewed_at: new Date().toISOString(), payout_reference, notes }).eq('id', id);
  await NotificationService.send(withdrawal.user_id, 'withdrawal_approved', 'Withdrawal Approved', `Your withdrawal of ${withdrawal.currency} ${withdrawal.amount} has been approved.`);
  await AdminLogService.log(req.user!.id, 'approve_withdrawal', 'withdrawal_request', id, { amount: withdrawal.amount, payout_reference });

  return sendSuccess(res, { message: 'Withdrawal approved' });
}));

// POST /payments/admin/withdrawals/:id/reject
router.post('/admin/withdrawals/:id/reject', authenticate, requireAdmin, validateBody(approveRejectSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  const { data: withdrawal } = await supabase.from('withdrawal_requests').select('*').eq('id', id).single();
  if (!withdrawal) return sendError(res, 'Withdrawal not found', 404);
  if (withdrawal.status !== 'pending') return sendError(res, 'Already processed', 400);

  await supabase.from('withdrawal_requests').update({ status: 'rejected', reviewed_by: req.user!.id, reviewed_at: new Date().toISOString(), notes }).eq('id', id);

  // Refund the deducted amount
  await WalletService.credit(withdrawal.user_id, withdrawal.amount, 'refund', undefined, undefined, 'Withdrawal rejected - funds returned');
  await NotificationService.send(withdrawal.user_id, 'withdrawal_rejected', 'Withdrawal Rejected', `Your withdrawal was rejected. ${notes ?? ''} Funds returned to wallet.`);
  await AdminLogService.log(req.user!.id, 'reject_withdrawal', 'withdrawal_request', id, { notes });

  return sendSuccess(res, { message: 'Withdrawal rejected and funds returned' });
}));

export default router;
