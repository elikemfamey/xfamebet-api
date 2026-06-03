import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { WalletService } from '../../services/walletService';
import { authenticate } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';

const router = Router();
router.use(authenticate);

const transferSchema = z.object({
  to_wallet_type: z.enum(['main', 'bonus', 'cashback']),
  from_wallet_type: z.enum(['main', 'bonus', 'cashback']),
  amount: z.number().positive(),
});

// GET /wallet/balance
router.get('/balance', async (req, res) => {
  try {
    const wallet = await WalletService.getBalance(req.user!.id);
    return sendSuccess(res, wallet);
  } catch (err: unknown) {
    return sendError(res, (err as Error).message, 404);
  }
});

// GET /wallet/transactions
router.get('/transactions', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    const { data, total } = await WalletService.getTransactions(req.user!.id, page, limit);
    return sendPaginated(res, data ?? [], total, page, limit);
  } catch (err: unknown) {
    return sendError(res, (err as Error).message, 500);
  }
});

// POST /wallet/transfer
router.post('/transfer', validateBody(transferSchema), async (req, res) => {
  const { from_wallet_type, to_wallet_type, amount } = req.body;
  if (from_wallet_type === to_wallet_type) {
    return sendError(res, 'Cannot transfer to same wallet', 400);
  }

  const { data: wallet, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', req.user!.id)
    .single();

  if (error || !wallet) return sendError(res, 'Wallet not found', 404);

  const sourceBalance = wallet[`${from_wallet_type}_balance` as keyof typeof wallet] as number ?? wallet.balance;
  if (sourceBalance < amount) return sendError(res, 'Insufficient balance', 400);

  const updateFrom: Record<string, number> = {};
  const updateTo: Record<string, number> = {};

  if (from_wallet_type === 'main') updateFrom.balance = wallet.balance - amount;
  else if (from_wallet_type === 'bonus') updateFrom.bonus_balance = wallet.bonus_balance - amount;
  else updateFrom.cashback_balance = wallet.cashback_balance - amount;

  if (to_wallet_type === 'main') updateTo.balance = wallet.balance + amount;
  else if (to_wallet_type === 'bonus') updateTo.bonus_balance = wallet.bonus_balance + amount;
  else updateTo.cashback_balance = wallet.cashback_balance + amount;

  await supabase.from('wallets').update({ ...updateFrom, ...updateTo }).eq('id', wallet.id);

  await supabase.from('transactions').insert({
    user_id: req.user!.id,
    wallet_id: wallet.id,
    type: 'transfer',
    amount,
    currency: wallet.currency,
    status: 'completed',
    description: `Transfer from ${from_wallet_type} to ${to_wallet_type} wallet`,
  });

  return sendSuccess(res, { message: 'Transfer successful' });
});

export default router;
