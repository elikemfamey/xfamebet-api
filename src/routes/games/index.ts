import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { WalletService } from '../../services/walletService';
import { sendError, sendSuccess } from '../../utils/response';

const router = Router();
router.use(authenticate);

const playSchema = z.object({
  game: z.enum(['bottle', 'coin_flip', 'dice', 'spin']),
  amount: z.number().min(0.5).max(50_000),
  choice: z.string().optional(),
});

type Game = z.infer<typeof playSchema>['game'];
type Outcome = { result: string; multiplier: number; detail: string };

const rules = {
  bottle: { min_stake: 0.5, max_stake: 50_000, choices: ['up', 'down'], payout: '2.00x', note: 'Bottle stopping in the middle loses the stake.' },
  coin_flip: { min_stake: 0.5, max_stake: 50_000, choices: ['heads', 'tails'], payout: '1.95x', note: 'A winning side pays 1.95x.' },
  dice: { min_stake: 0.5, max_stake: 50_000, choices: ['low', 'high'], payout: '1.95x', note: 'Low is 1–48 and high is 53–100; 49–52 loses.' },
  spin: { min_stake: 0.5, max_stake: 50_000, choices: [], payout: 'up to 5.00x', note: 'The multiplier is shown after the server settles the spin.' },
} as const;

function settle(game: Game, choice?: string): Outcome {
  if (game === 'bottle') {
    const result = Math.random() < 0.05 ? 'middle' : Math.random() < 0.5 ? 'up' : 'down';
    return { result, multiplier: result === choice ? 2 : 0, detail: result === 'middle' ? 'Bottle stopped at the middle.' : `Bottle stopped ${result}.` };
  }
  if (game === 'coin_flip') {
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    return { result, multiplier: result === choice ? 1.95 : 0, detail: `Coin landed ${result}.` };
  }
  if (game === 'dice') {
    const roll = Math.floor(Math.random() * 100) + 1;
    const result = roll <= 48 ? 'low' : roll >= 53 ? 'high' : 'house';
    return { result, multiplier: result === choice ? 1.95 : 0, detail: `Dice rolled ${roll}.` };
  }
  const roll = Math.random();
  const multiplier = roll < 0.45 ? 0 : roll < 0.72 ? 1.2 : roll < 0.89 ? 1.5 : roll < 0.98 ? 2 : 5;
  return { result: `${multiplier.toFixed(2)}x`, multiplier, detail: multiplier ? `Spin won ${multiplier.toFixed(2)}x.` : 'Spin did not win this round.' };
}

router.get('/rules', (_req, res) => sendSuccess(res, rules));

router.post('/play', async (req, res) => {
  const parsed = playSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 'Invalid game wager', 400);
  const { game, amount, choice } = parsed.data;
  const rule = rules[game];
  if (rule.choices.length && !rule.choices.includes(choice as never)) return sendError(res, 'Select a valid game option', 400);

  try {
    const debit = await WalletService.debit(req.user!.id, amount, 'bet_stake', `${game} game stake`, { game, choice, amount });
    const outcome = settle(game, choice);
    let balance = debit.new_balance;
    let winAmount = 0;
    if (outcome.multiplier > 0) {
      winAmount = Number((amount * outcome.multiplier).toFixed(2));
      const credit = await WalletService.credit(req.user!.id, winAmount, 'bet_win', undefined, undefined, `${game} game win`, { game, choice, amount, ...outcome });
      balance = credit.new_balance;
    }
    return sendSuccess(res, { game, choice, amount, ...outcome, win_amount: winAmount, new_balance: balance });
  } catch (error: any) {
    return sendError(res, error.message ?? 'Unable to settle game round', 400);
  }
});

router.get('/history', async (req, res) => {
  try {
    const { data } = await WalletService.getTransactions(req.user!.id, 1, 50);
    const history = (data ?? []).filter((transaction: any) => transaction.metadata?.game && ['bottle', 'coin_flip', 'dice', 'spin'].includes(transaction.metadata.game));
    return sendSuccess(res, { history });
  } catch (error: any) {
    return sendError(res, error.message ?? 'Unable to load game history', 500);
  }
});

export default router;
