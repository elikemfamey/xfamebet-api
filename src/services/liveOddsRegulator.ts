/**
 * Poisson-based in-play odds regulator.
 *
 * Models expected remaining goals for each team using their strength ratio
 * and minutes left, then derives win/draw/loss probabilities by summing the
 * joint Poisson PMF over all reachable final scorelines.  Every market is
 * recalculated from first principles so odds move in a realistic, coherent way
 * as goals are scored and time drains.
 *
 * Bookmaker margin: 5 % overround applied uniformly — implied probs sum to 1.05.
 */

import { supabase } from '../config/supabase';
import { redis } from '../config/redis';
import { broadcastOddsUpdate } from '../socket';

// ── Constants ─────────────────────────────────────────────────────────────────

const MARGIN  = 1.05;   // 5 % bookmaker overround
const MIN_ODDS = 1.01;
const MAX_ODDS = 200;
const MAX_EXTRA_GOALS = 12; // max additional goals per team in Poisson grid

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Poisson PMF — iterative to avoid large factorial values */
function pPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p = (p * lambda) / i;
  return p;
}

/** Convert a true probability to bookmaker odds with margin */
function toOdds(prob: number): number {
  const p = Math.max(0.004, Math.min(0.99, prob));
  return parseFloat(
    Math.min(MAX_ODDS, Math.max(MIN_ODDS, 1 / (p * MARGIN))).toFixed(2),
  );
}

// ── Core probability models ───────────────────────────────────────────────────

/**
 * Compute win/draw/loss probabilities from current score + expected remaining
 * goals per team (independent Poisson, bivariate grid).
 */
function winProbs(
  scoreA: number, scoreB: number,
  lambdaA: number, lambdaB: number,
): { pA: number; pD: number; pB: number } {
  let pA = 0, pD = 0, pB = 0;

  for (let ha = 0; ha <= MAX_EXTRA_GOALS; ha++) {
    const pHA = pPmf(ha, lambdaA);
    if (pHA < 1e-9) continue;
    for (let hb = 0; hb <= MAX_EXTRA_GOALS; hb++) {
      const p = pHA * pPmf(hb, lambdaB);
      if (p < 1e-12) continue;
      const fA = scoreA + ha, fB = scoreB + hb;
      if      (fA > fB) pA += p;
      else if (fA === fB) pD += p;
      else               pB += p;
    }
  }

  const total = pA + pD + pB || 1;
  return { pA: pA / total, pD: pD / total, pB: pB / total };
}

/**
 * Over/Under: P(total remaining goals ≥ needed) vs P(< needed).
 * Once the threshold is already crossed the over is near-certain.
 */
function overUnder(currentTotal: number, threshold: number, lambdaTotal: number) {
  if (currentTotal > threshold) return { pOver: 0.995, pUnder: 0.005 };

  const needed = Math.floor(threshold) + 1 - currentTotal; // goals still required to go over
  let pUnder = 0;
  for (let k = 0; k < needed; k++) pUnder += pPmf(k, lambdaTotal);
  pUnder = Math.min(0.995, Math.max(0.005, pUnder));
  return { pOver: 1 - pUnder, pUnder };
}

/**
 * Both-teams-to-score: once both have scored it is locked YES.
 * If only one side has scored, the other side still needs to score in remaining time.
 */
function bttsProb(scoreA: number, scoreB: number, lambdaA: number, lambdaB: number): number {
  if (scoreA > 0 && scoreB > 0) return 0.99;
  if (scoreA > 0) return Math.max(0.005, 1 - pPmf(0, lambdaB));
  if (scoreB > 0) return Math.max(0.005, 1 - pPmf(0, lambdaA));
  return Math.max(0.005, (1 - pPmf(0, lambdaA)) * (1 - pPmf(0, lambdaB)));
}

/**
 * Distribution over exact total-goal bands.
 */
function totalGoalsExact(currentTotal: number, lambdaTotal: number) {
  let p01 = 0, p23 = 0, p4plus = 0;
  for (let r = 0; r <= 15; r++) {
    const p  = pPmf(r, lambdaTotal);
    const ft = currentTotal + r;
    if      (ft <= 1) p01   += p;
    else if (ft <= 3) p23   += p;
    else              p4plus += p;
  }
  return {
    p01:   Math.max(0.005, p01),
    p23:   Math.max(0.005, p23),
    p4plus: Math.max(0.005, p4plus),
  };
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface OddsContext {
  matchId: string;
  sport: string;
  league: string;
  startsAt: string;
  teamAName: string;
  teamBName: string;
  scoreA: number;
  scoreB: number;
  currentMinute: number;
  duration: number;
  /** Goals per minute for both teams combined — typically 0.03 */
  goalProb: number;
  teamAStrength: number;   // 1–10
  teamBStrength: number;   // 1–10
  /** Current match phase — drives half-time result locking */
  phase: string;
  firstScorerTeam: string | null;
}

/**
 * Recompute all live markets for a simulated match and push to DB + Socket.IO.
 * Safe to call on every tick (idempotent upsert).
 */
export async function regulateOdds(ctx: OddsContext): Promise<void> {
  const rows = buildOddsRows(ctx);
  if (rows.length === 0) return;

  await supabase
    .from('odds_feed')
    .upsert(rows, { onConflict: 'event_id,market_type,selection' });

  try {
    broadcastOddsUpdate(
      `sim:${ctx.matchId}`,
      rows.map(r => ({
        market_type: (r as any).market_type,
        selection:   (r as any).selection,
        odds_value:  (r as any).odds_value,
      })),
    );
    redis.del('live_feed:').catch(() => {});
    redis.del(`live_feed:${ctx.sport}`).catch(() => {});
  } catch {}
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildOddsRows(ctx: OddsContext): object[] {
  const {
    matchId, sport, league, startsAt, teamAName, teamBName,
    scoreA, scoreB, currentMinute, duration,
    goalProb, teamAStrength, teamBStrength,
    phase, firstScorerTeam,
  } = ctx;

  const totalStrength = Math.max(1, teamAStrength + teamBStrength);
  const minutesLeft   = Math.max(0, duration - currentMinute);

  // Expected goals in remaining time for each team
  const lambdaA     = goalProb * (teamAStrength / totalStrength) * minutesLeft;
  const lambdaB     = goalProb * (teamBStrength / totalStrength) * minutesLeft;
  const lambdaTotal = lambdaA + lambdaB;

  const base = {
    event_id:   `sim:${matchId}`,
    event_name: `${teamAName} vs ${teamBName}`,
    source:     'simulation',
    sport,
    league,
    starts_at:  startsAt,
    status:     'active',
    updated_at: new Date().toISOString(),
  };

  const rows: object[] = [];
  const push = (market_type: string, selection: string, odds_value: number) =>
    rows.push({ ...base, market_type, selection, odds_value });

  // ── 1. Match Winner (1X2) ─────────────────────────────────────────────────
  //
  //  - At 0-0 early: roughly even based on strengths
  //  - 1-0 at 80': home collapses toward 1.05–1.10, draw/away explode
  //  - 1-0 at 20': home ~1.55, draw ~3.60, away ~5.50 (comeback still possible)
  //  - 1-1 at 85': draw ~1.30, both teams ~5.00+
  //
  const { pA, pD, pB } = winProbs(scoreA, scoreB, lambdaA, lambdaB);
  push('match_winner', 'home', toOdds(pA));
  push('match_winner', 'draw', toOdds(pD));
  push('match_winner', 'away', toOdds(pB));

  // ── 2. Double Chance (derived) ────────────────────────────────────────────
  push('double_chance', 'home_or_draw', toOdds(pA + pD));
  push('double_chance', 'away_or_draw', toOdds(pB + pD));
  push('double_chance', 'home_or_away', toOdds(pA + pB));

  // ── 3. Over / Under ───────────────────────────────────────────────────────
  //
  //  - 0-0 at 75': over 2.5 becomes very long (5-8x), under shortens
  //  - 3-0 at 30': over 2.5 already locked at ~1.01
  //
  for (const threshold of [1.5, 2.5, 3.5]) {
    const { pOver, pUnder } = overUnder(scoreA + scoreB, threshold, lambdaTotal);
    const key = `${threshold}`.replace('.', '_');
    push('over_under', `over_${key}`,  toOdds(pOver));
    push('over_under', `under_${key}`, toOdds(pUnder));
  }

  // ── 4. BTTS ───────────────────────────────────────────────────────────────
  const pBtts = bttsProb(scoreA, scoreB, lambdaA, lambdaB);
  push('btts', 'yes', toOdds(pBtts));
  push('btts', 'no',  toOdds(1 - pBtts));

  // ── 5. Total Goals Exact ──────────────────────────────────────────────────
  const { p01, p23, p4plus } = totalGoalsExact(scoreA + scoreB, lambdaTotal);
  push('total_goals_exact', '0_1',   toOdds(p01));
  push('total_goals_exact', '2_3',   toOdds(p23));
  push('total_goals_exact', '4plus', toOdds(p4plus));

  // ── 6. Clean Sheet ────────────────────────────────────────────────────────
  //  Home clean sheet: B must score 0 more goals. If B already scored → impossible.
  const pCleanHome = scoreB === 0 ? Math.max(0.005, pPmf(0, lambdaB)) : 0.005;
  const pCleanAway = scoreA === 0 ? Math.max(0.005, pPmf(0, lambdaA)) : 0.005;
  push('clean_sheet_home', 'yes', toOdds(pCleanHome));
  push('clean_sheet_home', 'no',  toOdds(1 - pCleanHome));
  push('clean_sheet_away', 'yes', toOdds(pCleanAway));
  push('clean_sheet_away', 'no',  toOdds(1 - pCleanAway));

  // ── 7. Anytime Scorer ─────────────────────────────────────────────────────
  //  Once the team has scored → locked YES. Otherwise P(X_team ≥ 1).
  const pAScores = scoreA > 0 ? 0.99 : Math.max(0.005, 1 - pPmf(0, lambdaA));
  const pBScores = scoreB > 0 ? 0.99 : Math.max(0.005, 1 - pPmf(0, lambdaB));
  push('anytime_score_home', 'yes', toOdds(pAScores));
  push('anytime_score_home', 'no',  toOdds(1 - pAScores));
  push('anytime_score_away', 'yes', toOdds(pBScores));
  push('anytime_score_away', 'no',  toOdds(1 - pBScores));

  // ── 8. First Team to Score ────────────────────────────────────────────────
  //  Once anyone has scored this market is settled — stop moving the odds.
  if (firstScorerTeam === null) {
    const pAtLeast1 = 1 - pPmf(0, lambdaTotal);
    const pAFirst   = lambdaTotal > 0 ? (lambdaA / lambdaTotal) * pAtLeast1 : 0;
    const pBFirst   = lambdaTotal > 0 ? (lambdaB / lambdaTotal) * pAtLeast1 : 0;
    const pNoGoal   = Math.max(0.005, pPmf(0, lambdaTotal));
    push('first_team_to_score', 'home',    toOdds(Math.max(0.005, pAFirst)));
    push('first_team_to_score', 'away',    toOdds(Math.max(0.005, pBFirst)));
    push('first_team_to_score', 'no_goal', toOdds(pNoGoal));
  }

  // ── 9. Half-time Result ───────────────────────────────────────────────────
  //  Only relevant while first half is still running.
  //  Uses only the remaining first-half minutes for lambda, not the full game.
  if (phase === 'first_half' || phase === 'halftime_extra') {
    const htLeft   = Math.max(0, Math.floor(duration / 2) - currentMinute);
    const lA_ht    = goalProb * (teamAStrength / totalStrength) * htLeft;
    const lB_ht    = goalProb * (teamBStrength / totalStrength) * htLeft;
    const { pA: htA, pD: htD, pB: htB } = winProbs(scoreA, scoreB, lA_ht, lB_ht);
    push('half_time_result', 'home', toOdds(htA));
    push('half_time_result', 'draw', toOdds(htD));
    push('half_time_result', 'away', toOdds(htB));
  }

  return rows;
}
