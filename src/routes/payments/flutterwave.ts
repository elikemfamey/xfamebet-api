import { randomUUID, timingSafeEqual } from 'node:crypto';
import axios from 'axios';
import { Router } from 'express';
import { z } from 'zod';
import { redis, REDIS_KEYS } from '../../config/redis';
import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { paymentLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { asyncHandler, sendError, sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import { broadcastWalletUpdate } from '../../socket';

const flutterwave = Router();
const apiBase = 'https://api.flutterwave.com/v3';
const intentPrefix = 'flutterwave:test:';
export const flutterwaveTestMinimum = 30_000;

function testKey() {
  const key = process.env.FLUTTERWAVE_TEST_SECRET_KEY?.trim();
  return key?.startsWith('FLWSECK_TEST-') ? key : undefined;
}

export function flutterwaveTestAvailable() {
  return Boolean(testKey()) && (env.NODE_ENV !== 'production' || process.env.FLUTTERWAVE_TEST_ENABLED === 'true');
}

function liveKey() {
  const key = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  return process.env.FLUTTERWAVE_LIVE_ENABLED?.trim() === 'true' && key?.startsWith('FLWSECK-') &&
    process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim() ? key : undefined;
}

export function flutterwaveLiveAvailable() {
  return Boolean(liveKey());
}

if (env.NODE_ENV === 'production') {
  const key = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  logger.info('Flutterwave live configuration', {
    liveCheckoutAvailable: flutterwaveLiveAvailable(),
    liveFlagEnabled: process.env.FLUTTERWAVE_LIVE_ENABLED?.trim() === 'true',
    secretKeyConfigured: Boolean(key),
    secretKeyHasV3LivePrefix: Boolean(key?.startsWith('FLWSECK-')),
    webhookHashConfigured: Boolean(process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim()),
  });
}

const checkoutInput = z.object({
  amount: z.number().min(flutterwaveTestMinimum).max(999_999_999_999.99).multipleOf(0.01),
  email: z.string().trim().email().max(254),
});

const verifyInput = z.object({
  reference: z.string().uuid(),
  transaction_id: z.string().regex(/^[1-9]\d{0,17}$/),
});

async function hostedCheckout(key: string, reference: string, amount: number, email: string, test: boolean) {
  const returnOrigin = process.env.FLUTTERWAVE_RETURN_ORIGIN?.trim()
    || env.FRONTEND_URL.split(',')[0].trim();
  const redirect = new URL('/wallet/deposit', returnOrigin);
  if (!test && redirect.protocol !== 'https:') throw new Error('Flutterwave live checkout requires an HTTPS return URL');
  redirect.searchParams.set('flutterwave', test ? 'test' : 'live');
  const { data } = await axios.post(apiBase + '/payments', {
    tx_ref: reference,
    amount,
    currency: 'NGN',
    redirect_url: redirect.toString(),
    customer: { email },
    customizations: { title: test ? 'Xfamebet test deposit' : 'Xfamebet NGN deposit' },
    configurations: { session_duration: 15 },
  }, { headers: { Authorization: 'Bearer ' + key }, timeout: 15000, maxRedirects: 0 });
  const checkout = new URL(data?.data?.link);
  if (data.status !== 'success' || checkout.origin !== 'https://checkout.flutterwave.com' || checkout.username || checkout.password) {
    throw new Error('Unexpected hosted checkout URL');
  }
  return checkout.href;
}

flutterwave.post('/test/checkout', authenticate, paymentLimiter, validateBody(checkoutInput), asyncHandler(async (req, res) => {
  const key = testKey();
  if (!key || !flutterwaveTestAvailable()) return sendError(res, 'Flutterwave test checkout is unavailable', 404);
  const userId = req.user!.id;
  const { data: user, error } = await supabase.from('users').select('country').eq('id', userId).single();
  if (error) return sendError(res, 'Could not load the deposit account', 503);
  if (user?.country !== 'NG') return sendError(res, 'Flutterwave test checkout is available for Nigeria accounts only', 403);

  const { amount, email } = req.body as z.infer<typeof checkoutInput>;
  const reference = randomUUID();
  const intentKey = intentPrefix + reference;
  await redis.set(intentKey, JSON.stringify({ userId, amount }), 'EX', 3600);
  try {
    return sendSuccess(res, { checkout_url: await hostedCheckout(key, reference, amount, email, true) }, 201);
  } catch {
    await redis.del(intentKey).catch(() => {});
    return sendError(res, 'Could not open Flutterwave test checkout', 502);
  }
}));

flutterwave.post('/checkout', authenticate, paymentLimiter, validateBody(checkoutInput), asyncHandler(async (req, res) => {
  const key = liveKey();
  if (!key) return sendError(res, 'Flutterwave checkout is unavailable', 404);
  const userId = req.user!.id;
  const [user, wallet] = await Promise.all([
    supabase.from('users').select('country, account_status').eq('id', userId).single(),
    supabase.from('wallets').select('currency, currency_locked, balance, bonus_balance, cashback_balance, frozen').eq('user_id', userId).single(),
  ]);
  if (user.error || wallet.error) return sendError(res, 'Could not load the deposit account', 503);
  if (user.data.country !== 'NG' || user.data.account_status !== 'active' || wallet.data.frozen) {
    return sendError(res, 'Flutterwave checkout is available for active Nigeria accounts only', 403);
  }
  if (wallet.data.currency !== 'NGN' && (wallet.data.currency_locked ||
    [wallet.data.balance, wallet.data.bonus_balance, wallet.data.cashback_balance].some(value => Number(value) !== 0))) {
    return sendError(res, 'Flutterwave requires an NGN wallet. Choose another deposit method for this account.', 409);
  }
  const { amount, email } = req.body as z.infer<typeof checkoutInput>;
  const reference = randomUUID();
  const { error } = await supabase.from('flutterwave_deposit_intents').insert({ reference, user_id: userId, amount });
  if (error) return sendError(res, 'Flutterwave checkout is temporarily unavailable', 503);
  try {
    return sendSuccess(res, { checkout_url: await hostedCheckout(key, reference, amount, email, false) }, 201);
  } catch {
    return sendError(res, 'Could not open Flutterwave checkout', 502);
  }
}));

async function settlePayment(key: string, reference: string, transactionId: string, userId?: string) {
  const { data: intent, error } = await supabase.from('flutterwave_deposit_intents')
    .select('user_id, amount').eq('reference', reference).maybeSingle();
  if (error) throw error;
  if (!intent || (userId && userId !== intent.user_id)) return 'missing';
  const { data } = await axios.get(apiBase + '/transactions/' + transactionId + '/verify', {
    headers: { Authorization: 'Bearer ' + key }, timeout: 15000, maxRedirects: 0,
  });
  const transaction = data?.data;
  if (data?.status !== 'success' || String(transaction?.id) !== transactionId ||
    transaction?.tx_ref !== reference || transaction?.currency !== 'NGN') return 'mismatch';
  if (transaction.status !== 'successful') return transaction.status === 'pending' ? 'pending' : 'failed';
  if (Number(transaction.amount) !== Number(intent.amount)) return 'mismatch';

  const lockKey = REDIS_KEYS.WALLET_LOCK(intent.user_id);
  const lockToken = randomUUID();
  if (!await redis.set(lockKey, lockToken, 'EX', 30, 'NX')) throw new Error('Wallet operation in progress');
  try {
    const { data: result, error: settlementError } = await supabase.rpc('finalize_flutterwave_ngn_deposit', {
      p_reference: reference, p_transaction_id: transactionId, p_amount: Number(transaction.amount),
    });
    if (settlementError) throw settlementError;
    if (result?.credited) broadcastWalletUpdate(intent.user_id, Number(result.balance));
  } finally {
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end",
      1, lockKey, lockToken).catch(() => {});
  }
  return 'completed';
}

flutterwave.post('/verify', authenticate, paymentLimiter, validateBody(verifyInput), asyncHandler(async (req, res) => {
  const key = liveKey();
  if (!key) return sendError(res, 'Flutterwave checkout is unavailable', 404);
  const { reference, transaction_id } = req.body as z.infer<typeof verifyInput>;
  try {
    const status = await settlePayment(key, reference, transaction_id, req.user!.id);
    if (status === 'missing') return sendError(res, 'Deposit reference was not found', 404);
    if (status === 'mismatch') return sendError(res, 'The verified payment details did not match this deposit. Contact support with your reference.', 422);
    return sendSuccess(res, { status });
  } catch {
    return sendError(res, 'Verification is temporarily unavailable. Check again shortly.', 503);
  }
}));

flutterwave.post('/webhook', asyncHandler(async (req, res) => {
  const key = liveKey();
  const secret = process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
  if (!key || !secret) return res.sendStatus(404);
  const hash = Buffer.from(req.get('verif-hash') ?? '');
  const expected = Buffer.from(secret);
  if (hash.length !== expected.length || !timingSafeEqual(hash, expected)) return res.sendStatus(401);
  if (req.body?.event !== 'charge.completed' || req.body?.data?.status !== 'successful') return res.sendStatus(200);
  const input = verifyInput.safeParse({
    reference: req.body.data.tx_ref, transaction_id: String(req.body.data.id),
  });
  if (!input.success) return res.sendStatus(200);
  try {
    const status = await settlePayment(key, input.data.reference, input.data.transaction_id);
    return res.sendStatus(status === 'pending' ? 503 : 200);
  } catch {
    return res.sendStatus(503);
  }
}));

flutterwave.post('/test/verify', authenticate, paymentLimiter, validateBody(verifyInput), asyncHandler(async (req, res) => {
  const key = testKey();
  if (!key || !flutterwaveTestAvailable()) return sendError(res, 'Flutterwave test checkout is unavailable', 404);
  const { reference, transaction_id } = req.body as z.infer<typeof verifyInput>;
  const stored = await redis.get(intentPrefix + reference);
  const intent = stored ? JSON.parse(stored) as { userId: string; amount: number } : undefined;
  if (!intent || intent.userId !== req.user!.id) return sendError(res, 'Test deposit reference was not found or expired', 404);

  try {
    const { data } = await axios.get(apiBase + '/transactions/' + transaction_id + '/verify', {
      headers: { Authorization: 'Bearer ' + key }, timeout: 15000, maxRedirects: 0,
    });
    const transaction = data?.data;
    if (data?.status !== 'success' || transaction?.tx_ref !== reference ||
      String(transaction?.id) !== transaction_id || transaction?.currency !== 'NGN') {
      return sendError(res, 'Flutterwave did not verify this test payment', 422);
    }
    if (transaction.status === 'pending') return sendSuccess(res, { status: 'pending' });
    if (transaction.status !== 'successful') return sendSuccess(res, { status: 'failed' });
    if (Number(transaction.amount) !== intent.amount) return sendError(res, 'Test payment amount did not match the deposit request', 422);
    return sendSuccess(res, { status: 'verified', amount: intent.amount, currency: 'NGN' });
  } catch {
    return sendError(res, 'Could not verify the Flutterwave test payment. Try again shortly.', 502);
  }
}));

export default flutterwave;
