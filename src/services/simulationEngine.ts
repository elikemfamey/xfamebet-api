import { supabase } from '../config/supabase';
import { getIO, broadcastBetWon, broadcastWalletUpdate, broadcastOddsUpdate } from '../socket';
import { redis } from '../config/redis';
import { WalletService } from './walletService';
import { logger } from '../utils/logger';

interface MatchState {
  id: string;
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  minute: number;
  duration: number;
  goalProb: number;
  cardProb: number;
  teamAStrength: number;
  teamBStrength: number;
  league: string;
  sport: string;
  startsAt: string;
  possession: { a: number; b: number };
  shots: { a: number; b: number };
  fouls: { a: number; b: number };
  yellowCards: { a: string[]; b: string[] };
  redCards: { a: string[]; b: string[] };
  momentum: number[];
  // Phase tracking for halftime / injury time
  phase: 'first_half' | 'halftime_extra' | 'halftime_break' | 'second_half' | 'fulltime_extra';
  extraTimeMinute: number;
  htExtraTotal: number;
  htBreakTicksLeft: number;
  ftExtraTotal: number;
  halftimeScoreA: number;
  halftimeScoreB: number;
  firstScorerTeam: 'a' | 'b' | null;
}

const activeMatches = new Map<string, NodeJS.Timeout>();
const matchStates = new Map<string, MatchState>();

const PLAYER_NAMES = {
  football: ['Santos', 'García', 'Silva', 'Müller', 'Kane', 'Mbappe', 'Saka', 'Salah', 'Vinicius', 'Bellingham', 'Griezmann', 'Modrić'],
  basketball: ['Johnson', 'Williams', 'Brown', 'Davis', 'Thomas', 'Harris', 'Walker', 'Jones', 'Robinson', 'Martin'],
};

const COMMENTARY_TEMPLATES = {
  goal: [
    '{player} finds the net! {team} score! {score}',
    'GOAL! {player} with a brilliant finish! {score}',
    '{player} converts and {team} take the lead! {score}',
    'What a strike from {player}! {team} are on the scoreboard! {score}',
  ],
  miss: [
    '{player} fires wide! Close miss for {team}.',
    'Great save! Keeper denies {player}.',
    '{player} hits the post! {team} were so close.',
    'Headed over by {player}. {team} frustrated.',
  ],
  yellow_card: [
    '{player} receives a yellow card for {team}.',
    'Referee shows yellow to {player} of {team}.',
    'Caution! {player} is booked.',
  ],
  red_card: [
    '{player} is sent off! {team} are down to 10 men!',
    'Red card! {player} walks off after a terrible challenge.',
  ],
  foul: [
    'Foul by {player}. Free kick awarded.',
    '{player} brings down the attacker. {team} penalized.',
  ],
  corner: [
    'Corner kick for {team}.',
    '{team} win a corner. {player} to take it.',
  ],
  kickoff: ['Kick off! The match has started.', 'And we are underway!'],
  halftime: ['Half-time! Teams head to the dressing room.'],
  fulltime: ['Full-time! The final whistle has been blown.', "That's it! The match is over."],
  pressure: ['{team} building pressure now.', '{team} dominating possession.'],
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatCommentary(template: string, player: string, team: string, score?: string): string {
  return template.replace('{player}', player).replace('{team}', team).replace('{score}', score ?? '');
}

export class SimulationEngine {
  static async startMatch(matchId: string) {
    const { data: match } = await supabase.from('simulated_matches').select('*').eq('id', matchId).single();
    if (!match) return;

    const state: MatchState = {
      id: matchId,
      teamA: match.team_a,
      teamB: match.team_b,
      scoreA: 0,
      scoreB: 0,
      minute: 0,
      duration: match.duration_minutes ?? 90,
      goalProb: match.goal_probability ?? 0.03,
      cardProb: match.card_probability ?? 0.05,
      teamAStrength: match.team_a_strength ?? 5,
      teamBStrength: match.team_b_strength ?? 5,
      league: (match as any).competition ?? match.league_name ?? 'XfameBet Virtual League',
      sport: match.sport ?? 'virtual_football',
      startsAt: match.scheduled_at ?? new Date().toISOString(),
      possession: { a: 50, b: 50 },
      shots: { a: 0, b: 0 },
      fouls: { a: 0, b: 0 },
      yellowCards: { a: [], b: [] },
      redCards: { a: [], b: [] },
      momentum: [0],
      phase: 'first_half',
      extraTimeMinute: 0,
      htExtraTotal: Math.floor(Math.random() * 2) + 1,
      htBreakTicksLeft: 15,
      ftExtraTotal: Math.floor(Math.random() * 9) + 1,
      halftimeScoreA: 0,
      halftimeScoreB: 0,
      firstScorerTeam: null,
    };

    matchStates.set(matchId, state);
    await SimulationEngine.emitEvent(state, 0, 'kickoff', '', '', pickRandom(COMMENTARY_TEMPLATES.kickoff));

    const interval = setInterval(async () => {
      const s = matchStates.get(matchId);
      if (!s) { clearInterval(interval); return; }

      // ── Halftime break: hold at HT status ──────────────────────────────────
      if (s.phase === 'halftime_break') {
        s.htBreakTicksLeft--;
        if (s.htBreakTicksLeft <= 0) {
          s.phase = 'second_half';
          s.extraTimeMinute = 0;
          await SimulationEngine.emitEvent(s, s.minute + 1, 'kickoff', '', '', 'The second half is underway!');
        }
        SimulationEngine.broadcastMatchState(s, 'HT');
        return;
      }

      // ── Halftime extra time: show 45+1, 45+2 … ────────────────────────────
      if (s.phase === 'halftime_extra') {
        s.extraTimeMinute++;
        await SimulationEngine.updateLiveOdds(s);
        await SimulationEngine.processMinute(s);
        SimulationEngine.broadcastMatchState(s, `45+${s.extraTimeMinute}`);
        await supabase.from('simulated_matches').update({ current_minute: 45, team_a_score: s.scoreA, team_b_score: s.scoreB }).eq('id', matchId);
        if (s.extraTimeMinute >= s.htExtraTotal) {
          s.phase = 'halftime_break';
          s.halftimeScoreA = s.scoreA;
          s.halftimeScoreB = s.scoreB;
          await SimulationEngine.emitEvent(s, 45, 'halftime', '', '', pickRandom(COMMENTARY_TEMPLATES.halftime));
        }
        return;
      }

      // ── Fulltime extra time: show 90+1 … 90+N ─────────────────────────────
      if (s.phase === 'fulltime_extra') {
        s.extraTimeMinute++;
        await SimulationEngine.updateLiveOdds(s);
        await SimulationEngine.processMinute(s);
        SimulationEngine.broadcastMatchState(s, `90+${s.extraTimeMinute}`);
        await supabase.from('simulated_matches').update({ current_minute: 90, team_a_score: s.scoreA, team_b_score: s.scoreB }).eq('id', matchId);
        if (s.extraTimeMinute >= s.ftExtraTotal) {
          clearInterval(interval);
          activeMatches.delete(matchId);
          await SimulationEngine.handleFulltime(matchId, s);
        }
        return;
      }

      // ── Normal minute tick ─────────────────────────────────────────────────
      s.minute++;
      await SimulationEngine.updateLiveOdds(s);
      await SimulationEngine.processMinute(s);
      SimulationEngine.broadcastMatchState(s, `${s.minute}'`);

      await supabase.from('simulated_matches').update({
        current_minute: s.minute,
        team_a_score: s.scoreA,
        team_b_score: s.scoreB,
      }).eq('id', matchId);

      // Transition: end of first half → halftime extra time
      if (s.minute === Math.floor(s.duration / 2) && s.phase === 'first_half') {
        s.phase = 'halftime_extra';
        s.extraTimeMinute = 0;
      }

      // Transition: end of second half → fulltime extra time
      if (s.minute >= s.duration && s.phase === 'second_half') {
        s.phase = 'fulltime_extra';
        s.extraTimeMinute = 0;
      }
    }, 60_000);

    activeMatches.set(matchId, interval);
  }

  private static async handleFulltime(matchId: string, state: MatchState) {
    const result = state.scoreA > state.scoreB ? 'team_a'
      : state.scoreB > state.scoreA ? 'team_b' : 'draw';

    await supabase.from('simulated_matches').update({
      status: 'completed', result,
      team_a_score: state.scoreA, team_b_score: state.scoreB,
      current_minute: state.duration, ended_at: new Date().toISOString(),
    }).eq('id', matchId);

    await SimulationEngine.emitEvent(state, state.duration, 'fulltime', '', '',
      pickRandom(COMMENTARY_TEMPLATES.fulltime));

    await supabase.from('odds_feed').update({ status: 'settled' })
      .eq('event_id', `sim:${matchId}`).eq('source', 'simulation');

    await SimulationEngine.settleBets(matchId, result, state.scoreA, state.scoreB);
    matchStates.delete(matchId);
    logger.info(`Match ${matchId} completed: ${state.scoreA}-${state.scoreB}`);
  }

  private static broadcastMatchState(state: MatchState, status: string) {
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
      });
    } catch {}
  }

  static stopMatch(matchId: string) {
    const interval = activeMatches.get(matchId);
    if (interval) {
      clearInterval(interval);
      activeMatches.delete(matchId);
      matchStates.delete(matchId);
    }
  }

  static pauseMatch(matchId: string) {
    const interval = activeMatches.get(matchId);
    if (interval) {
      clearInterval(interval);
      activeMatches.delete(matchId);
      // Keep matchStates so state is preserved on resume
    }
  }

  static resumeMatch(matchId: string) {
    const state = matchStates.get(matchId);
    if (!state) return;
    // Re-attach the same phase-aware interval
    const interval = setInterval(async () => {
      const s = matchStates.get(matchId);
      if (!s) { clearInterval(interval); return; }

      if (s.phase === 'halftime_break') {
        s.htBreakTicksLeft--;
        if (s.htBreakTicksLeft <= 0) {
          s.phase = 'second_half';
          s.extraTimeMinute = 0;
          await SimulationEngine.emitEvent(s, s.minute + 1, 'kickoff', '', '', 'The second half is underway!');
        }
        SimulationEngine.broadcastMatchState(s, 'HT');
        return;
      }
      if (s.phase === 'halftime_extra') {
        s.extraTimeMinute++;
        await SimulationEngine.updateLiveOdds(s);
        await SimulationEngine.processMinute(s);
        SimulationEngine.broadcastMatchState(s, `45+${s.extraTimeMinute}`);
        await supabase.from('simulated_matches').update({ current_minute: 45, team_a_score: s.scoreA, team_b_score: s.scoreB }).eq('id', matchId);
        if (s.extraTimeMinute >= s.htExtraTotal) {
          s.phase = 'halftime_break';
          s.halftimeScoreA = s.scoreA;
          s.halftimeScoreB = s.scoreB;
          await SimulationEngine.emitEvent(s, 45, 'halftime', '', '', pickRandom(COMMENTARY_TEMPLATES.halftime));
        }
        return;
      }
      if (s.phase === 'fulltime_extra') {
        s.extraTimeMinute++;
        await SimulationEngine.updateLiveOdds(s);
        await SimulationEngine.processMinute(s);
        SimulationEngine.broadcastMatchState(s, `90+${s.extraTimeMinute}`);
        await supabase.from('simulated_matches').update({ current_minute: 90, team_a_score: s.scoreA, team_b_score: s.scoreB }).eq('id', matchId);
        if (s.extraTimeMinute >= s.ftExtraTotal) {
          clearInterval(interval);
          activeMatches.delete(matchId);
          await SimulationEngine.handleFulltime(matchId, s);
        }
        return;
      }
      s.minute++;
      await SimulationEngine.updateLiveOdds(s);
      await SimulationEngine.processMinute(s);
      SimulationEngine.broadcastMatchState(s, `${s.minute}'`);
      await supabase.from('simulated_matches').update({ current_minute: s.minute, team_a_score: s.scoreA, team_b_score: s.scoreB }).eq('id', matchId);
      if (s.minute === Math.floor(s.duration / 2) && s.phase === 'first_half') {
        s.phase = 'halftime_extra'; s.extraTimeMinute = 0;
      }
      if (s.minute >= s.duration && s.phase === 'second_half') {
        s.phase = 'fulltime_extra'; s.extraTimeMinute = 0;
      }
    }, 60_000);
    activeMatches.set(matchId, interval);
  }

  static overrideScore(matchId: string, homeScore: number, awayScore: number) {
    const state = matchStates.get(matchId);
    if (state) {
      state.scoreA = homeScore;
      state.scoreB = awayScore;
    }
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
    customCommentary?: string,
  ) {
    const state = matchStates.get(matchId);
    if (!state) return;

    const teamName = team === 'home' ? state.teamA : state.teamB;
    const player = playerName ?? pickRandom(PLAYER_NAMES.football);

    if (eventType === 'goal') {
      if (team === 'home') state.scoreA++;
      else state.scoreB++;
      await supabase.from('simulated_matches')
        .update({ team_a_score: state.scoreA, team_b_score: state.scoreB })
        .eq('id', matchId);
    }

    const fallbackTemplate: Record<string, string[]> = {
      goal: COMMENTARY_TEMPLATES.goal,
      yellow_card: COMMENTARY_TEMPLATES.yellow_card,
      foul: COMMENTARY_TEMPLATES.foul,
      corner: COMMENTARY_TEMPLATES.corner,
    };
    const commentary = customCommentary
      ?? formatCommentary(pickRandom(fallbackTemplate[eventType] ?? COMMENTARY_TEMPLATES.foul), player, teamName,
        `${state.scoreA}-${state.scoreB}`);

    await SimulationEngine.emitEvent(state, state.minute, eventType, player, teamName, commentary);
  }

  static async applyGoalOddsShock(state: MatchState, scoringTeam: 'a' | 'b') {
    const boost = Math.random() < 0.3 ? 5 : 2;
    const { data: odds } = await supabase
      .from('odds_feed').select('selection, odds_value')
      .eq('event_id', `sim:${state.id}`).eq('market_type', 'match_winner');

    const homeOdds = odds?.find(o => o.selection === 'home')?.odds_value ?? 1.90;
    const awayOdds = odds?.find(o => o.selection === 'away')?.odds_value ?? 1.90;

    const newHome = scoringTeam === 'a'
      ? parseFloat(Math.max(1.05, homeOdds - 0.15).toFixed(2))
      : parseFloat(Math.min(50, homeOdds + boost).toFixed(2));
    const newAway = scoringTeam === 'b'
      ? parseFloat(Math.max(1.05, awayOdds - 0.15).toFixed(2))
      : parseFloat(Math.min(50, awayOdds + boost).toFixed(2));

    await supabase.from('odds_feed')
      .update({ odds_value: newHome })
      .eq('event_id', `sim:${state.id}`).eq('market_type', 'match_winner').eq('selection', 'home');
    await supabase.from('odds_feed')
      .update({ odds_value: newAway })
      .eq('event_id', `sim:${state.id}`).eq('market_type', 'match_winner').eq('selection', 'away');

    broadcastOddsUpdate(`sim:${state.id}`, [
      { selection: 'home', odds_value: newHome },
      { selection: 'away', odds_value: newAway },
    ]);
    redis.del('live_feed:').catch(() => {});
    redis.del(`live_feed:${state.sport}`).catch(() => {});
  }

  static async processMinute(state: MatchState) {
    const { goalProb, cardProb } = state;
    const totalStrength = state.teamAStrength + state.teamBStrength;
    const teamAGoalWeight = state.teamAStrength / totalStrength;

    // Determine if a goal happens
    const goalRoll = Math.random();
    if (goalRoll < goalProb) {
      const teamAScores = Math.random() < teamAGoalWeight;
      const scoringTeam = teamAScores ? 'a' : 'b';
      const teamName = teamAScores ? state.teamA : state.teamB;
      const player = pickRandom(PLAYER_NAMES.football);

      if (teamAScores) state.scoreA++;
      else state.scoreB++;
      state.shots[scoringTeam]++;
      if (state.firstScorerTeam === null) state.firstScorerTeam = scoringTeam;

      const scoreStr = `${state.scoreA}-${state.scoreB}`;
      const commentary = formatCommentary(pickRandom(COMMENTARY_TEMPLATES.goal), player, teamName, scoreStr);
      await SimulationEngine.emitEvent(state, state.minute, 'goal', player, teamName, commentary, {
        score_a: state.scoreA, score_b: state.scoreB,
      });
      await SimulationEngine.applyGoalOddsShock(state, scoringTeam);
    } else if (goalRoll < goalProb * 2) {
      // Shot off target
      const teamAShots = Math.random() < teamAGoalWeight;
      const teamName = teamAShots ? state.teamA : state.teamB;
      const player = pickRandom(PLAYER_NAMES.football);
      state.shots[teamAShots ? 'a' : 'b']++;
      const commentary = formatCommentary(pickRandom(COMMENTARY_TEMPLATES.miss), player, teamName);
      await SimulationEngine.emitEvent(state, state.minute, 'shot', player, teamName, commentary);
    }

    // Yellow card
    if (Math.random() < cardProb * 0.5) {
      const teamA = Math.random() > 0.5;
      const teamName = teamA ? state.teamA : state.teamB;
      const player = pickRandom(PLAYER_NAMES.football);
      const key = teamA ? 'a' : 'b';
      state.yellowCards[key].push(player);
      const commentary = formatCommentary(pickRandom(COMMENTARY_TEMPLATES.yellow_card), player, teamName);
      await SimulationEngine.emitEvent(state, state.minute, 'yellow_card', player, teamName, commentary);
    }

    // Foul
    if (Math.random() < 0.12) {
      const teamA = Math.random() > 0.5;
      const teamName = teamA ? state.teamA : state.teamB;
      const player = pickRandom(PLAYER_NAMES.football);
      state.fouls[teamA ? 'a' : 'b']++;
      const commentary = formatCommentary(pickRandom(COMMENTARY_TEMPLATES.foul), player, teamName);
      await SimulationEngine.emitEvent(state, state.minute, 'foul', player, teamName, commentary);
    }

    // Update possession (drift based on strength)
    const possessionDrift = (state.teamAStrength - state.teamBStrength) * 0.5;
    state.possession.a = Math.min(80, Math.max(20, 50 + possessionDrift + (Math.random() * 10 - 5)));
    state.possession.b = 100 - state.possession.a;

    // Update momentum
    const momentumValue = (state.scoreA - state.scoreB) * 20 + (state.shots.a - state.shots.b) * 5;
    state.momentum.push(Math.min(100, Math.max(-100, momentumValue)));
  }

  static async emitEvent(
    state: MatchState, minute: number, eventType: string,
    player: string, team: string, commentary: string,
    extra?: Record<string, unknown>
  ) {
    const { data: event } = await supabase.from('match_events').insert({
      simulation_id: state.id, minute, event_type: eventType, player, team, commentary,
      score_a: state.scoreA, score_b: state.scoreB, metadata: extra,
    }).select().single();

    try {
      const io = getIO();
      io.to(`match:${state.id}`).emit('match:event', event);
      io.emit('simulation:event', { matchId: state.id, event });
    } catch {}
  }

  static async updateLiveOdds(state: MatchState) {
    const scoreDiff = state.scoreA - state.scoreB;
    const minuteProgress = state.minute / state.duration;
    const urgencyFactor = 1 + minuteProgress * 0.5;

    let teamAWinOdds = 1.5 + (state.teamBStrength / state.teamAStrength) * 0.5;
    let drawOdds = 3.2;
    let teamBWinOdds = 1.5 + (state.teamAStrength / state.teamBStrength) * 0.5;

    // Adjust for current score
    if (scoreDiff > 0) {
      teamAWinOdds = Math.max(1.05, teamAWinOdds - scoreDiff * 0.3 * urgencyFactor);
      teamBWinOdds = Math.min(25, teamBWinOdds + scoreDiff * 0.5 * urgencyFactor);
      drawOdds = Math.min(15, drawOdds + scoreDiff * 0.4);
    } else if (scoreDiff < 0) {
      teamBWinOdds = Math.max(1.05, teamBWinOdds + scoreDiff * 0.3 * urgencyFactor);
      teamAWinOdds = Math.min(25, teamAWinOdds - scoreDiff * 0.5 * urgencyFactor);
      drawOdds = Math.min(15, drawOdds - scoreDiff * 0.4);
    }

    const updates = [
      { selection: 'home', odds_value: parseFloat(teamAWinOdds.toFixed(2)) },
      { selection: 'draw', odds_value: parseFloat(drawOdds.toFixed(2)) },
      { selection: 'away', odds_value: parseFloat(teamBWinOdds.toFixed(2)) },
    ];

    for (const update of updates) {
      await supabase.from('odds_feed').upsert({
        event_id: `sim:${state.id}`,
        event_name: `${state.teamA} vs ${state.teamB}`,
        market_type: 'match_winner',
        selection: update.selection,
        odds_value: update.odds_value,
        source: 'simulation',
        sport: state.sport,
        league: state.league,
        starts_at: state.startsAt,
        status: 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'event_id,market_type,selection' });
    }

    try {
      broadcastOddsUpdate(`sim:${state.id}`, updates);
      // Bust live feed cache so the frontend gets fresh scores on next reload
      redis.del('live_feed:').catch(() => {});
      redis.del(`live_feed:${state.sport}`).catch(() => {});
    } catch {}
  }

  static async generateOdds(
    matchId: string,
    teamAStrength: number,
    teamBStrength: number,
    overrides?: { homeOdds?: number; drawOdds?: number; awayOdds?: number },
  ) {
    const teamAWinOdds = overrides?.homeOdds ?? parseFloat((1.5 + (teamBStrength / teamAStrength) * 0.5).toFixed(2));
    const drawOdds    = overrides?.drawOdds ?? 3.20;
    const teamBWinOdds = overrides?.awayOdds ?? parseFloat((1.5 + (teamAStrength / teamBStrength) * 0.5).toFixed(2));

    const { data: match } = await supabase
      .from('simulated_matches')
      .select('team_a, team_b, league_name, scheduled_at, sport')
      .eq('id', matchId)
      .single();
    if (!match) return;

    const league = (match as any).competition ?? match.league_name ?? 'XfameBet Virtual League';
    const startsAt = match.scheduled_at ?? new Date().toISOString();
    const sport = match.sport ?? 'virtual_football';
    const base = {
      event_id: `sim:${matchId}`,
      event_name: `${match.team_a} vs ${match.team_b}`,
      source: 'simulation',
      sport,
      league,
      starts_at: startsAt,
      status: 'active',
    };

    const htHome = parseFloat((teamAWinOdds * 0.95 + 0.5).toFixed(2));
    const htDraw = 2.80;
    const htAway = parseFloat((teamBWinOdds * 0.95 + 0.5).toFixed(2));
    const ftsFavour = Math.random() < 0.5 ? 'home' : 'away';
    const ftsHome = ftsFavour === 'home'
      ? parseFloat((teamAWinOdds * 0.85).toFixed(2))
      : parseFloat((teamBWinOdds * 1.15).toFixed(2));
    const ftsAway = ftsFavour === 'away'
      ? parseFloat((teamBWinOdds * 0.85).toFixed(2))
      : parseFloat((teamAWinOdds * 1.15).toFixed(2));

    await supabase.from('odds_feed').upsert([
      // Match result
      { ...base, market_type: 'match_winner',       selection: 'home',          odds_value: parseFloat(teamAWinOdds.toFixed(2)) },
      { ...base, market_type: 'match_winner',       selection: 'draw',          odds_value: parseFloat(drawOdds.toFixed(2)) },
      { ...base, market_type: 'match_winner',       selection: 'away',          odds_value: parseFloat(teamBWinOdds.toFixed(2)) },
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
      { ...base, market_type: 'half_time_result',   selection: 'draw',          odds_value: htDraw },
      { ...base, market_type: 'half_time_result',   selection: 'away',          odds_value: htAway },
      // Double chance
      { ...base, market_type: 'double_chance',      selection: 'home_or_draw',  odds_value: parseFloat(Math.max(1.10, teamAWinOdds * 0.55).toFixed(2)) },
      { ...base, market_type: 'double_chance',      selection: 'away_or_draw',  odds_value: parseFloat(Math.max(1.10, teamBWinOdds * 0.55).toFixed(2)) },
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
    ], { onConflict: 'event_id,market_type,selection' });
  }

  static async getMatchStats(matchId: string) {
    const state = matchStates.get(matchId);
    const { data: match } = await supabase.from('simulated_matches').select('*').eq('id', matchId).single();
    const { data: events } = await supabase.from('match_events').select('event_type').eq('simulation_id', matchId);

    const goalEvents = events?.filter(e => e.event_type === 'goal') ?? [];
    const foulEvents = events?.filter(e => e.event_type === 'foul') ?? [];
    const shotEvents = events?.filter(e => e.event_type === 'shot') ?? [];

    return {
      match,
      stats: state ? {
        possession: state.possession,
        shots: state.shots,
        fouls: state.fouls,
        yellow_cards: state.yellowCards,
        red_cards: state.redCards,
        momentum: state.momentum,
      } : null,
      events_count: { goals: goalEvents.length, fouls: foulEvents.length, shots: shotEvents.length },
    };
  }

  static async generateHeatmap(matchId: string) {
    const { data: events } = await supabase.from('match_events').select('event_type, minute, metadata').eq('simulation_id', matchId);

    // Generate heatmap grid (10x10 zones)
    const zones: number[][] = Array.from({ length: 10 }, () => Array(10).fill(0));

    events?.forEach(event => {
      if (['goal', 'shot', 'foul'].includes(event.event_type)) {
        const x = Math.floor(Math.random() * 10);
        const y = Math.floor(Math.random() * 10);
        zones[y][x] += event.event_type === 'goal' ? 3 : 1;
      }
    });

    return { zones, intensity_scale: 'blue_to_cyan', max_intensity: Math.max(...zones.flat()) };
  }

  static async settleBets(matchId: string, result: string, scoreA: number, scoreB: number) {
    const eventId = `sim:${matchId}`;
    const finalScore = `${scoreA}-${scoreB}`;
    const totalGoals = scoreA + scoreB;

    // Determine first scorer from match events
    const { data: firstGoalEvent } = await supabase
      .from('match_events')
      .select('team')
      .eq('simulation_id', matchId)
      .eq('event_type', 'goal')
      .order('minute', { ascending: true })
      .limit(1)
      .single();
    const firstScorer = firstGoalEvent?.team ?? null;

    // Determine half-time score from match events (goals up to minute 45)
    const { data: htGoals } = await supabase
      .from('match_events')
      .select('team')
      .eq('simulation_id', matchId)
      .eq('event_type', 'goal')
      .lte('minute', 45);
    const liveState = matchStates.get(matchId);
    const htA = liveState?.halftimeScoreA ?? 0;
    const htB = liveState?.halftimeScoreB ?? 0;
    const htResult = htA > htB ? 'home' : htB > htA ? 'away' : 'draw';

    // Card/corner counts from events
    const { data: cardEvents } = await supabase
      .from('match_events').select('event_type').eq('simulation_id', matchId)
      .in('event_type', ['yellow_card', 'red_card']);
    const totalCards = cardEvents?.length ?? 0;

    const { data: cornerEvents } = await supabase
      .from('match_events').select('id').eq('simulation_id', matchId).eq('event_type', 'corner');
    const totalCorners = cornerEvents?.length ?? 0;

    const { data: pendingBets } = await supabase.from('bets')
      .select('id, user_id, stake, potential_payout, bet_type')
      .eq('status', 'pending');

    if (!pendingBets) return;

    for (const bet of pendingBets) {
      const { data: selections } = await supabase.from('bet_selections')
        .select('*').eq('bet_id', bet.id).eq('event_id', eventId);

      if (!selections || selections.length === 0) continue;

      // Settle each selection for this match
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
                (sel.selection === 'no' && !(scoreA > 0 && scoreB > 0));
        } else if (sel.market_type === 'first_team_to_score') {
          const mState = matchStates.get(matchId);
          if (sel.selection === 'no_goal') won = totalGoals === 0;
          else if (sel.selection === 'home') won = firstGoalEvent?.team === (mState?.teamA ?? '');
          else if (sel.selection === 'away') won = firstGoalEvent?.team === (mState?.teamB ?? '');
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

      // Check if ALL legs of this bet are now settled (handles accumulators across multiple matches)
      const { data: allSels } = await supabase.from('bet_selections')
        .select('status').eq('bet_id', bet.id);

      if (!allSels || allSels.some(s => s.status === 'pending')) continue;

      const betWon = allSels.every(s => s.status === 'won');
      const betStatus = betWon ? 'won' : 'lost';
      const payout = betWon ? bet.potential_payout : 0;

      await supabase.from('bets').update({
        status: betStatus,
        settled_at: new Date().toISOString(),
        payout,
        metadata: { finalScores: { [eventId]: finalScore } },
      }).eq('id', bet.id);

      if (betWon) {
        try {
          const { new_balance } = await WalletService.credit(bet.user_id, payout, 'bet_win', undefined, undefined, `Bet won - ${bet.id}`);
          broadcastWalletUpdate(bet.user_id, new_balance);
          broadcastBetWon(bet.user_id, { betId: bet.id, amount: payout, currency: 'GHS' });
        } catch (e) {
          logger.error('Failed to credit win payout', { betId: bet.id, error: e });
        }
      }
    }
  }
}
