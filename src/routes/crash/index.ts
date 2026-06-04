import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../../middleware/auth';
import { WalletService } from '../../services/walletService';
import { redis } from '../../config/redis';
import { sendSuccess, sendError } from '../../utils/response';

const router = Router();

// Crash point formula — 4% house edge
function generateCrashPoint(): number {
  const r = Math.random();
  if (r < 0.04) return 1.0;
  return Math.max(1.01, parseFloat((0.96 / (1 - r)).toFixed(2)));
}

// Same growth rate as the frontend (exp(0.08 * seconds))
const GROWTH_RATE = 0.08;

function multiplierAtTime(elapsedMs: number): number {
  return parseFloat(Math.exp(GROWTH_RATE * (elapsedMs / 1000)).toFixed(2));
}

const ROUND_KEY = (roundId: string) => `crash:round:${roundId}`;
const HISTORY_KEY = 'crash:history';

interface CrashRound {
  userId: string;
  amount: number;
  crashPoint: number;
  startTime: number; // ms since epoch
  cashedOut: boolean;
  cashoutMultiplier?: number;
}

// POST /api/crash/bet
// Debit wallet and open a round for this user
router.post('/bet', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { amount } = req.body;

  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return sendError(res, 'Invalid bet amount', 400);
  }

  if (amount < 1) return sendError(res, 'Minimum bet is 1', 400);
  if (amount > 100000) return sendError(res, 'Maximum bet is 100,000', 400);

  try {
    const result = await WalletService.debit(
      userId,
      amount,
      'bet_stake',
      `Crash game bet`,
      { game: 'crash', amount }
    );

    const roundId = uuidv4();
    const round: CrashRound = {
      userId,
      amount,
      crashPoint: generateCrashPoint(),
      startTime: Date.now(),
      cashedOut: false,
    };

    // Store round in Redis — TTL 10 minutes
    await redis.set(ROUND_KEY(roundId), JSON.stringify(round), 'EX', 600);

    return sendSuccess(res, {
      round_id: roundId,
      new_balance: result.new_balance,
    });
  } catch (err: any) {
    return sendError(res, err.message ?? 'Failed to place bet', 400);
  }
});

// POST /api/crash/cashout
// Validate timing server-side, credit wallet with winnings
router.post('/cashout', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { round_id } = req.body;

  if (!round_id) return sendError(res, 'round_id required', 400);

  const raw = await redis.get(ROUND_KEY(round_id));
  if (!raw) return sendError(res, 'Round not found or expired', 404);

  let round: CrashRound;
  try {
    round = JSON.parse(raw);
  } catch {
    return sendError(res, 'Invalid round data', 500);
  }

  if (round.userId !== userId) return sendError(res, 'Round does not belong to you', 403);
  if (round.cashedOut) return sendError(res, 'Already cashed out', 409);

  const elapsed = Date.now() - round.startTime;
  const currentMultiplier = multiplierAtTime(elapsed);

  // Reject if the round already crashed
  if (currentMultiplier >= round.crashPoint) {
    // Record loss in history, clean up round
    await redis.lpush(HISTORY_KEY, round.crashPoint.toFixed(2));
    await redis.ltrim(HISTORY_KEY, 0, 49);
    await redis.del(ROUND_KEY(round_id));
    return sendError(res, `Crashed at ${round.crashPoint.toFixed(2)}x before cashout`, 422);
  }

  const winAmount = parseFloat((round.amount * currentMultiplier).toFixed(2));

  try {
    const result = await WalletService.credit(
      userId,
      winAmount,
      'bet_win',
      undefined,
      undefined,
      `Crash game win at ${currentMultiplier.toFixed(2)}x`,
      { game: 'crash', round_id, multiplier: currentMultiplier, stake: round.amount }
    );

    // Mark cashed out and update Redis
    round.cashedOut = true;
    round.cashoutMultiplier = currentMultiplier;
    await redis.set(ROUND_KEY(round_id), JSON.stringify(round), 'EX', 60);

    return sendSuccess(res, {
      cashout_multiplier: currentMultiplier,
      win_amount: winAmount,
      new_balance: result.new_balance,
    });
  } catch (err: any) {
    return sendError(res, err.message ?? 'Cashout failed', 500);
  }
});

// POST /api/crash/round-end
// Called by frontend when the round ends (crash point reached)
// Records crash point in history for display purposes
router.post('/round-end', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { round_id } = req.body;

  if (!round_id) return sendError(res, 'round_id required', 400);

  const raw = await redis.get(ROUND_KEY(round_id));
  if (!raw) return sendSuccess(res, { recorded: false });

  let round: CrashRound;
  try {
    round = JSON.parse(raw);
  } catch {
    return sendError(res, 'Invalid round data', 500);
  }

  if (round.userId !== userId) return sendError(res, 'Forbidden', 403);

  // Record crash point in history
  await redis.lpush(HISTORY_KEY, round.crashPoint.toFixed(2));
  await redis.ltrim(HISTORY_KEY, 0, 49);
  await redis.del(ROUND_KEY(round_id));

  return sendSuccess(res, { recorded: true, crash_point: round.crashPoint });
});

// GET /api/crash/history
// Returns the last 20 crash points
router.get('/history', async (_req: Request, res: Response) => {
  const items = await redis.lrange(HISTORY_KEY, 0, 19);
  const history = items.map(v => parseFloat(v));
  return sendSuccess(res, { history });
});

export default router;
