import { supabase } from '../config/supabase';
import { getIO } from '../socket';
import { redis, REDIS_KEYS } from '../config/redis';
import { logger } from '../utils/logger';
import { regulateOdds, OddsContext } from './liveOddsRegulator';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScriptEventType =
  | 'goal' | 'yellow_card' | 'red_card' | 'foul' | 'corner'
  | 'substitution' | 'penalty_missed' | 'var_check' | 'offside';

export interface ScriptEvent {
  minute: number;
  type: ScriptEventType;
  team: 'home' | 'away';
  player?: string;
  player_off?: string;   // substitution: who comes off
  player_on?: string;    // substitution: who comes on
  assist?: string;
  commentary?: string;   // optional override; auto-generated when omitted
}

export interface ScriptStats {
  final_possession_home?: number;  // 20–80
  final_shots_home?: number;
  final_shots_away?: number;
  final_fouls_home?: number;
  final_fouls_away?: number;
  final_corners_home?: number;
  final_corners_away?: number;
}

interface MatchState {
  id: string;
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  minute: number;
  duration: number;
  league: string;
  sport: string;
  startsAt: string;
  homeLogo: string | null;
  awayLogo: string | null;
  possession: { a: number; b: number };
  shots: { a: number; b: number };
  fouls: { a: number; b: number };
  corners: { a: number; b: number };
  yellowCards: { a: string[]; b: string[] };
  redCards: { a: string[]; b: string[] };
  goalProb: number;
  teamAStrength: number;
  teamBStrength: number;
  scriptEvents: ScriptEvent[];
  scriptStats: ScriptStats;
  declaredResult: 'home' | 'draw' | 'away' | null;
  // Phase tracking
  phase: 'first_half' | 'halftime_extra' | 'halftime_break' | 'second_half' | 'fulltime_extra';
  extraTimeMinute: number;
  htExtraTotal: number;
  htBreakTicksLeft: number;
  ftExtraTotal: number;
  halftimeScoreA: number;
  halftimeScoreB: number;
  firstScorerTeam: string | null;
}

// ── In-memory maps ─────────────────────────────────────────────────────────────

const activeMatches = new Map<string, NodeJS.Timeout>();
const matchStates = new Map<string, MatchState>();

// ── Commentary builder ─────────────────────────────────────────────────────────

function buildCommentary(ev: ScriptEvent, teamName: string, score: string): string {
  if (ev.commentary) return ev.commentary;
  const p = ev.player ?? 'Player';
  switch (ev.type) {
    case 'goal':
      return ev.assist
        ? `GOAL! ${p} finishes from ${ev.assist}'s assist! ${teamName} score! ${score}`
        : `GOAL! ${p} finds the net for ${teamName}! ${score}`;
    case 'yellow_card':
      return `${p} is booked. Yellow card shown by the referee.`;
    case 'red_card':
      return `RED CARD! ${p} is sent off! ${teamName} are down to 10 men!`;
    case 'foul':
      return `Foul by ${p}. Free kick awarded.`;
    case 'corner':
      return `Corner kick for ${teamName}.`;
    case 'substitution':
      return `Substitution: ${ev.player_on ?? 'New player'} comes on for ${ev.player_off ?? p} (${teamName}).`;
    case 'penalty_missed':
      return `${p} misses the penalty! ${teamName} can't believe it.`;
    case 'var_check':
      return `VAR check underway. The referee is reviewing the decision.`;
    case 'offside':
      return `Offside! ${p} is flagged. ${teamName}'s attack is halted.`;
    default:
      return `${(ev.type as string).replace('_', ' ')} — ${teamName}.`;
  }
}

// ── Stat interpolation ─────────────────────────────────────────────────────────

function interpStat(current: number, target: number, minute: number, duration: number): number {
  return Math.max(current, Math.round(target * (minute / duration)));
}

// ── Shared helpers (DB + socket) ───────────────────────────────────────────────

async function saveEvent(
  state: MatchState,
  minute: number,
  eventType: string,
  player: string,
  team: string,
  commentary: string,
  extra?: Record<string, unknown>,
) {
  const { data: event } = await supabase.from('match_events').insert({
    simulation_id: state.id,
    minute,
    event_type: eventType,
    player,
    team,
    commentary,
    score_a: state.scoreA,
    score_b: state.scoreB,
    metadata: extra ?? {},
  }).select().single();

  try {
    const io = getIO();
    io.to(`match:${state.id}`).emit('match:event', event);
    io.emit('simulation:event', { matchId: state.id, event });
  } catch {}
}


async function settleBets(matchId: string, result: string, scoreA: number, scoreB: number) {
  const eventId = `sim:${matchId}`;
  const totalGoals = scoreA + scoreB;

  const { data: firstGoalEvent } = await supabase
    .from('match_events').select('team').eq('simulation_id', matchId).eq('event_type', 'goal')
    .order('minute', { ascending: true }).limit(1).single();

  const state = matchStates.get(matchId);
  const htA = state?.halftimeScoreA ?? 0;
  const htB = state?.halftimeScoreB ?? 0;
  const htResult = htA > htB ? 'home' : htB > htA ? 'away' : 'draw';

  const { data: cardEvents } = await supabase.from('match_events').select('event_type')
    .eq('simulation_id', matchId).in('event_type', ['yellow_card', 'red_card']);
  const totalCards = cardEvents?.length ?? 0;

  const { data: cornerEvents } = await supabase.from('match_events').select('id')
    .eq('simulation_id', matchId).eq('event_type', 'corner');
  const totalCorners = cornerEvents?.length ?? 0;

  const { data: pending } = await supabase.from('bets')
    .select('id, user_id, stake, potential_payout, bet_type').eq('status', 'pending');
  if (!pending?.length) return;

  for (const bet of pending) {
    const { data: selections } = await supabase.from('bet_selections')
      .select('*').eq('bet_id', bet.id).eq('event_id', eventId);
    if (!selections?.length) continue;

    for (const sel of selections) {
      let won = false;
      if (sel.market_type === 'match_winner') {
        won = (sel.selection === 'home' && result === 'team_a') ||
              (sel.selection === 'away' && result === 'team_b') ||
              (sel.selection === 'draw' && result === 'draw');
      } else if (sel.market_type === 'over_under') {
        if (sel.selection === 'over_1.5') won = totalGoals > 1.5;
        else if (sel.selection === 'under_1.5') won = totalGoals <= 1.5;
        else if (sel.selection === 'over_2.5') won = totalGoals > 2.5;
        else if (sel.selection === 'under_2.5') won = totalGoals <= 2.5;
        else if (sel.selection === 'over_3.5') won = totalGoals > 3.5;
        else if (sel.selection === 'under_3.5') won = totalGoals <= 3.5;
      } else if (sel.market_type === 'btts') {
        won = (sel.selection === 'yes' && scoreA > 0 && scoreB > 0) ||
              (sel.selection === 'no'  && !(scoreA > 0 && scoreB > 0));
      } else if (sel.market_type === 'first_team_to_score') {
        if (sel.selection === 'no_goal') won = totalGoals === 0;
        else if (sel.selection === 'home') won = firstGoalEvent?.team === (state?.teamA ?? '');
        else if (sel.selection === 'away') won = firstGoalEvent?.team === (state?.teamB ?? '');
      } else if (sel.market_type === 'half_time_result') {
        won = sel.selection === htResult;
      } else if (sel.market_type === 'double_chance') {
        if (sel.selection === 'home_or_draw') won = result === 'team_a' || result === 'draw';
        else if (sel.selection === 'away_or_draw') won = result === 'team_b' || result === 'draw';
        else if (sel.selection === 'home_or_away') won = result !== 'draw';
      } else if (sel.market_type === 'anytime_score_home') {
        won = sel.selection === 'yes' ? scoreA > 0 : scoreA === 0;
      } else if (sel.market_type === 'anytime_score_away') {
        won = sel.selection === 'yes' ? scoreB > 0 : scoreB === 0;
      } else if (sel.market_type === 'clean_sheet_home') {
        won = sel.selection === 'yes' ? scoreB === 0 : scoreB > 0;
      } else if (sel.market_type === 'clean_sheet_away') {
        won = sel.selection === 'yes' ? scoreA === 0 : scoreA > 0;
      } else if (sel.market_type === 'total_goals_exact') {
        if (sel.selection === '0_1') won = totalGoals <= 1;
        else if (sel.selection === '2_3') won = totalGoals === 2 || totalGoals === 3;
        else if (sel.selection === '4plus') won = totalGoals >= 4;
      } else if (sel.market_type === 'corners') {
        if (sel.selection === 'over_9.5') won = totalCorners > 9.5;
        else if (sel.selection === 'under_9.5') won = totalCorners <= 9.5;
      } else if (sel.market_type === 'cards') {
        if (sel.selection === 'over_3.5') won = totalCards > 3.5;
        else if (sel.selection === 'under_3.5') won = totalCards <= 3.5;
      }
      await supabase.from('bet_selections').update({ status: won ? 'won' : 'lost' }).eq('id', sel.id);
    }
  }
}

function buildStateFromDb(match: Record<string, unknown>, fromMinute: number): MatchState {
  const ss = (match.script_stats as ScriptStats) ?? {};
  return {
    id:       match.id as string,
    teamA:    match.team_a as string,
    teamB:    match.team_b as string,
    scoreA:   (match.team_a_score as number) ?? 0,
    scoreB:   (match.team_b_score as number) ?? 0,
    minute:   fromMinute,
    duration: (match.duration_minutes as number) ?? 90,
    league:   (match.competition as string) ?? (match.league_name as string) ?? 'XfameBet League',
    sport:    (match.sport as string) ?? 'football',
    startsAt: (match.scheduled_at as string) ?? new Date().toISOString(),
    homeLogo: (match.home_logo as string | null) ?? null,
    awayLogo: (match.away_logo as string | null) ?? null,
    goalProb:      (match.goal_probability as number) ?? 0.03,
    teamAStrength: (match.team_a_strength as number)  ?? 6,
    teamBStrength: (match.team_b_strength as number)  ?? 6,
    possession: { a: ss.final_possession_home ?? 50, b: 100 - (ss.final_possession_home ?? 50) },
    shots:    { a: 0, b: 0 },
    fouls:    { a: 0, b: 0 },
    corners:  { a: 0, b: 0 },
    yellowCards: { a: [], b: [] },
    redCards:    { a: [], b: [] },
    scriptEvents:    (match.script_events as ScriptEvent[]) ?? [],
    scriptStats:     ss,
    declaredResult:  (match.declared_result as 'home' | 'draw' | 'away' | null) ?? null,
    phase: fromMinute < Math.floor(((match.duration_minutes as number) ?? 90) / 2) ? 'first_half' : 'second_half',
    extraTimeMinute: 0,
    htExtraTotal: Math.floor(Math.random() * 2) + 1,
    htBreakTicksLeft: 15,
    ftExtraTotal: Math.floor(Math.random() * 9) + 1,
    halftimeScoreA: 0,
    halftimeScoreB: 0,
    firstScorerTeam: null,
  };
}

// ── Odds context builder ──────────────────────────────────────────────────────

function buildOddsContext(state: MatchState): OddsContext {
  return {
    matchId:       state.id,
    sport:         state.sport,
    league:        state.league,
    startsAt:      state.startsAt,
    teamAName:     state.teamA,
    teamBName:     state.teamB,
    scoreA:        state.scoreA,
    scoreB:        state.scoreB,
    currentMinute: state.minute,
    duration:      state.duration,
    goalProb:      state.goalProb,
    teamAStrength: state.teamAStrength,
    teamBStrength: state.teamBStrength,
    phase:         state.phase,
    firstScorerTeam: state.firstScorerTeam,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function broadcastMatchState(state: MatchState, status: string) {
  try {
    const io = getIO();
    io.to(`match:${state.id}`).emit('match:state', {
      matchId: state.id,
      minute: state.minute,
      extraTime: state.extraTimeMinute,
      status,
      scoreA: state.scoreA,
      scoreB: state.scoreB,
      possession: state.possession,
      shots: state.shots,
      fouls: state.fouls,
      corners: state.corners,
    });
    io.to(`match:${state.id}`).emit(`match:${state.id}:timer`, { timer: status });
    const matchStatus = status === 'HT' ? 'halftime'
      : /^\d+\+\d+$/.test(status) ? 'injury_time'
      : state.phase === 'second_half' ? 'second_half'
      : 'live';
    io.to(`match:${state.id}`).emit(`match:${state.id}:status`, { status: matchStatus });
  } catch {}
}


async function interpolateStats(state: MatchState) {
  const { scriptStats: ss, minute: m, duration: d } = state;
  if (ss.final_shots_home)   state.shots.a   = interpStat(state.shots.a,   ss.final_shots_home,   m, d);
  if (ss.final_shots_away)   state.shots.b   = interpStat(state.shots.b,   ss.final_shots_away,   m, d);
  if (ss.final_fouls_home)   state.fouls.a   = interpStat(state.fouls.a,   ss.final_fouls_home,   m, d);
  if (ss.final_fouls_away)   state.fouls.b   = interpStat(state.fouls.b,   ss.final_fouls_away,   m, d);
  if (ss.final_corners_home) state.corners.a = interpStat(state.corners.a, ss.final_corners_home, m, d);
  if (ss.final_corners_away) state.corners.b = interpStat(state.corners.b, ss.final_corners_away, m, d);
  const targetPoss = ss.final_possession_home ?? 50;
  state.possession.a = Math.min(80, Math.max(20, targetPoss + (Math.random() * 6 - 3)));
  state.possession.b = 100 - state.possession.a;
}

async function processScriptedMinute(state: MatchState, matchId: string) {
  const eventsNow = state.scriptEvents.filter(e => e.minute === state.minute);
  for (const ev of eventsNow) {
    const teamName = ev.team === 'home' ? state.teamA : state.teamB;
    const sideKey  = ev.team === 'home' ? 'a' : 'b';
    const player   = ev.player ?? '';
    if (ev.type === 'goal') {
      if (ev.team === 'home') state.scoreA++; else state.scoreB++;
      state.shots[sideKey]++;
      if (state.firstScorerTeam === null) state.firstScorerTeam = teamName;
      await supabase.from('simulated_matches')
        .update({ team_a_score: state.scoreA, team_b_score: state.scoreB }).eq('id', matchId);
      await regulateOdds(buildOddsContext(state));
    } else if (ev.type === 'yellow_card') { state.yellowCards[sideKey].push(player);
    } else if (ev.type === 'red_card')   { state.redCards[sideKey].push(player);
    } else if (ev.type === 'foul')       { state.fouls[sideKey]++;
    } else if (ev.type === 'corner')     { state.corners[sideKey]++;
    }
    const scoreStr = `${state.scoreA}-${state.scoreB}`;
    await saveEvent(state, state.minute, ev.type, player, teamName,
      buildCommentary(ev, teamName, scoreStr),
      { score_a: state.scoreA, score_b: state.scoreB, assist: ev.assist, player_on: ev.player_on, player_off: ev.player_off });
  }
  await interpolateStats(state);
}

async function handleScriptedFulltime(matchId: string, state: MatchState) {
  const declaredMap = { home: 'team_a', draw: 'draw', away: 'team_b' } as const;
  const result = state.declaredResult
    ? declaredMap[state.declaredResult]
    : state.scoreA > state.scoreB ? 'team_a' : state.scoreB > state.scoreA ? 'team_b' : 'draw';

  await saveEvent(state, state.duration, 'fulltime', '', '', 'Full-time! The final whistle has been blown.');
  await supabase.from('simulated_matches').update({
    status: 'completed', result, current_minute: state.duration, ended_at: new Date().toISOString(),
  }).eq('id', matchId);
  await supabase.from('odds_feed').update({ status: 'settled' })
    .eq('event_id', `sim:${matchId}`).eq('source', 'simulation');

  // Remove from sportsbook and live feed caches so the match disappears immediately
  await Promise.all([
    redis.del(REDIS_KEYS.ALL_ODDS),
    redis.del(REDIS_KEYS.LIVE_ODDS(`sim:${matchId}`)),
    redis.del('live_feed:'),
    redis.del(`live_feed:${state.sport}`),
  ]);
  try {
    const io = getIO();
    io.emit('simulation:completed', { matchId, result, scoreA: state.scoreA, scoreB: state.scoreB });
    io.to(`match:${matchId}`).emit(`match:${matchId}:timer`, { timer: 'FT' });
    io.to(`match:${matchId}`).emit(`match:${matchId}:status`, { status: 'fulltime' });
  } catch {}

  await settleBets(matchId, result, state.scoreA, state.scoreB);
  matchStates.delete(matchId);
  logger.info(`Scripted match ${matchId} ended: ${state.scoreA}-${state.scoreB} (${result})`);
}

// ── Tick loop (shared by start + resume) ──────────────────────────────────────

function attachTick(matchId: string): NodeJS.Timeout {
  const interval = setInterval(async () => {
    const state = matchStates.get(matchId);
    if (!state) { clearInterval(interval); return; }

    // ── Halftime break ────────────────────────────────────────────────────────
    if (state.phase === 'halftime_break') {
      state.htBreakTicksLeft--;
      if (state.htBreakTicksLeft <= 0) {
        state.phase = 'second_half';
        state.extraTimeMinute = 0;
        await saveEvent(state, state.minute + 1, 'kickoff', '', '', 'The second half is underway!');
      }
      broadcastMatchState(state, 'HT');
      return;
    }

    // ── Halftime extra time ───────────────────────────────────────────────────
    if (state.phase === 'halftime_extra') {
      state.extraTimeMinute++;
      await processScriptedMinute(state, matchId);
      await regulateOdds(buildOddsContext(state));
      broadcastMatchState(state, `45+${state.extraTimeMinute}`);
      await supabase.from('simulated_matches').update({ current_minute: 45, team_a_score: state.scoreA, team_b_score: state.scoreB }).eq('id', matchId);
      if (state.extraTimeMinute >= state.htExtraTotal) {
        state.phase = 'halftime_break';
        state.halftimeScoreA = state.scoreA;
        state.halftimeScoreB = state.scoreB;
        await saveEvent(state, 45, 'halftime', '', '', 'Half-time! Teams head to the dressing room.');
      }
      return;
    }

    // ── Fulltime extra time ───────────────────────────────────────────────────
    if (state.phase === 'fulltime_extra') {
      state.extraTimeMinute++;
      await processScriptedMinute(state, matchId);
      await regulateOdds(buildOddsContext(state));
      broadcastMatchState(state, `90+${state.extraTimeMinute}`);
      await supabase.from('simulated_matches').update({ current_minute: 90, team_a_score: state.scoreA, team_b_score: state.scoreB }).eq('id', matchId);
      if (state.extraTimeMinute >= state.ftExtraTotal) {
        clearInterval(interval);
        activeMatches.delete(matchId);
        await handleScriptedFulltime(matchId, state);
      }
      return;
    }

    // ── Normal minute ─────────────────────────────────────────────────────────
    state.minute++;
    await processScriptedMinute(state, matchId);
    await regulateOdds(buildOddsContext(state));
    broadcastMatchState(state, `${state.minute}'`);
    await supabase.from('simulated_matches').update({ current_minute: state.minute, team_a_score: state.scoreA, team_b_score: state.scoreB }).eq('id', matchId);

    // Transition: first half → halftime extra
    if (state.minute === Math.floor(state.duration / 2) && state.phase === 'first_half') {
      state.phase = 'halftime_extra';
      state.extraTimeMinute = 0;
    }

    // Transition: second half → fulltime extra
    if (state.minute >= state.duration && state.phase === 'second_half') {
      state.phase = 'fulltime_extra';
      state.extraTimeMinute = 0;
    }
  }, 60_000);

  return interval;
}

// ── Public engine API ─────────────────────────────────────────────────────────

export class ScriptedMatchEngine {

  static async startMatch(matchId: string) {
    const { data: match } = await supabase
      .from('simulated_matches')
      .select('*')
      .eq('id', matchId)
      .single();
    if (!match) return;

    const state = buildStateFromDb(match as Record<string, unknown>, 0);
    matchStates.set(matchId, state);

    await saveEvent(state, 0, 'kickoff', '', '', 'Kick off! The match has started.');

    const interval = attachTick(matchId);
    activeMatches.set(matchId, interval);
  }

  static pauseMatch(matchId: string) {
    const iv = activeMatches.get(matchId);
    if (iv) {
      clearInterval(iv);
      activeMatches.delete(matchId);
      // matchStates entry is kept so resume can continue from current minute
    }
  }

  static async resumeMatch(matchId: string) {
    // Reconstruct in-memory state from DB if the server restarted
    if (!matchStates.has(matchId)) {
      const { data: match } = await supabase
        .from('simulated_matches')
        .select('*')
        .eq('id', matchId)
        .single();
      if (!match) return;
      const duration = (match as any).duration_minutes ?? 90;
      const savedMinute = (match as any).current_minute ?? 0;
      // On crash recovery, calculate actual elapsed minutes from started_at so the
      // timer jumps to the correct position instead of replaying from the last saved tick.
      const startedAt = (match as any).started_at ? new Date((match as any).started_at).getTime() : null;
      const fromMinute = startedAt
        ? Math.min(Math.floor((Date.now() - startedAt) / 60_000), duration - 1)
        : savedMinute;
      const state = buildStateFromDb(match as Record<string, unknown>, fromMinute);
      matchStates.set(matchId, state);
    }
    const interval = attachTick(matchId);
    activeMatches.set(matchId, interval);
  }

  static stopMatch(matchId: string) {
    const iv = activeMatches.get(matchId);
    if (iv) clearInterval(iv);
    activeMatches.delete(matchId);
    matchStates.delete(matchId);
  }

  static overrideScore(matchId: string, homeScore: number, awayScore: number) {
    const state = matchStates.get(matchId);
    if (state) {
      state.scoreA = homeScore;
      state.scoreB = awayScore;
    }
  }

  static setDuration(matchId: string, duration: number) {
    const state = matchStates.get(matchId);
    if (state) state.duration = duration;
  }

  static setMinute(matchId: string, minute: number) {
    const state = matchStates.get(matchId);
    if (state) {
      state.minute = minute;
      if (minute < Math.floor(state.duration / 2)) state.phase = 'first_half';
      else if (minute < state.duration) state.phase = 'second_half';
    }
  }

  static async forceFulltime(matchId: string) {
    const interval = activeMatches.get(matchId);
    if (interval) {
      clearInterval(interval);
      activeMatches.delete(matchId);
    }

    let state = matchStates.get(matchId);
    if (!state) {
      const { data: match } = await supabase.from('simulated_matches').select('*').eq('id', matchId).single();
      if (!match) return;
      state = buildStateFromDb(match as Record<string, unknown>, (match as any).duration_minutes ?? 90);
      matchStates.set(matchId, state);
    }

    await handleScriptedFulltime(matchId, state);
  }

  static broadcastState(matchId: string) {
    const state = matchStates.get(matchId);
    if (!state) return;
    try {
      const io = getIO();
      io.to(`match:${matchId}`).emit('match:state', {
        matchId,
        minute: state.minute,
        scoreA: state.scoreA,
        scoreB: state.scoreB,
        possession: state.possession,
        shots: state.shots,
        fouls: state.fouls,
      });
    } catch {}
  }

  static async injectEvent(
    matchId: string,
    eventType: string,
    team: 'home' | 'away',
    playerName?: string,
    commentary?: string,
  ) {
    const state = matchStates.get(matchId);
    if (!state) return;

    const teamName = team === 'home' ? state.teamA : state.teamB;
    const sideKey  = team === 'home' ? 'a' : 'b';
    const player   = playerName ?? '';

    if (eventType === 'goal') {
      if (team === 'home') state.scoreA++; else state.scoreB++;
      state.shots[sideKey]++;
      if (state.firstScorerTeam === null) state.firstScorerTeam = teamName;
      await supabase.from('simulated_matches')
        .update({ team_a_score: state.scoreA, team_b_score: state.scoreB })
        .eq('id', matchId);
      await regulateOdds(buildOddsContext(state));
    }

    const scoreStr = `${state.scoreA}-${state.scoreB}`;
    const fakeEv: ScriptEvent = { minute: state.minute, type: eventType as ScriptEventType, team, player };
    await saveEvent(state, state.minute, eventType, player, teamName,
      commentary ?? buildCommentary(fakeEv, teamName, scoreStr),
      { score_a: state.scoreA, score_b: state.scoreB });
  }

  static getMatchState(matchId: string): MatchState | null {
    return matchStates.get(matchId) ?? null;
  }

  static isActive(matchId: string): boolean {
    return activeMatches.has(matchId);
  }

  static async generateOdds(
    matchId: string,
    overrides?: { homeOdds?: number; drawOdds?: number; awayOdds?: number; correctScoreOdds?: Record<string, number> },
  ) {
    const { data: match } = await supabase
      .from('simulated_matches')
      .select('team_a, team_b, competition, league_name, scheduled_at, sport, initial_home_odds, initial_draw_odds, initial_away_odds, markets')
      .eq('id', matchId)
      .single();
    if (!match) return;

    const home   = overrides?.homeOdds ?? (match as any).initial_home_odds ?? 1.90;
    const draw   = overrides?.drawOdds ?? (match as any).initial_draw_odds ?? 3.20;
    const away   = overrides?.awayOdds ?? (match as any).initial_away_odds ?? 1.90;
    const league = (match as any).competition ?? match.league_name ?? 'XfameBet League';
    const sport  = match.sport ?? 'football';
    const startsAt = match.scheduled_at ?? new Date().toISOString();
    const markets: string[] = (match as any).markets ?? ['match_winner', 'over_under', 'btts'];

    const base = {
      event_id:   `sim:${matchId}`,
      event_name: `${match.team_a} vs ${match.team_b}`,
      source:     'simulation',
      sport,
      league,
      starts_at:  startsAt,
      status:     'active',
      updated_at: new Date().toISOString(),
    };

    const ftsHome = parseFloat((home * 0.85).toFixed(2));
    const ftsAway = parseFloat((away * 0.85).toFixed(2));
    const htHome  = parseFloat((home * 0.95 + 0.5).toFixed(2));
    const htAway  = parseFloat((away * 0.95 + 0.5).toFixed(2));

    const rows: object[] = [
      // Match winner
      { ...base, market_type: 'match_winner',       selection: 'home',          odds_value: +home.toFixed(2) },
      { ...base, market_type: 'match_winner',       selection: 'draw',          odds_value: +draw.toFixed(2) },
      { ...base, market_type: 'match_winner',       selection: 'away',          odds_value: +away.toFixed(2) },
      // Over/Under
      { ...base, market_type: 'over_under',         selection: 'over_1.5',      odds_value: 1.30 },
      { ...base, market_type: 'over_under',         selection: 'under_1.5',     odds_value: 3.00 },
      { ...base, market_type: 'over_under',         selection: 'over_2.5',      odds_value: 1.85 },
      { ...base, market_type: 'over_under',         selection: 'under_2.5',     odds_value: 1.95 },
      { ...base, market_type: 'over_under',         selection: 'over_3.5',      odds_value: 2.50 },
      { ...base, market_type: 'over_under',         selection: 'under_3.5',     odds_value: 1.55 },
      // Both teams to score
      { ...base, market_type: 'btts',               selection: 'yes',           odds_value: 1.75 },
      { ...base, market_type: 'btts',               selection: 'no',            odds_value: 2.05 },
      // First team to score
      { ...base, market_type: 'first_team_to_score', selection: 'home',         odds_value: ftsHome },
      { ...base, market_type: 'first_team_to_score', selection: 'away',         odds_value: ftsAway },
      { ...base, market_type: 'first_team_to_score', selection: 'no_goal',      odds_value: 8.00 },
      // Half-time result
      { ...base, market_type: 'half_time_result',   selection: 'home',          odds_value: htHome },
      { ...base, market_type: 'half_time_result',   selection: 'draw',          odds_value: 2.80 },
      { ...base, market_type: 'half_time_result',   selection: 'away',          odds_value: htAway },
      // Double chance
      { ...base, market_type: 'double_chance',      selection: 'home_or_draw',  odds_value: parseFloat(Math.max(1.10, home * 0.55).toFixed(2)) },
      { ...base, market_type: 'double_chance',      selection: 'away_or_draw',  odds_value: parseFloat(Math.max(1.10, away * 0.55).toFixed(2)) },
      { ...base, market_type: 'double_chance',      selection: 'home_or_away',  odds_value: 1.25 },
      // Anytime scorer
      { ...base, market_type: 'anytime_score_home', selection: 'yes',           odds_value: 1.40 },
      { ...base, market_type: 'anytime_score_home', selection: 'no',            odds_value: 2.75 },
      { ...base, market_type: 'anytime_score_away', selection: 'yes',           odds_value: 1.45 },
      { ...base, market_type: 'anytime_score_away', selection: 'no',            odds_value: 2.65 },
      // Clean sheet
      { ...base, market_type: 'clean_sheet_home',   selection: 'yes',           odds_value: 2.30 },
      { ...base, market_type: 'clean_sheet_home',   selection: 'no',            odds_value: 1.60 },
      { ...base, market_type: 'clean_sheet_away',   selection: 'yes',           odds_value: 2.50 },
      { ...base, market_type: 'clean_sheet_away',   selection: 'no',            odds_value: 1.55 },
      // Total goals exact band
      { ...base, market_type: 'total_goals_exact',  selection: '0_1',           odds_value: 3.20 },
      { ...base, market_type: 'total_goals_exact',  selection: '2_3',           odds_value: 1.70 },
      { ...base, market_type: 'total_goals_exact',  selection: '4plus',         odds_value: 3.50 },
      // Corners
      { ...base, market_type: 'corners',            selection: 'over_9.5',      odds_value: 1.85 },
      { ...base, market_type: 'corners',            selection: 'under_9.5',     odds_value: 1.95 },
      // Cards
      { ...base, market_type: 'cards',              selection: 'over_3.5',      odds_value: 1.90 },
      { ...base, market_type: 'cards',              selection: 'under_3.5',     odds_value: 1.90 },
      // Correct score (inserted only when admin provides custom odds for this market)
      ...(overrides?.correctScoreOdds !== undefined
        ? Object.entries({
            '0-0': 7.00, '1-0': 5.50, '0-1': 7.00, '1-1': 5.00,
            '2-0': 8.00, '0-2': 10.00, '2-1': 7.00, '1-2': 9.00,
            '2-2': 12.00, '3-0': 14.00, '0-3': 18.00, '3-1': 12.00,
            '1-3': 16.00, '3-2': 20.00, '2-3': 25.00, '3-3': 35.00,
            '4-0': 30.00, '0-4': 40.00, '4-1': 35.00, '1-4': 45.00,
            '4-2': 45.00, '2-4': 55.00, 'other': 60.00,
            ...overrides.correctScoreOdds,
          }).map(([score, odds]) => ({
            ...base,
            market_type: 'correct_score',
            selection: score,
            odds_value: odds as number,
          }))
        : []),
    ];

    await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
  }
}
