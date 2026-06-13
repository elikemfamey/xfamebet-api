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
import { AffiliateService } from '../../services/affiliateService';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG and WebP images are allowed'));
  },
});

const router = Router();

// ---------------------------------------------------------------------------
// Currency-locking helpers
// ---------------------------------------------------------------------------

/** Return the correct wallet currency for a given country + deposit provider. */
function determineCurrency(country: string, provider: string): string {
  if (country === 'NG' && provider === 'ng_bank_transfer') return 'NGN';
  if (country === 'GH' && ['momo_mtn', 'momo_telecel', 'momo_airteltigo'].includes(provider)) return 'GHS';
  return 'USD';
}

/**
 * If the wallet currency has not been locked yet, set it based on the first
 * deposit's country + provider and lock it permanently.
 */
async function maybeLockWalletCurrency(userId: string, country: string, provider: string): Promise<void> {
  const { data: wallet } = await supabase
    .from('wallets').select('id, currency_locked').eq('user_id', userId).single();
  if (!wallet || wallet.currency_locked) return;
  const currency = determineCurrency(country, provider);
  await supabase.from('wallets')
    .update({ currency, currency_locked: true })
    .eq('id', wallet.id);
}

/** Minimum amount per individual withdrawal request. */
const WITHDRAWAL_MIN_AMOUNT: Record<string, number> = { NGN: 5000, GHS: 50, USD: 10 };

// ---------------------------------------------------------------------------

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
  amount: z.number().min(30000),
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

// Extended schema for deposit approval — allows admin to specify the local-currency
// equivalent when approving a USDT deposit for an NGN or GHS wallet.
const approveDepositSchema = z.object({
  notes: z.string().optional(),
  credited_amount: z.number().positive().optional(),
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
      AffiliateService.creditCpaCommission(deposit.user_id, deposit.amount, deposit.currency).catch(() => {});
    }
  }

  return res.status(200).json({ received: true });
}));

// POST /payments/manual-momo/deposit
router.post('/manual-momo/deposit', authenticate, paymentLimiter, validateBody(manualMomoSchema), asyncHandler(async (req, res) => {
  const { amount, provider, phone_number, sender_name, transaction_id, screenshot_url } = req.body;

  const { data: userRecord } = await supabase.from('users').select('country').eq('id', req.user!.id).single();

  // Lock wallet on first deposit. For a user whose wallet is already locked to a
  // different currency (e.g. NGN), the deposit is still accepted; the admin enters
  // the credited_amount (wallet-currency equivalent) at approval time.
  await maybeLockWalletCurrency(req.user!.id, userRecord?.country ?? '', provider);

  // Store what target currency this deposit should be credited in so the admin sees it
  const { data: walletRow } = await supabase.from('wallets').select('currency').eq('user_id', req.user!.id).single();
  const walletCurrency = walletRow?.currency ?? 'GHS';

  const { error } = await supabase.from('deposit_requests').insert({
    user_id: req.user!.id,
    amount,
    currency: 'GHS',
    payment_provider: provider,
    transaction_id: transaction_id || null,
    screenshot_url: screenshot_url || null,
    account_number: phone_number || null,
    account_name: sender_name,
    status: 'pending',
    metadata: { wallet_currency: walletCurrency },
  });
  if (error) return sendError(res, 'Failed to record deposit request', 500);

  return sendSuccess(res, { message: 'Deposit request submitted. Awaiting admin approval.' }, 201);
}));

// POST /payments/ng-bank/deposit
router.post('/ng-bank/deposit', authenticate, paymentLimiter, validateBody(ngBankSchema), asyncHandler(async (req, res) => {
  const { amount, bank_name, account_name, reference, screenshot_url } = req.body;

  const { data: userRecord } = await supabase.from('users').select('country').eq('id', req.user!.id).single();

  // Lock wallet on first deposit. If the wallet is already locked to a different
  // currency, the deposit is still accepted; admin enters credited_amount at approval.
  await maybeLockWalletCurrency(req.user!.id, userRecord?.country ?? '', 'ng_bank_transfer');

  // Store target wallet currency so the admin sees what conversion is needed
  const { data: walletRow } = await supabase.from('wallets').select('currency').eq('user_id', req.user!.id).single();
  const walletCurrency = walletRow?.currency ?? 'NGN';

  const { error } = await supabase.from('deposit_requests').insert({
    user_id: req.user!.id,
    amount,
    currency: 'NGN',
    payment_provider: 'ng_bank_transfer',
    reference,
    screenshot_url,
    bank_name,
    account_name,
    status: 'pending',
    metadata: { wallet_currency: walletCurrency },
  });
  if (error) return sendError(res, 'Failed to record deposit request', 500);

  return sendSuccess(res, { message: 'Bank transfer request submitted. Awaiting admin approval.' }, 201);
}));

// POST /payments/usdt-trc20/deposit
router.post('/usdt-trc20/deposit', authenticate, paymentLimiter, validateBody(usdtSchema), asyncHandler(async (req, res) => {
  const { amount_usd, tx_hash } = req.body;

  // Lock wallet to USD if this is the first deposit (crypto always → USD)
  const { data: userRecord } = await supabase.from('users').select('country').eq('id', req.user!.id).single();
  await maybeLockWalletCurrency(req.user!.id, userRecord?.country ?? '', 'usdt_trc20');

  // Fetch the now-current wallet currency so we can store the right target currency
  const { data: walletRow } = await supabase.from('wallets').select('currency').eq('user_id', req.user!.id).single();
  const walletCurrency = walletRow?.currency ?? 'USD';

  const { error } = await supabase.from('deposit_requests').insert({
    user_id: req.user!.id,
    amount: amount_usd,
    currency: 'USDT',
    payment_provider: 'usdt_trc20',
    tx_hash,
    status: 'pending',
    metadata: { wallet_currency: walletCurrency },
  });
  if (error) return sendError(res, 'Failed to record deposit request', 500);

  return sendSuccess(res, {
    message: 'Crypto deposit submitted. Awaiting blockchain verification.',
    wallet_address: env.CRYPTO_WALLET_ADDRESS,
    wallet_currency: walletCurrency,
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
    minimums: { crypto_usd: 30, momo_ghs: 300, bank_ngn: 30000 },
    quick_picks: {
      crypto_usd: [30, 50, 100, 200, 500],
      momo_ghs: [300, 500, 1000, 1500, 2000],
      bank_ngn: [30000, 50000, 100000, 200000, 500000],
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

  const minWithdraw = WITHDRAWAL_MIN_AMOUNT[wallet.currency] ?? 10;
  if (amount < minWithdraw) return sendError(res, `Minimum withdrawal is ${wallet.currency} ${minWithdraw}`, 400);
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
router.post('/admin/deposits/:id/approve', authenticate, requireAdmin, validateBody(approveDepositSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes, credited_amount } = req.body;

  const { data: deposit, error } = await supabase
    .from('deposit_requests').select('*').eq('id', id).single();
  if (error || !deposit) return sendError(res, 'Deposit not found', 404);
  if (deposit.status !== 'pending') return sendError(res, 'Deposit already processed', 400);

  // For USDT deposits going into NGN or GHS wallets, the admin must supply
  // credited_amount (the local-currency equivalent). For USD wallets or direct
  // fiat deposits the original deposit.amount is used as-is.
  const { data: walletRow } = await supabase.from('wallets').select('currency').eq('user_id', deposit.user_id).single();
  const walletCurrency = walletRow?.currency ?? deposit.currency;
  const amountToCredit = credited_amount ?? deposit.amount;

  // If deposit currency differs from wallet currency a conversion is required.
  // The admin must supply credited_amount (the wallet-currency equivalent).
  const depositCurrencyMatchesWallet =
    deposit.currency === walletCurrency ||
    (deposit.currency === 'USDT' && walletCurrency === 'USD');
  if (!depositCurrencyMatchesWallet && !credited_amount) {
    return sendError(res, `Deposit is in ${deposit.currency} but wallet is ${walletCurrency}. Provide credited_amount (the ${walletCurrency} equivalent) to approve.`, 400);
  }

  await supabase.from('deposit_requests').update({
    status: 'approved', reviewed_by: req.user!.id,
    reviewed_at: new Date().toISOString(), notes,
  }).eq('id', id);

  await WalletService.credit(deposit.user_id, amountToCredit, 'deposit', deposit.payment_provider, undefined, `${deposit.payment_provider} deposit approved`);
  await NotificationService.send(deposit.user_id, 'deposit_approved', 'Deposit Approved', `Your deposit has been approved. ${walletCurrency} ${amountToCredit} has been credited to your account.`);
  AffiliateService.creditCpaCommission(deposit.user_id, amountToCredit, walletCurrency).catch(() => {});

  await AdminLogService.log(req.user!.id, 'approve_deposit', 'deposit_request', id, { amount: amountToCredit, credited_amount, provider: deposit.payment_provider });
  await supabase.from('payment_audit_logs').insert({ entity_type: 'deposit_request', entity_id: id, action: 'approve', admin_id: req.user!.id, previous_status: 'pending', new_status: 'approved', amount: amountToCredit, notes });

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

// POST /payments/admin/deposits/:id/reverse
// Reverses an already-approved deposit: debits the wallet, corrects affiliate commission totals,
// and marks the deposit as rejected. Use when a duplicate receipt was mistakenly approved.
router.post('/admin/deposits/:id/reverse', authenticate, requireAdmin, validateBody(approveRejectSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  const { data: deposit, error } = await supabase
    .from('deposit_requests').select('*').eq('id', id).single();
  if (error || !deposit) return sendError(res, 'Deposit not found', 404);
  if (deposit.status !== 'approved') return sendError(res, 'Only approved deposits can be reversed', 400);

  // Get the amount that was actually credited (stored in audit log at approval time)
  const { data: auditLog } = await supabase
    .from('payment_audit_logs')
    .select('amount')
    .eq('entity_id', id)
    .eq('action', 'approve')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const { data: walletRow } = await supabase
    .from('wallets').select('currency, balance').eq('user_id', deposit.user_id).single();
  const walletCurrency = walletRow?.currency ?? deposit.currency;
  const creditedAmount = auditLog?.amount ?? deposit.amount;

  if (!walletRow || walletRow.balance < creditedAmount) {
    return sendError(res, `Cannot reverse: user balance (${walletRow?.balance ?? 0} ${walletCurrency}) is less than the credited amount (${creditedAmount}). Funds may already be spent.`, 400);
  }

  await WalletService.debit(deposit.user_id, creditedAmount, 'adjustment', `Deposit reversed - duplicate receipt (${id})`);
  await AffiliateService.reverseDepositApproval(deposit.user_id, creditedAmount, walletCurrency).catch(() => {});

  await supabase.from('deposit_requests').update({
    status: 'rejected',
    reviewed_by: req.user!.id,
    reviewed_at: new Date().toISOString(),
    notes: notes ?? 'Reversed: duplicate receipt was mistakenly approved',
  }).eq('id', id);

  await NotificationService.send(deposit.user_id, 'system', 'Deposit Reversed', `A duplicate deposit of ${walletCurrency} ${creditedAmount} has been reversed from your account. Only one payment was accepted.`);
  await AdminLogService.log(req.user!.id, 'reverse_deposit', 'deposit_request', id, { amount: creditedAmount, walletCurrency, notes });
  await supabase.from('payment_audit_logs').insert({
    entity_type: 'deposit_request',
    entity_id: id,
    action: 'reverse',
    admin_id: req.user!.id,
    previous_status: 'approved',
    new_status: 'rejected',
    amount: creditedAmount,
    notes: notes ?? 'Reversed: duplicate receipt',
  });

  return sendSuccess(res, { message: 'Deposit reversed, wallet debited, and affiliate commission corrected' });
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

  const isAffiliateWithdrawal = (withdrawal.account_details as Record<string, unknown>)?.type === 'affiliate_earnings';
  if (isAffiliateWithdrawal) {
    // Restore affiliate withdrawal_balance (main wallet was never debited for affiliate earnings)
    const { data: affiliate } = await supabase.from('affiliates').select('id, withdrawal_balance').eq('user_id', withdrawal.user_id).single();
    if (affiliate) {
      await supabase.from('affiliates')
        .update({ withdrawal_balance: affiliate.withdrawal_balance + withdrawal.amount })
        .eq('id', affiliate.id);
    }
  } else {
    // Regular withdrawal: refund the wallet that was debited at request time
    await WalletService.credit(withdrawal.user_id, withdrawal.amount, 'refund', undefined, undefined, 'Withdrawal rejected - funds returned');
  }
  await NotificationService.send(withdrawal.user_id, 'withdrawal_rejected', 'Withdrawal Rejected', `Your withdrawal was rejected. ${notes ?? ''} Funds returned to your account.`);
  await AdminLogService.log(req.user!.id, 'reject_withdrawal', 'withdrawal_request', id, { notes });

  return sendSuccess(res, { message: 'Withdrawal rejected and funds returned' });
}));

// POST /payments/admin/withdrawals/:id/reverse
router.post('/admin/withdrawals/:id/reverse', authenticate, requireAdmin, validateBody(z.object({ notes: z.string().optional() })), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  const { data: withdrawal } = await supabase.from('withdrawal_requests').select('*').eq('id', id).single();
  if (!withdrawal) return sendError(res, 'Withdrawal not found', 404);
  if (withdrawal.status !== 'approved') return sendError(res, 'Only approved withdrawals can be reversed', 400);

  await supabase.from('withdrawal_requests').update({ status: 'rejected', reviewed_by: req.user!.id, reviewed_at: new Date().toISOString(), notes: notes ?? 'Approval reversed by admin' }).eq('id', id);

  const isAffiliateWithdrawal = (withdrawal.account_details as Record<string, unknown>)?.type === 'affiliate_earnings';
  if (isAffiliateWithdrawal) {
    const { data: affiliate } = await supabase.from('affiliates').select('id, withdrawal_balance').eq('user_id', withdrawal.user_id).single();
    if (affiliate) {
      await supabase.from('affiliates')
        .update({ withdrawal_balance: affiliate.withdrawal_balance + withdrawal.amount })
        .eq('id', affiliate.id);
    }
  } else {
    await WalletService.credit(withdrawal.user_id, withdrawal.amount, 'refund', undefined, undefined, 'Withdrawal approval reversed - funds returned');
  }

  await supabase.from('payment_audit_logs').insert({
    entity_type: 'withdrawal_request',
    entity_id: id,
    action: 'reverse',
    admin_id: req.user!.id,
    previous_status: 'approved',
    new_status: 'rejected',
    amount: withdrawal.amount,
    notes: notes ?? 'Approval reversed by admin',
  });

  await NotificationService.send(withdrawal.user_id, 'withdrawal_rejected', 'Withdrawal Reversed', `Your approved withdrawal of ${withdrawal.currency} ${withdrawal.amount} has been reversed. Funds have been returned to your account.`);
  await AdminLogService.log(req.user!.id, 'reverse_withdrawal', 'withdrawal_request', id, { amount: withdrawal.amount, notes });

  return sendSuccess(res, { message: 'Withdrawal approval reversed and funds returned' });
}));

export default router;
