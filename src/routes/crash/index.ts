import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { authenticate } from '../../middleware/auth';
import { WalletService } from '../../services/walletService';
import { redis } from '../../config/redis';
import { env } from '../../config/env';
import { sendSuccess, sendError } from '../../utils/response';

const router = Router();
const GROWTH_RATE = 0.08; // must match frontend

function generateCrashPoint(): number {
  const r = Math.random();
  if (r < 0.04) return 1.0;
  return Math.max(1.01, parseFloat((0.96 / (1 - r)).toFixed(2)));
}

interface RoundPayload {
  uid: string;   // userId
  amt: number;   // stake
  cp: number;    // crash point
  st: number;    // startTime (ms epoch)
  jti: string;   // unique round id for double-cashout guard
}

// POST /api/crash/bet
// Debit wallet, return a signed token containing the crash point & start time.
// No Redis storage — the token IS the round state.
router.post('/bet', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { amount } = req.body;

  if (typeof amount !== 'number' || amount < 1 || amount > 100_000) {
    return sendError(res, 'Bet amount must be between 1 and 100,000', 400);
  }

  try {
    const debitResult = await WalletService.debit(
      userId, amount, 'bet_stake',
      'Crash game stake',
      { game: 'crash' }
    );

    const payload: RoundPayload = {
      uid: userId,
      amt: amount,
      cp: generateCrashPoint(),
      st: Date.now(),
      jti: uuidv4(),
    };

    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '10m' });

    // Best-effort history write (failure doesn't break the game)
    redis.lpush('crash:history', payload.cp.toFixed(2)).catch(() => {});
    redis.ltrim('crash:history', 0, 49).catch(() => {});

    return sendSuccess(res, {
      round_token: token,
      crash_point: payload.cp,
      start_time: payload.st,
      new_balance: debitResult.new_balance,
    });
  } catch (err: any) {
    return sendError(res, err.message ?? 'Failed to place bet', 400);
  }
});

// POST /api/crash/cashout
// Verify the signed token, recalculate multiplier from elapsed time, credit wallet.
router.post('/cashout', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { round_token } = req.body;

  if (!round_token) return sendError(res, 'round_token required', 400);

  let round: RoundPayload;
  try {
    round = jwt.verify(round_token, env.JWT_SECRET) as RoundPayload;
  } catch {
    return sendError(res, 'Invalid or expired round token', 400);
  }

  if (round.uid !== userId) return sendError(res, 'Token does not belong to you', 403);

  // Double-cashout guard — best-effort; proceed if Redis is unavailable
  const usedKey = `crash:used:${round.jti}`;
  try {
    const alreadyUsed = await redis.get(usedKey);
    if (alreadyUsed) return sendError(res, 'Already cashed out', 409);
  } catch { /* Redis down — skip guard */ }

  const elapsedSec = (Date.now() - round.st) / 1000;
  const multiplier = parseFloat(Math.exp(GROWTH_RATE * elapsedSec).toFixed(2));

  if (multiplier >= round.cp) {
    return sendError(res, `Crashed at ${round.cp.toFixed(2)}x before cashout`, 422);
  }

  const winAmount = parseFloat((round.amt * multiplier).toFixed(2));

  try {
    const creditResult = await WalletService.credit(
      userId, winAmount, 'bet_win',
      undefined, undefined,
      `Crash game win at ${multiplier.toFixed(2)}x`,
      { game: 'crash', multiplier, stake: round.amt }
    );

    // Mark token as used (best-effort)
    redis.set(usedKey, '1', 'EX', 600).catch(() => {});

    return sendSuccess(res, {
      cashout_multiplier: multiplier,
      win_amount: winAmount,
      new_balance: creditResult.new_balance,
    });
  } catch (err: any) {
    return sendError(res, err.message ?? 'Cashout failed', 500);
  }
});

// GET /api/crash/history
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const items = await redis.lrange('crash:history', 0, 19);
    return sendSuccess(res, { history: items.map(v => parseFloat(v)) });
  } catch {
    return sendSuccess(res, { history: [] });
  }
});

export default router;
