import { RequestHandler, Router } from 'express';
import { z } from 'zod';
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
import { MoolreApiError, MoolreService } from '../../services/moolreService';
import { redis } from '../../config/redis';
import { sendOtpSms } from '../../services/smsService';
import { generateOtp } from '../../utils/crypto';

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
/** Minimum amount per individual withdrawal request. */
const WITHDRAWAL_MIN_AMOUNT: Record<string, number> = { NGN: 5000, GHS: 50, USD: 10 };

// ---------------------------------------------------------------------------

const moolreInitSchema = z.object({ amount: z.number().positive().max(100000) });
const moolreMobileMoneySchema = z.object({
  amount: z.number().positive().max(100000),
  network: z.enum(['mtn', 'telecel', 'airteltigo']),
  phone_number: z.string().regex(/^0\d{9}$/, 'Use a 10-digit Ghana phone number beginning with 0'),
  payment_method_id: z.string().uuid(),
});
const moolreOtpSchema = z.object({
  reference: z.string().min(1),
  otp_code: z.string().min(3).max(12),
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

const mobileNumberOtpSchema = z.object({
  network: z.enum(['mtn', 'telecel', 'airteltigo']),
  phone_number: z.string().regex(/^0\d{9}$/, 'Use a 10-digit Ghana phone number beginning with 0'),
});
const mobileNumberVerifySchema = mobileNumberOtpSchema.extend({ otp_code: z.string().length(6) });

const ngBankSchema = z.object({
  amount: z.number().min(30000),
  bank_name: z.string(),
  account_name: z.string(),
  reference: z.string(),
  screenshot_url: z.string().min(1, 'A bank-transfer receipt is required'),
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
const rejectWithdrawalSchema = z.object({
  notes: z.string().trim().min(1, 'A reason is required when declining a withdrawal'),
});

// Extended schema for deposit approval — allows admin to specify the local-currency
// equivalent when approving a USDT deposit for an NGN or GHS wallet.
const approveDepositSchema = z.object({
  notes: z.string().optional(),
  credited_amount: z.number().positive().optional(),
});

// Paystack is intentionally disabled. Historic records remain visible to admins.
router.post('/paystack/initialize', authenticate, (_req, res) => sendError(res, 'Paystack is disabled. Use Moolre, bank transfer, or USDT.', 410));
router.post('/paystack/webhook', (_req, res) => res.status(410).json({ error: 'Paystack is disabled' }));

const MOOLRE_CHANNELS: Record<'mtn' | 'telecel' | 'airteltigo', string> = { mtn: '13', telecel: '6', airteltigo: '7' };
const MOOLRE_PROVIDERS: Record<'mtn' | 'telecel' | 'airteltigo', 'momo_mtn' | 'momo_telecel' | 'momo_airteltigo'> = {
  mtn: 'momo_mtn', telecel: 'momo_telecel', airteltigo: 'momo_airteltigo',
};
const PAYMENT_NUMBER_OTP_KEY = (userId: string, phone: string) => `payment_number_otp:${userId}:${phone}`;
const PAYMENT_NUMBER_COOLDOWN_KEY = (userId: string, phone: string) => `payment_number_cooldown:${userId}:${phone}`;

async function selectedVerifiedMomoMethod(userId: string, methodId: string, phone: string, network: 'mtn' | 'telecel' | 'airteltigo') {
  const { data: method } = await supabase.from('payment_methods').select('id, account_number, method_type, verified_phone')
    .eq('id', methodId).eq('user_id', userId).eq('status', 'active').single();
  if (!method || !method.verified_phone || method.account_number !== phone || method.method_type !== MOOLRE_PROVIDERS[network]) {
    throw new Error('Select a verified mobile money number for this network');
  }
  return method;
}

async function getEligibleMoolreWallet(userId: string) {
  const [{ data: user }, { data: wallet }] = await Promise.all([
    supabase.from('users').select('country').eq('id', userId).single(),
    supabase.from('wallets').select('currency, currency_locked').eq('user_id', userId).single(),
  ]);
  if (!user || !wallet) throw new Error('User wallet not found');
  if (user.country !== 'GH') throw new Error('Moolre deposits are currently available to Ghana users only');
  if (wallet.currency_locked && wallet.currency !== 'GHS') throw new Error('Moolre is available only for GHS wallets');
  return wallet;
}

// POST /payments/moolre/mobile-money -- sends a MoMo approval prompt to the player's phone.
router.post('/moolre/mobile-money', authenticate, paymentLimiter, validateBody(moolreMobileMoneySchema), asyncHandler(async (req, res) => {
  if (!MoolreService.isConfigured()) return sendError(res, `Moolre is not configured. Missing: ${MoolreService.missingConfiguration().join(', ')}`, 503);
  const { amount, network, phone_number, payment_method_id } = req.body;
  const chargeAmount = Math.max(amount, 300);
  try { await getEligibleMoolreWallet(req.user!.id); }
  catch (err) { return sendError(res, (err as Error).message, 400); }
  try { await selectedVerifiedMomoMethod(req.user!.id, payment_method_id, phone_number, network); }
  catch (err) { return sendError(res, (err as Error).message, 400); }
  const reference = `MLR-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const channel = MOOLRE_CHANNELS[network as keyof typeof MOOLRE_CHANNELS];
  const { error } = await supabase.from('deposit_requests').insert({
    user_id: req.user!.id, amount: chargeAmount, currency: 'GHS', payment_provider: 'moolre', reference, account_number: phone_number,
    status: 'pending', metadata: { network, channel, payment_mode: 'mobile_money_prompt' },
  });
  if (error) return sendError(res, 'Could not create deposit request', 500);
  try {
    const result = await MoolreService.requestMobileMoneyPayment({ amount: chargeAmount, reference, phone: phone_number, channel });
    await supabase.from('deposit_requests').update({ metadata: { network, channel, payment_mode: 'mobile_money_prompt', moolre_code: result.code } }).eq('reference', reference);
    return sendSuccess(res, {
      reference, code: result.code, otp_required: result.code === 'TP14', prompt_sent: result.code === 'TR099',
      message: result.message ?? (result.code === 'TR099' ? 'Payment prompt sent.' : 'Moolre requires additional verification.'),
    });
  } catch (err) {
    await supabase.from('deposit_requests').update({ status: 'rejected', notes: 'Moolre mobile money request failed' }).eq('reference', reference);
    if (err instanceof MoolreApiError) return sendError(res, `Moolre rejected the payment request${err.providerCode ? ` (${err.providerCode})` : ''}: ${err.message}`, 502);
    throw err;
  }
}));

// POST /payments/moolre/mobile-money/otp -- completes Moolre's optional OTP step.
router.post('/moolre/mobile-money/otp', authenticate, paymentLimiter, validateBody(moolreOtpSchema), asyncHandler(async (req, res) => {
  const { reference, otp_code } = req.body;
  const { data: deposit } = await supabase.from('deposit_requests').select('*').eq('user_id', req.user!.id)
    .eq('payment_provider', 'moolre').eq('reference', reference).eq('status', 'pending').single();
  if (!deposit) return sendError(res, 'Pending Moolre deposit not found', 404);
  const metadata = (deposit.metadata ?? {}) as Record<string, string>;
  const channel = metadata.channel;
  if (!channel || !deposit.account_number) return sendError(res, 'Moolre payment details are incomplete', 400);
  try {
    let result = await MoolreService.requestMobileMoneyPayment({ amount: deposit.amount, reference, phone: deposit.account_number, channel, otpCode: otp_code });
    // TP14's documented flow requires a fresh payment request after OTP verification.
    // Moolre's verification-success text is not stable, so retry every non-prompt
    // response once; an invalid OTP simply returns TP14 again without charging.
    if (result.code !== 'TR099') {
      result = await MoolreService.requestMobileMoneyPayment({ amount: deposit.amount, reference, phone: deposit.account_number, channel });
    }
    return sendSuccess(res, {
      reference, code: result.code, otp_required: result.code === 'TP14', prompt_sent: result.code === 'TR099',
      message: result.message ?? (result.code === 'TR099' ? 'Payment prompt sent.' : 'Moolre did not yet initiate the payment prompt.'),
    });
  } catch (err) {
    if (err instanceof MoolreApiError) return sendError(res, `Moolre rejected the OTP${err.providerCode ? ` (${err.providerCode})` : ''}: ${err.message}`, 502);
    throw err;
  }
}));

// POST /payments/moolre/:reference/verify -- player-triggered immediate status check.
router.post('/moolre/:reference/verify', authenticate, paymentLimiter, asyncHandler(async (req, res) => {
  const { data: deposit } = await supabase.from('deposit_requests').select('id, user_id, amount, reference, status')
    .eq('reference', req.params.reference).eq('user_id', req.user!.id).eq('payment_provider', 'moolre').single();
  if (!deposit) return sendError(res, 'Moolre deposit not found', 404);
  if (deposit.status === 'completed') return sendSuccess(res, { status: 'completed', credited: false });
  const result = await MoolreService.verifyAndCredit(deposit);
  if (result && !result.already_completed && result.user_id) {
    await NotificationService.send(result.user_id, 'deposit_approved', 'Deposit Approved', `Your Moolre deposit of GHS ${result.amount} has been credited.`);
    return sendSuccess(res, { status: 'completed', credited: true });
  }
  return sendSuccess(res, { status: 'pending', credited: false, message: 'Payment is still being confirmed by Moolre.' });
}));

// POST /payments/moolre/initialize -- Ghana GHS checkout only.
router.post('/moolre/initialize', authenticate, paymentLimiter, validateBody(moolreInitSchema), asyncHandler(async (req, res) => {
  if (!MoolreService.isConfigured()) {
    return sendError(res, `Moolre is not configured. Missing: ${MoolreService.missingConfiguration().join(', ')}`, 503);
  }
  const { amount } = req.body;
  const chargeAmount = Math.max(amount, 300);
  const [{ data: user }, { data: wallet }] = await Promise.all([
    supabase.from('users').select('country').eq('id', req.user!.id).single(),
    supabase.from('wallets').select('currency, currency_locked').eq('user_id', req.user!.id).single(),
  ]);
  if (!user || !wallet) return sendError(res, 'User wallet not found', 404);
  if (user.country !== 'GH') return sendError(res, 'Moolre deposits are currently available to Ghana users only', 403);
  if (wallet.currency_locked && wallet.currency !== 'GHS') return sendError(res, 'Moolre is available only for GHS wallets', 400);

  const reference = `MLR-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const { error } = await supabase.from('deposit_requests').insert({
    user_id: req.user!.id, amount: chargeAmount, currency: 'GHS', payment_provider: 'moolre', reference, status: 'pending',
    metadata: { requested_wallet_currency: wallet.currency, country: user.country },
  });
  if (error) return sendError(res, 'Could not create deposit request', 500);
  try {
    const link = await MoolreService.createPaymentLink(chargeAmount, reference, { user_id: req.user!.id, deposit_reference: reference });
    return sendSuccess(res, { authorization_url: link.authorizationUrl, reference });
  } catch (err) {
    await supabase.from('deposit_requests').update({ status: 'rejected', notes: 'Moolre checkout creation failed' }).eq('reference', reference);
    if (err instanceof MoolreApiError) {
      return sendError(res, `Moolre rejected the checkout request${err.providerCode ? ` (${err.providerCode})` : ''}: ${err.message}`, 502);
    }
    throw err;
  }
}));

// Moolre does not provide a documented callback signature; never trust its body.
// Every callback is independently verified against Moolre's status endpoint.
router.post('/moolre/webhook', asyncHandler(async (req, res) => {
  const payload = req.body as { data?: { externalref?: string } };
  const reference = payload?.data?.externalref;
  if (reference) {
    const { data: deposit } = await supabase.from('deposit_requests').select('id, user_id, amount, reference, status')
      .eq('payment_provider', 'moolre').eq('reference', reference).single();
    if (deposit?.status === 'pending') {
      const result = await MoolreService.verifyAndCredit(deposit);
      if (result && !result.already_completed && result.user_id) {
        await NotificationService.send(result.user_id, 'deposit_approved', 'Deposit Approved', `Your Moolre deposit of GHS ${result.amount} has been credited.`);
      }
    }
  }
  return res.status(200).json({ received: true });
}));

// POST /payments/manual-momo/deposit
router.post('/manual-momo/deposit', authenticate, paymentLimiter, validateBody(manualMomoSchema), asyncHandler(async (req, res) => {
  return sendError(res, 'Manual MoMo deposits have been replaced by Moolre checkout', 410);
  /* Historical request shape below is unreachable. */
  const { amount, provider, phone_number, sender_name, transaction_id, screenshot_url } = req.body;

  const { data: userRecord } = await supabase.from('users').select('country').eq('id', req.user!.id).single();

  // Lock wallet on first deposit. For a user whose wallet is already locked to a
  // different currency (e.g. NGN), the deposit is still accepted; the admin enters
  // the credited_amount (wallet-currency equivalent) at approval time.

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
  if (userRecord?.country !== 'NG') return sendError(res, 'Manual bank deposits are currently available to Nigeria users only', 403);

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
  // Currency is locked only after this crypto payment is approved.

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

// POST /payments/mobile-numbers/otp -- send a verification code before a new MoMo number can be saved.
router.post('/mobile-numbers/otp', authenticate, paymentLimiter, validateBody(mobileNumberOtpSchema), asyncHandler(async (req, res) => {
  const { network, phone_number } = req.body;
  const { data: user } = await supabase.from('users').select('country').eq('id', req.user!.id).single();
  if (user?.country !== 'GH') return sendError(res, 'Saved mobile money numbers are currently available to Ghana users only', 403);
  if (await redis.get(PAYMENT_NUMBER_COOLDOWN_KEY(req.user!.id, phone_number))) return sendError(res, 'Please wait 60 seconds before requesting another code', 429);
  const otp = generateOtp();
  await redis.setex(PAYMENT_NUMBER_OTP_KEY(req.user!.id, phone_number), 600, JSON.stringify({ otp, network }));
  await redis.setex(PAYMENT_NUMBER_COOLDOWN_KEY(req.user!.id, phone_number), 60, '1');
  try {
    await sendOtpSms(phone_number, otp, 'GH');
  } catch {
    await redis.del(PAYMENT_NUMBER_OTP_KEY(req.user!.id, phone_number));
    return sendError(res, 'SMS delivery failed. Please try again.', 503);
  }
  return sendSuccess(res, { message: 'Verification code sent' });
}));

// POST /payments/mobile-numbers/verify -- save a verified number as an eligible deposit/payout method.
router.post('/mobile-numbers/verify', authenticate, paymentLimiter, validateBody(mobileNumberVerifySchema), asyncHandler(async (req, res) => {
  const { network, phone_number, otp_code } = req.body;
  const key = PAYMENT_NUMBER_OTP_KEY(req.user!.id, phone_number);
  const raw = await redis.get(key);
  if (!raw) return sendError(res, 'Verification code has expired. Request another code.', 400);
  const pending = JSON.parse(raw) as { otp: string; network: 'mtn' | 'telecel' | 'airteltigo' };
  if (pending.otp !== otp_code || pending.network !== network) return sendError(res, 'Invalid verification code', 400);
  await redis.del(key);
  const methodType = MOOLRE_PROVIDERS[network as 'mtn' | 'telecel' | 'airteltigo'];
  const { data: existing } = await supabase.from('payment_methods').select('id')
    .eq('user_id', req.user!.id).eq('account_number', phone_number).eq('method_type', methodType).single();
  let methodId = existing?.id;
  if (methodId) {
    await supabase.from('payment_methods').update({ status: 'active', verified_phone: true, verified_at: new Date().toISOString(), provider: network }).eq('id', methodId);
  } else {
    const { count } = await supabase.from('payment_methods').select('*', { count: 'exact', head: true })
      .eq('user_id', req.user!.id).eq('status', 'active').eq('verified_phone', true);
    const { data, error } = await supabase.from('payment_methods').insert({
      user_id: req.user!.id, method_type: methodType, country: 'GH', provider: network, account_number: phone_number,
      account_name: 'Mobile Money', is_default: (count ?? 0) === 0, status: 'active', verified_phone: true, verified_at: new Date().toISOString(),
    }).select('id').single();
    if (error || !data) return sendError(res, 'Could not save verified number', 500);
    methodId = data.id;
  }
  return sendSuccess(res, { id: methodId, message: 'Mobile money number verified and saved' }, 201);
}));

// POST /payments/mobile-numbers/:id/default -- choose the default verified MoMo number.
router.post('/mobile-numbers/:id/default', authenticate, asyncHandler(async (req, res) => {
  const { data: method } = await supabase.from('payment_methods').select('id').eq('id', req.params.id)
    .eq('user_id', req.user!.id).eq('status', 'active').eq('verified_phone', true).single();
  if (!method) return sendError(res, 'Verified mobile money number not found', 404);
  await supabase.from('payment_methods').update({ is_default: false }).eq('user_id', req.user!.id);
  await supabase.from('payment_methods').update({ is_default: true }).eq('id', method.id);
  return sendSuccess(res, { message: 'Default mobile money number updated' });
}));

// POST /payments/payout-settings
router.post('/payout-settings', authenticate, validateBody(payoutSettingsSchema), asyncHandler(async (req, res) => {
  const { method_type, account_name, account_number, bank_name, is_default } = req.body;

  if (method_type.startsWith('momo_')) {
    return sendError(res, 'Verify mobile money numbers using the mobile-number verification flow before saving them', 400);
  }

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

  // Never allow a client to choose an arbitrary MoMo payout recipient. The selected
  // saved method must belong to this player and have completed number verification.
  if (payment_provider.startsWith('momo_')) {
    const paymentMethodId = account_details.payment_method_id;
    if (!paymentMethodId) return sendError(res, 'Select a verified mobile money number', 400);
    const { data: method } = await supabase.from('payment_methods').select('id, account_number, account_name, method_type, verified_phone')
      .eq('id', paymentMethodId).eq('user_id', req.user!.id).eq('status', 'active').eq('verified_phone', true).single();
    if (!method || method.method_type !== payment_provider) return sendError(res, 'Selected mobile money number is not eligible for this withdrawal', 400);
    account_details.account_number = method.account_number;
    account_details.account_name = method.account_name;
    account_details.payment_method_id = method.id;
  }

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

  const { error: requestError } = await supabase.rpc('create_withdrawal_request', {
    p_user_id: req.user!.id, p_amount: amount, p_provider: payment_provider, p_account_details: account_details,
  });
  if (requestError) return sendError(res, requestError.message, 400);

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
  const { data: walletRow } = await supabase.from('wallets').select('id, currency, currency_locked').eq('user_id', deposit.user_id).single();
  let walletCurrency = walletRow?.currency ?? deposit.currency;
  // First verified deposit, not first request, chooses the wallet currency.
  if (walletRow && !walletRow.currency_locked) {
    const { data: user } = await supabase.from('users').select('country').eq('id', deposit.user_id).single();
    const firstDepositCurrency = deposit.payment_provider === 'ng_bank_transfer' && user?.country === 'NG' ? 'NGN'
      : deposit.payment_provider === 'usdt_trc20' ? 'USD'
        : deposit.payment_provider.startsWith('momo_') && user?.country === 'GH' ? 'GHS'
          : walletCurrency;
    await supabase.from('wallets').update({ currency: firstDepositCurrency, currency_locked: true }).eq('id', walletRow.id);
    walletCurrency = firstDepositCurrency;
  }
  const amountToCredit = credited_amount ?? deposit.amount;

  // If deposit currency differs from wallet currency a conversion is required.
  // The admin must supply credited_amount (the wallet-currency equivalent).
  const depositCurrencyMatchesWallet =
    deposit.currency === walletCurrency ||
    (deposit.currency === 'USDT' && walletCurrency === 'USD');
  if (!depositCurrencyMatchesWallet && !credited_amount) {
    return sendError(res, `Deposit is in ${deposit.currency} but wallet is ${walletCurrency}. Provide credited_amount (the ${walletCurrency} equivalent) to approve.`, 400);
  }

  const { data: fxRate } = await supabase.from('currency_exchange_rates').select('usd_rate').eq('currency', walletCurrency).single();
  const usdRate = Number(fxRate?.usd_rate ?? 1);
  await supabase.from('deposit_requests').update({
    status: 'approved', reviewed_by: req.user!.id,
    reviewed_at: new Date().toISOString(), notes,
    metadata: { ...(deposit.metadata ?? {}), usd_rate: usdRate, usd_equivalent: Number((amountToCredit * usdRate).toFixed(2)) },
  }).eq('id', id);

  await WalletService.credit(deposit.user_id, amountToCredit, 'deposit', deposit.payment_provider, undefined, `${deposit.payment_provider} deposit approved`, { usd_rate: usdRate, usd_equivalent: Number((amountToCredit * usdRate).toFixed(2)) });
  await NotificationService.send(deposit.user_id, 'deposit_approved', 'Deposit Approved', `Your deposit has been approved. ${walletCurrency} ${amountToCredit} has been credited to your account.`);
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
router.post('/admin/withdrawals/:id/approve', authenticate, requireAdmin, validateBody(z.object({
  payout_reference: z.string().optional(),
  notes: z.string().optional(),
  adjusted_amount: z.number().positive().optional(),
})), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { payout_reference, notes, adjusted_amount } = req.body;

  const { data: withdrawal } = await supabase.from('withdrawal_requests').select('*').eq('id', id).single();
  if (!withdrawal) return sendError(res, 'Withdrawal not found', 404);
  if (withdrawal.status !== 'pending') return sendError(res, 'Already processed', 400);

  if (adjusted_amount !== undefined && adjusted_amount > withdrawal.amount) {
    return sendError(res, 'Adjusted amount cannot exceed the original requested amount', 400);
  }

  const finalAmount = adjusted_amount ?? withdrawal.amount;

  // If admin reduced the payout amount, credit the difference back to the user's wallet
  if (adjusted_amount !== undefined && adjusted_amount < withdrawal.amount) {
    const refundDiff = withdrawal.amount - adjusted_amount;
    const isAffiliateWithdrawal = (withdrawal.account_details as Record<string, unknown>)?.type === 'affiliate_earnings';
    if (isAffiliateWithdrawal) {
      const { data: affiliate } = await supabase.from('affiliates').select('id, withdrawal_balance').eq('user_id', withdrawal.user_id).single();
      if (affiliate) {
        await supabase.from('affiliates').update({ withdrawal_balance: affiliate.withdrawal_balance + refundDiff }).eq('id', affiliate.id);
      }
    } else {
      await WalletService.credit(withdrawal.user_id, refundDiff, 'refund', undefined, undefined, `Withdrawal amount adjusted — ${withdrawal.currency} ${refundDiff} returned`);
    }
  }

  await supabase.from('withdrawal_requests').update({ status: 'approved', amount: finalAmount, reviewed_by: req.user!.id, reviewed_at: new Date().toISOString(), payout_reference, notes }).eq('id', id);
  await NotificationService.send(withdrawal.user_id, 'withdrawal_approved', 'Withdrawal Approved', `Your withdrawal of ${withdrawal.currency} ${finalAmount} has been approved.`);
  await AdminLogService.log(req.user!.id, 'approve_withdrawal', 'withdrawal_request', id, { original_amount: withdrawal.amount, approved_amount: finalAmount, payout_reference });

  return sendSuccess(res, { message: 'Withdrawal approved' });
}));

// POST /payments/admin/withdrawals/:id/complete
// Funds were already reserved at request time; this records the real-world payout.
router.post('/admin/withdrawals/:id/complete', authenticate, requireAdmin, validateBody(z.object({
  payout_reference: z.string().min(1), notes: z.string().optional(),
})), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { payout_reference, notes } = req.body;
  const { data: withdrawal } = await supabase.from('withdrawal_requests').select('*').eq('id', id).single();
  if (!withdrawal) return sendError(res, 'Withdrawal not found', 404);
  if (withdrawal.status !== 'approved') return sendError(res, 'Only approved withdrawals can be marked completed', 400);
  await supabase.from('withdrawal_requests').update({
    status: 'completed', payout_reference, notes: notes ?? withdrawal.notes,
    reviewed_by: req.user!.id, reviewed_at: new Date().toISOString(),
  }).eq('id', id);
  await supabase.from('payment_audit_logs').insert({ entity_type: 'withdrawal_request', entity_id: id, action: 'complete', admin_id: req.user!.id, previous_status: 'approved', new_status: 'completed', amount: withdrawal.amount, notes });
  await NotificationService.send(withdrawal.user_id, 'withdrawal_approved', 'Withdrawal Completed', `Your withdrawal of ${withdrawal.currency} ${withdrawal.amount} has been paid.`);
  await AdminLogService.log(req.user!.id, 'complete_withdrawal', 'withdrawal_request', id, { payout_reference, notes });
  return sendSuccess(res, { message: 'Withdrawal marked completed' });
}));

// POST /payments/admin/withdrawals/:id/reject
router.post('/admin/withdrawals/:id/reject', authenticate, requireAdmin, validateBody(rejectWithdrawalSchema), asyncHandler(async (req, res) => {
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
  await NotificationService.send(withdrawal.user_id, 'withdrawal_rejected', 'Withdrawal Declined', `Your withdrawal was declined. Reason: ${notes}. Funds have been returned to your account.`);
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
