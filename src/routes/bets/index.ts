import { Router } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { WalletService } from '../../services/walletService';
import { FraudService } from '../../services/fraudService';
import { NotificationService } from '../../services/notificationService';
import { authenticate, requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { betLimiter } from '../../middleware/rateLimiter';
import { broadcastBetWon } from '../../socket';

const router = Router();

// Generates an 8-char booking code avoiding visually ambiguous chars
function generateShareCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// ── PUBLIC: look up bet by share code (no auth required) ──────────────────────
router.get('/share/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { data } = await supabase
    .from('bets')
    .select('id, share_code, odds, stake, potential_payout, bet_type, placed_at, bet_selections(event_id, event_name, market_type, selection, odds)')
    .eq('share_code', code)
    .single();

  if (!data) return sendError(res, 'Bet code not found', 404);
  return sendSuccess(res, data);
});

router.use(authenticate);

const selectionSchema = z.object({
  event_id: z.string(),
  event_name: z.string(),
  market_type: z.string(),
  selection: z.string(),
  odds: z.number().min(1.01).max(1000),
});

const placeBetSchema = z.object({
  stake: z.number().min(0.5).max(100000),
  bet_type: z.enum(['single', 'multi', 'accumulator', 'system', 'bet_builder']),
  use_bonus: z.boolean().default(false),
  selections: z.array(selectionSchema).min(1).max(20),
});

type PlaceBetBody = z.infer<typeof placeBetSchema>;

// POST /bets/place
router.post('/place', betLimiter, validateBody(placeBetSchema), async (req, res) => {
  const { stake, bet_type, use_bonus, selections } = req.body as PlaceBetBody;
  const userId = req.user!.id;

  // Check responsible gambling
  const { data: rgLimit } = await supabase.from('responsible_gambling_limits')
    .select('*').eq('user_id', userId).eq('limit_type', 'bet').single();

  if (rgLimit?.self_excluded) return sendError(res, 'Self-exclusion is active', 403);

  if (rgLimit?.amount_limit && rgLimit.current_amount + stake > rgLimit.amount_limit) {
    return sendError(res, 'Bet limit reached for this period', 400);
  }

  // Validate odds still active
  for (const sel of selections) {
    const { data: oddsData } = await supabase
      .from('odds_feed').select('odds_value, status')
      .eq('event_id', sel.event_id).eq('market_type', sel.market_type)
      .eq('selection', sel.selection).single();

    if (!oddsData || oddsData.status !== 'active') {
      return sendError(res, `Odds for ${sel.event_name} - ${sel.selection} are no longer available`, 400);
    }

    // Validate odds haven't moved significantly (anti-latency betting)
    const oddsMovement = Math.abs(oddsData.odds_value - sel.odds) / sel.odds;
    if (oddsMovement > 0.1) {
      return sendError(res, `Odds have changed for ${sel.event_name}. Please refresh.`, 400);
    }
  }

  // Calculate total odds and payout
  const totalOdds = selections.reduce((acc, s) => acc * s.odds, 1);
  const potentialPayout = parseFloat((stake * totalOdds).toFixed(2));

  // Deduct stake from wallet
  try {
    if (use_bonus) {
      const wallet = await WalletService.getBalance(userId);
      if (wallet.bonus_balance < stake) return sendError(res, 'Insufficient bonus balance', 400);
      await supabase.from('wallets').update({ bonus_balance: wallet.bonus_balance - stake }).eq('user_id', userId);
      await supabase.from('transactions').insert({
        user_id: userId, wallet_id: wallet.id, type: 'bet_stake',
        amount: -stake, currency: wallet.currency, status: 'completed', description: 'Bet stake (bonus)',
      });
    } else {
      await WalletService.debit(userId, stake, 'bet_stake', 'Bet placement');
    }
  } catch (err: unknown) {
    return sendError(res, (err as Error).message, 400);
  }

  // Generate unique share code (retry once on collision)
  let shareCode = generateShareCode();
  const { data: existing } = await supabase.from('bets').select('id').eq('share_code', shareCode).single();
  if (existing) shareCode = generateShareCode();

  // Create bet
  const { data: bet, error: betErr } = await supabase.from('bets').insert({
    user_id: userId,
    event_id: selections.length === 1 ? selections[0].event_id : null,
    odds: totalOdds,
    stake,
    potential_payout: potentialPayout,
    payout: 0,
    status: 'pending',
    bet_type,
    use_bonus,
    share_code: shareCode,
  }).select().single();

  if (betErr || !bet) {
    // Refund on failure
    await WalletService.credit(userId, stake, 'refund', undefined, undefined, 'Bet placement failed - refund');
    return sendError(res, 'Bet placement failed', 500);
  }

  // Store selections and snapshots
  await supabase.from('bet_selections').insert(
    selections.map(s => ({ bet_id: bet.id, ...s }))
  );

  await supabase.from('odds_snapshots').insert(
    selections.map(s => ({
      bet_id: bet.id, event_id: s.event_id, market_type: s.market_type,
      selection: s.selection, odds_value: s.odds, source: 'internal', captured_at: new Date().toISOString(),
    }))
  );

  // Update responsible gambling tracker
  if (rgLimit) {
    await supabase.from('responsible_gambling_limits')
      .update({ current_amount: (rgLimit.current_amount ?? 0) + stake })
      .eq('id', rgLimit.id);
  }

  // Fraud check for large bets
  if (stake > 1000) {
    await FraudService.emitEvent(userId, 'large_bet', { stake, event_id: selections[0]?.event_id });
  } else {
    await FraudService.emitEvent(userId, 'bet_placement', { stake });
  }

  return sendSuccess(res, {
    bet_id: bet.id,
    share_code: shareCode,
    stake,
    odds: totalOdds,
    potential_payout: potentialPayout,
    status: 'pending',
  }, 201);
});

// GET /bets/history
router.get('/history', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const status = req.query.status as string;

  let query = supabase
    .from('bets')
    .select('*, bet_selections(*)', { count: 'exact' })
    .eq('user_id', req.user!.id)
    .order('placed_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, count } = await query;
  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// GET /bets/live
router.get('/live', async (req, res) => {
  const { data } = await supabase
    .from('bets')
    .select('*, bet_selections(*)')
    .eq('user_id', req.user!.id)
    .eq('status', 'pending')
    .order('placed_at', { ascending: false });
  return sendSuccess(res, data ?? []);
});

// GET /bets/:id
router.get('/:id', async (req, res) => {
  const { data } = await supabase
    .from('bets')
    .select('*, bet_selections(*), odds_snapshots(*)')
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id)
    .single();

  if (!data) return sendError(res, 'Bet not found', 404);
  return sendSuccess(res, data);
});

// GET /bets/admin/all (Admin only)
router.get('/admin/all', requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 25;
  const offset = (page - 1) * limit;
  const status = req.query.status as string;

  let query = supabase
    .from('bets')
    .select('*, users(username, phone), bet_selections(*)', { count: 'exact' })
    .order('placed_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, count } = await query;
  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// POST /bets/admin/settle (Admin only)
router.post('/admin/settle/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { result } = req.body;

  const { data: bet } = await supabase.from('bets').select('*, bet_selections(*)').eq('id', id).single();
  if (!bet) return sendError(res, 'Bet not found', 404);
  if (bet.status !== 'pending') return sendError(res, 'Bet already settled', 400);

  const newStatus = result === 'won' ? 'won' : result === 'void' ? 'void' : 'lost';
  await supabase.from('bets').update({ status: newStatus, settled_at: new Date().toISOString() }).eq('id', id);

  if (newStatus === 'won') {
    await WalletService.credit(bet.user_id, bet.potential_payout, 'bet_win', undefined, undefined, `Bet won - ${id}`);
    await NotificationService.send(bet.user_id, 'bet_won', 'Bet Won!', `Congratulations! You won GHS ${bet.potential_payout}`);
    await supabase.from('bets').update({ payout: bet.potential_payout }).eq('id', id);

    // Fetch wallet currency and share code for the win celebration push
    const { data: wallet } = await supabase.from('wallets').select('currency').eq('user_id', bet.user_id).single();
    broadcastBetWon(bet.user_id, {
      betId: id,
      amount: bet.potential_payout,
      currency: wallet?.currency ?? 'GHS',
      shareCode: bet.share_code ?? undefined,
    });
  } else if (newStatus === 'void') {
    await WalletService.credit(bet.user_id, bet.stake, 'refund', undefined, undefined, `Bet voided - stake refunded`);
  } else {
    await NotificationService.send(bet.user_id, 'bet_lost', 'Bet Lost', `Your bet has been settled.`);
  }

  return sendSuccess(res, { message: `Bet settled as ${newStatus}` });
});

// POST /bets/admin/void/:id
router.post('/admin/void/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const { data: bet } = await supabase.from('bets').select('*').eq('id', id).single();
  if (!bet) return sendError(res, 'Bet not found', 404);

  await supabase.from('bets').update({ status: 'void', void_reason: reason, settled_at: new Date().toISOString() }).eq('id', id);
  await WalletService.credit(bet.user_id, bet.stake, 'refund', undefined, undefined, 'Bet voided - stake refunded');

  return sendSuccess(res, { message: 'Bet voided and stake refunded' });
});

export default router;
