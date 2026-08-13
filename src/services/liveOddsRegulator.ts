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

const CS_STANDARD = [
  '0-0','1-0','0-1','1-1','2-0','0-2','2-1','1-2',
  '2-2','3-0','0-3','3-1','1-3','3-2','2-3','3-3',
  '4-0','0-4','4-1','1-4','4-2','2-4',
];

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

/** Public display probabilities use the exact same Poisson model as 1X2 odds. */
export function calculateWinProbabilities(ctx: Pick<OddsContext, 'scoreA' | 'scoreB' | 'currentMinute' | 'duration' | 'goalProb' | 'teamAStrength' | 'teamBStrength'>) {
  const strength = Math.max(1, ctx.teamAStrength + ctx.teamBStrength);
  const minutesLeft = Math.max(0, ctx.duration - ctx.currentMinute);
  const lambdaA = ctx.goalProb * (ctx.teamAStrength / strength) * minutesLeft;
  const lambdaB = ctx.goalProb * (ctx.teamBStrength / strength) * minutesLeft;
  const { pA, pD, pB } = winProbs(ctx.scoreA, ctx.scoreB, lambdaA, lambdaB);
  const home = Math.round(pA * 100);
  const draw = Math.round(pD * 100);
  return { home, draw, away: 100 - home - draw };
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

/**
 * Correct score: iterate the bivariate Poisson grid to get probability mass
 * for each reachable final scoreline from the current live score.
 * Scores no longer reachable (needs fewer total goals than already scored) get
 * MAX_ODDS. Non-standard scorelines are bundled into 'other'.
 */
function correctScoreOdds(
  scoreA: number, scoreB: number,
  lambdaA: number, lambdaB: number,
): { selection: string; odds_value: number }[] {
  const probs: Record<string, number> = {};

  for (let ha = 0; ha <= MAX_EXTRA_GOALS; ha++) {
    const pHA = pPmf(ha, lambdaA);
    if (pHA < 1e-9) continue;
    for (let hb = 0; hb <= MAX_EXTRA_GOALS; hb++) {
      const p = pHA * pPmf(hb, lambdaB);
      if (p < 1e-12) continue;
      const key = `${scoreA + ha}-${scoreB + hb}`;
      probs[key] = (probs[key] ?? 0) + p;
    }
  }

  const stdSet = new Set(CS_STANDARD);
  let otherProb = 0;
  for (const [key, p] of Object.entries(probs)) {
    if (!stdSet.has(key)) otherProb += p;
  }

  const result: { selection: string; odds_value: number }[] = [];
  for (const s of CS_STANDARD) {
    const p = probs[s] ?? 0;
    result.push({ selection: s, odds_value: p > 1e-9 ? toOdds(p) : MAX_ODDS });
  }
  result.push({ selection: 'other', odds_value: otherProb > 1e-9 ? toOdds(otherProb) : MAX_ODDS });

  return result;
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface OddsContext {
  matchId: string;
  /** Optional canonical id for real-provider fallback events. */
  eventId?: string;
  source?: string;
  isLive?: boolean;
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

  // Close markets that are decided or overwhelmingly certain. Admin locks are preserved.
  const eventId = ctx.eventId ?? `sim:${ctx.matchId}`;
  const locks: Array<{ market: string; reason: string }> = [];
  if (ctx.firstScorerTeam) locks.push({ market: 'first_team_to_score', reason: 'First goal has been scored' });
  if (!['first_half', 'halftime_extra'].includes(ctx.phase)) locks.push({ market: 'half_time_result', reason: 'Half-time market is closed' });
  const byMarket = new Map<string, any[]>();
  for (const row of rows as any[]) byMarket.set(row.market_type, [...(byMarket.get(row.market_type) ?? []), row]);
  for (const [market, entries] of byMarket) {
    const leading = Math.min(...entries.map(entry => entry.odds_value));
    const impliedProbability = 1 / (leading * MARGIN);
    if (impliedProbability >= 0.95) locks.push({ market, reason: 'Outcome probability is at least 95%' });
  }
  for (const lock of locks) {
    await supabase.from('odds_feed').update({ status: 'suspended', lock_reason: lock.reason })
      .eq('event_id', eventId).eq('market_type', lock.market).eq('locked_by_admin', false).eq('status', 'active');
  }

  // Broadcast the persisted rows (including market state and lock reason), not
  // only the calculated prices. This keeps every client market in sync.
  const { data: persistedRows } = await supabase.from('odds_feed')
    .select('id, event_id, market_type, selection, odds_value, status, lock_reason')
    .eq('event_id', eventId)
    .in('status', ['active', 'suspended']);

  try {
    broadcastOddsUpdate(
      eventId,
      persistedRows ?? [],
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
    event_id:   ctx.eventId ?? `sim:${matchId}`,
    event_name: `${teamAName} vs ${teamBName}`,
    source:     ctx.source ?? 'simulation',
    is_live:    ctx.isLive ?? false,
    provider_updated_at: ctx.isLive ? new Date().toISOString() : undefined,
    sport,
    league,
    starts_at:  startsAt,
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

  // ── 10. Correct Score ─────────────────────────────────────────────────────
  //  Poisson-derived odds for every standard scoreline plus an 'other' bucket.
  //  Impossible scorelines (already past) are set to MAX_ODDS.
  for (const { selection, odds_value } of correctScoreOdds(scoreA, scoreB, lambdaA, lambdaB)) {
    push('correct_score', selection, odds_value);
  }

  return rows;
}

export type FootballEstimateInput = {
  eventId: string; home: string; away: string; league: string; startsAt: string;
  isLive: boolean; homeScore?: number; awayScore?: number; minute?: number;
};

/**
 * Produces the same complete market catalogue used by virtual football, but
 * never persists it. Consumers must present these rows as suspended estimates.
 */
export function estimateFootballMarkets(input: FootballEstimateInput): Array<Record<string, unknown>> {
  const hash = (value: string) => {
    let result = 2166136261;
    for (const character of value.toLowerCase()) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
    return result >>> 0;
  };
  const scoreA = input.homeScore ?? 0;
  const scoreB = input.awayScore ?? 0;
  const minute = Math.max(0, Math.min(90, input.minute ?? 0));
  const rows = buildOddsRows({
    matchId: input.eventId, eventId: input.eventId, source: 'estimate', isLive: input.isLive,
    sport: 'football', league: input.league, startsAt: input.startsAt, teamAName: input.home, teamBName: input.away,
    scoreA, scoreB, currentMinute: minute, duration: 90, goalProb: 2.55 / 90,
    teamAStrength: 6 + hash(input.home) % 5, teamBStrength: 6 + hash(input.away) % 5,
    phase: !input.isLive || minute <= 45 ? 'first_half' : 'second_half',
    firstScorerTeam: scoreA > 0 ? 'home' : scoreB > 0 ? 'away' : null,
  }) as Array<Record<string, unknown>>;
  const lockReason = 'Estimated prices — betting is suspended until a verified provider price is available.';
  return rows.map(row => ({ ...row, status: 'suspended', lock_reason: lockReason, estimated: true }));
}
