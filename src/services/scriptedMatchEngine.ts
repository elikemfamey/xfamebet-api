import { supabase } from '../config/supabase';
import { getIO } from '../socket';
import { logger } from '../utils/logger';

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
  scriptEvents: ScriptEvent[];
  scriptStats: ScriptStats;
  declaredResult: 'home' | 'draw' | 'away' | null;
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

async function pushLiveOdds(state: MatchState) {
  const diff = state.scoreA - state.scoreB;
  const urgency = 1 + (state.minute / state.duration) * 0.5;

  let home = 1.90, draw = 3.20, away = 1.90;

  if (diff > 0) {
    home = Math.max(1.05, home - diff * 0.3 * urgency);
    away = Math.min(25,   away + diff * 0.5 * urgency);
    draw = Math.min(15,   draw + diff * 0.4);
  } else if (diff < 0) {
    away = Math.max(1.05, away + diff * 0.3 * urgency);
    home = Math.min(25,   home - diff * 0.5 * urgency);
    draw = Math.min(15,   draw - diff * 0.4);
  }

  const base = {
    event_id: `sim:${state.id}`,
    event_name: `${state.teamA} vs ${state.teamB}`,
    source: 'simulation',
    sport: state.sport,
    league: state.league,
    starts_at: state.startsAt,
    status: 'active',
    updated_at: new Date().toISOString(),
  };

  await supabase.from('odds_feed').upsert([
    { ...base, market_type: 'match_winner', selection: 'home', odds_value: +home.toFixed(2) },
    { ...base, market_type: 'match_winner', selection: 'draw', odds_value: +draw.toFixed(2) },
    { ...base, market_type: 'match_winner', selection: 'away', odds_value: +away.toFixed(2) },
  ], { onConflict: 'event_id,market_type,selection' });

  try {
    const io = getIO();
    io.emit('odds:update', {
      eventId: `sim:${state.id}`,
      updates: [
        { selection: 'home', odds_value: +home.toFixed(2) },
        { selection: 'draw', odds_value: +draw.toFixed(2) },
        { selection: 'away', odds_value: +away.toFixed(2) },
      ],
    });
  } catch {}
}

async function settleBets(matchId: string, result: string, scoreA: number, scoreB: number) {
  const eventId = `sim:${matchId}`;

  const { data: pending } = await supabase
    .from('bets')
    .select('id, user_id, stake, potential_payout, bet_type')
    .eq('status', 'pending');

  if (!pending?.length) return;

  for (const bet of pending) {
    const { data: selections } = await supabase
      .from('bet_selections')
      .select('*')
      .eq('bet_id', bet.id)
      .eq('event_id', eventId);

    if (!selections?.length) continue;

    for (const sel of selections) {
      let won = false;
      if (sel.market_type === 'match_winner') {
        won = (sel.selection === 'home' && result === 'team_a') ||
              (sel.selection === 'away' && result === 'team_b') ||
              (sel.selection === 'draw'  && result === 'draw');
      } else if (sel.market_type === 'over_under') {
        const total = scoreA + scoreB;
        won = (sel.selection === 'over_2.5'  && total > 2.5) ||
              (sel.selection === 'under_2.5' && total <= 2.5);
      } else if (sel.market_type === 'btts') {
        won = (sel.selection === 'yes' && scoreA > 0 && scoreB > 0) ||
              (sel.selection === 'no'  && !(scoreA > 0 && scoreB > 0));
      }
      await supabase.from('bet_selections')
        .update({ status: won ? 'won' : 'lost' })
        .eq('id', sel.id);
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
    possession: { a: ss.final_possession_home ?? 50, b: 100 - (ss.final_possession_home ?? 50) },
    shots:    { a: 0, b: 0 },
    fouls:    { a: 0, b: 0 },
    corners:  { a: 0, b: 0 },
    yellowCards: { a: [], b: [] },
    redCards:    { a: [], b: [] },
    scriptEvents:    (match.script_events as ScriptEvent[]) ?? [],
    scriptStats:     ss,
    declaredResult:  (match.declared_result as 'home' | 'draw' | 'away' | null) ?? null,
  };
}

// ── Tick loop (shared by start + resume) ──────────────────────────────────────

function attachTick(matchId: string): NodeJS.Timeout {
  const interval = setInterval(async () => {
    const state = matchStates.get(matchId);
    if (!state) { clearInterval(interval); return; }

    state.minute++;

    // ── Fire scripted events for this minute ──────────────────────────────────
    const eventsNow = state.scriptEvents.filter(e => e.minute === state.minute);
    for (const ev of eventsNow) {
      const teamName = ev.team === 'home' ? state.teamA : state.teamB;
      const sideKey  = ev.team === 'home' ? 'a' : 'b';
      const player   = ev.player ?? '';

      if (ev.type === 'goal') {
        if (ev.team === 'home') state.scoreA++; else state.scoreB++;
        state.shots[sideKey]++;
        await supabase.from('simulated_matches')
          .update({ team_a_score: state.scoreA, team_b_score: state.scoreB })
          .eq('id', matchId);
      } else if (ev.type === 'yellow_card') {
        state.yellowCards[sideKey].push(player);
      } else if (ev.type === 'red_card') {
        state.redCards[sideKey].push(player);
      } else if (ev.type === 'foul') {
        state.fouls[sideKey]++;
      } else if (ev.type === 'corner') {
        state.corners[sideKey]++;
      }

      const scoreStr = `${state.scoreA}-${state.scoreB}`;
      await saveEvent(state, state.minute, ev.type, player, teamName,
        buildCommentary(ev, teamName, scoreStr),
        { score_a: state.scoreA, score_b: state.scoreB, assist: ev.assist, player_on: ev.player_on, player_off: ev.player_off });
    }

    // ── Interpolate background stats toward preset targets ────────────────────
    const { scriptStats: ss, minute: m, duration: d } = state;
    if (ss.final_shots_home)    state.shots.a   = interpStat(state.shots.a,   ss.final_shots_home,    m, d);
    if (ss.final_shots_away)    state.shots.b   = interpStat(state.shots.b,   ss.final_shots_away,    m, d);
    if (ss.final_fouls_home)    state.fouls.a   = interpStat(state.fouls.a,   ss.final_fouls_home,    m, d);
    if (ss.final_fouls_away)    state.fouls.b   = interpStat(state.fouls.b,   ss.final_fouls_away,    m, d);
    if (ss.final_corners_home)  state.corners.a = interpStat(state.corners.a, ss.final_corners_home,  m, d);
    if (ss.final_corners_away)  state.corners.b = interpStat(state.corners.b, ss.final_corners_away,  m, d);

    // Possession drifts ±3% around the target each minute
    const targetPoss = ss.final_possession_home ?? 50;
    state.possession.a = Math.min(80, Math.max(20, targetPoss + (Math.random() * 6 - 3)));
    state.possession.b = 100 - state.possession.a;

    // ── Broadcast live state ──────────────────────────────────────────────────
    try {
      const io = getIO();
      io.to(`match:${matchId}`).emit('match:state', {
        matchId,
        minute:    state.minute,
        scoreA:    state.scoreA,
        scoreB:    state.scoreB,
        possession: state.possession,
        shots:     state.shots,
        fouls:     state.fouls,
        corners:   state.corners,
      });
    } catch {}

    await pushLiveOdds(state);

    await supabase.from('simulated_matches').update({
      current_minute: state.minute,
      team_a_score:   state.scoreA,
      team_b_score:   state.scoreB,
    }).eq('id', matchId);

    // ── Milestone events ──────────────────────────────────────────────────────
    if (state.minute === 45) {
      await saveEvent(state, 45, 'halftime', '', '', 'Half-time! Teams head to the dressing room.');
    }

    if (state.minute >= state.duration) {
      clearInterval(interval);
      activeMatches.delete(matchId);

      // Use declared result when set; fall back to score comparison
      const declaredMap = { home: 'team_a', draw: 'draw', away: 'team_b' } as const;
      const result = state.declaredResult
        ? declaredMap[state.declaredResult]
        : state.scoreA > state.scoreB ? 'team_a'
        : state.scoreB > state.scoreA ? 'team_b'
        : 'draw';

      await saveEvent(state, state.duration, 'fulltime', '', '', "Full-time! The final whistle has been blown.");

      await supabase.from('simulated_matches').update({
        status:         'completed',
        result,
        current_minute: state.duration,
        ended_at:       new Date().toISOString(),
      }).eq('id', matchId);

      await supabase.from('odds_feed')
        .update({ status: 'settled' })
        .eq('event_id', `sim:${matchId}`)
        .eq('source', 'simulation');

      await settleBets(matchId, result, state.scoreA, state.scoreB);
      matchStates.delete(matchId);
      logger.info(`Scripted match ${matchId} ended: ${state.scoreA}-${state.scoreB} (${result})`);
    }
  }, 60_000); // real-time: 1 tick = 1 game minute

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
      const state = buildStateFromDb(match as Record<string, unknown>, (match as any).current_minute ?? 0);
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
      await supabase.from('simulated_matches')
        .update({ team_a_score: state.scoreA, team_b_score: state.scoreB })
        .eq('id', matchId);
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
    overrides?: { homeOdds?: number; drawOdds?: number; awayOdds?: number },
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

    const rows: object[] = [
      { ...base, market_type: 'match_winner', selection: 'home', odds_value: +home.toFixed(2) },
      { ...base, market_type: 'match_winner', selection: 'draw', odds_value: +draw.toFixed(2) },
      { ...base, market_type: 'match_winner', selection: 'away', odds_value: +away.toFixed(2) },
    ];

    if (markets.includes('over_under')) {
      rows.push(
        { ...base, market_type: 'over_under', selection: 'over_2.5',  odds_value: 1.85 },
        { ...base, market_type: 'over_under', selection: 'under_2.5', odds_value: 1.95 },
      );
    }
    if (markets.includes('btts')) {
      rows.push(
        { ...base, market_type: 'btts', selection: 'yes', odds_value: 1.75 },
        { ...base, market_type: 'btts', selection: 'no',  odds_value: 2.05 },
      );
    }

    await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
  }
}
