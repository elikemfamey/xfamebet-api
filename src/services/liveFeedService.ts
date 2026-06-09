import { supabase } from '../config/supabase';
import { getCachedLiveScores, LiveScore } from './liveScoreService';
import { getAllCachedOddsApiScores, OddsApiScoreEntry } from './oddsApiScoreService';

export interface LiveFeedTeam {
  name: string;
  logoUrl: string | null;
}

export interface LiveFeedMatch {
  eventId: string;
  oddsEventId: string | null;
  league: string;
  sport: string;
  isLive: boolean;
  status: string;
  home: LiveFeedTeam;
  away: LiveFeedTeam;
  homeScore: string | null;
  awayScore: string | null;
  odds: [string | number, string | number, string | number];
  oddsLocked: boolean;
  markets: number;
  sportKey: string;
  kickedOffAt: string | null;
}

// API-Football in-play status codes
const IN_PLAY_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT']);

function deriveApiFbStatus(s: LiveScore): string {
  switch (s.status_short) {
    case 'HT': return 'HT';
    case 'BT': return 'BT';
    case 'FT': case 'AET': case 'PEN': return 'FT';
    case 'P': return 'PEN';
    default: return s.minute > 0 ? `${s.minute}'` : 'LIVE';
  }
}

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
}

function teamsMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

interface OddsRow {
  event_id: string;
  event_name: string;
  market_type: string;
  selection: string;
  odds_value: number;
  sport: string;
  league: string | null;
  starts_at: string | null;
  status: string;
}

function formatKickoff(isoString: string): string {
  const d = new Date(isoString);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month}/${day} ${hh}:${mm}`;
}

function extractH2H(rows: OddsRow[]) {
  const h2h = rows.filter(r => r.market_type === 'match_winner');
  const suspended = h2h.some(r => r.status === 'suspended');
  return {
    homeOdds: h2h.find(r => r.selection === 'home')?.odds_value,
    drawOdds: h2h.find(r => r.selection === 'draw')?.odds_value,
    awayOdds: h2h.find(r => r.selection === 'away')?.odds_value,
    markets: rows.filter(r => r.market_type !== 'match_winner').length,
    suspended,
  };
}

function getScore(entry: OddsApiScoreEntry, side: 'home' | 'away'): string | null {
  if (!entry.scores) return null;
  const teamName = side === 'home' ? entry.home_team : entry.away_team;
  return entry.scores.find(s => s.name === teamName)?.score ?? null;
}

export async function buildLiveFeed(sport?: string): Promise<LiveFeedMatch[]> {
  const now = new Date();

  const [apiFbScores, oddsApiScores, oddsResult, scriptedResult] = await Promise.all([
    getCachedLiveScores(),
    getAllCachedOddsApiScores(),
    supabase
      .from('odds_feed')
      .select('event_id, event_name, market_type, selection, odds_value, sport, league, starts_at, status')
      .in('status', ['active', 'suspended'])
      .not('sport', 'ilike', 'virtual_%')
      .order('updated_at', { ascending: false })
      .limit(1000),
    supabase
      .from('simulated_matches')
      .select('id, team_a, team_b, team_a_score, team_b_score, current_minute, sport, competition, league_name, home_logo, away_logo, started_at')
      .eq('status', 'live'),
  ]);

  const allOdds: OddsRow[] = oddsResult.data ?? [];

  // Group odds by event_id
  const byEvent = new Map<string, OddsRow[]>();
  for (const row of allOdds) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push(row);
    byEvent.set(row.event_id, list);
  }

  const result: LiveFeedMatch[] = [];
  const processedEventIds = new Set<string>();

  // ── Step 1: Odds API scores — live events for ALL sports ────────────────────
  // This covers basketball, tennis, baseball, MMA, etc. as well as football.
  for (const [eventId, scoreData] of oddsApiScores) {
    // Skip completed events (don't show finished games in live feed)
    if (scoreData.completed) continue;
    // Skip events that haven't started yet (no scores means not kicked off)
    if (!scoreData.scores) continue;

    const rows = byEvent.get(eventId) ?? [];
    if (!rows.length) continue; // no odds on file for this event

    const first = rows[0];
    const eventSport = first.sport;

    if (sport && eventSport !== sport) continue;

    processedEventIds.add(eventId);

    const { homeOdds, drawOdds, awayOdds, markets } = extractH2H(rows);
    const homeScore = getScore(scoreData, 'home');
    const awayScore = getScore(scoreData, 'away');

    // For football, try to enrich with API-Football for minute elapsed + logos
    let statusStr = 'LIVE';
    let homeLogo: string | null = null;
    let awayLogo: string | null = null;

    if (eventSport === 'football') {
      const apiFb = apiFbScores.find(s =>
        IN_PLAY_STATUSES.has(s.status_short) &&
        teamsMatch(s.home_team, scoreData.home_team) &&
        teamsMatch(s.away_team, scoreData.away_team),
      );
      if (apiFb) {
        statusStr = deriveApiFbStatus(apiFb);
        homeLogo = apiFb.home_logo;
        awayLogo = apiFb.away_logo;
      }
    }

    result.push({
      eventId,
      oddsEventId: eventId,
      league: first.league ?? 'Other',
      sport: eventSport,
      isLive: true,
      status: statusStr,
      home: { name: scoreData.home_team, logoUrl: homeLogo },
      away: { name: scoreData.away_team, logoUrl: awayLogo },
      homeScore,
      awayScore,
      odds: [homeOdds ?? '-', drawOdds ?? '-', awayOdds ?? '-'],
      oddsLocked: homeOdds == null && awayOdds == null,
      markets,
      sportKey: scoreData.sport_key,
      kickedOffAt: first.starts_at ?? null,
    });
  }

  // ── Step 2: API-Football live football matches not already covered ───────────
  // Useful for football games that kicked off but whose Odds API score isn't cached yet.
  if (!sport || sport === 'football') {
    for (const score of apiFbScores) {
      if (!IN_PLAY_STATUSES.has(score.status_short)) continue;

      // Find matching odds event by team name fuzzy match
      let matchedRows: OddsRow[] = [];
      let matchedEventId: string | null = null;

      for (const [eid, rows] of byEvent) {
        if (processedEventIds.has(eid)) continue;
        const first = rows[0];
        if (first.sport !== 'football') continue;
        if (!first.event_name.includes(' vs ')) continue;
        const [oddsHome, oddsAway] = first.event_name.split(' vs ').map((s: string) => s.trim());
        if (teamsMatch(score.home_team, oddsHome) && teamsMatch(score.away_team, oddsAway)) {
          matchedRows = rows;
          matchedEventId = eid;
          break;
        }
      }

      if (matchedEventId) processedEventIds.add(matchedEventId);

      const { homeOdds, drawOdds, awayOdds, markets } = extractH2H(matchedRows);

      result.push({
        eventId: `af:${score.fixture_id}`,
        oddsEventId: matchedEventId,
        league: score.league,
        sport: 'football',
        isLive: true,
        status: deriveApiFbStatus(score),
        home: { name: score.home_team, logoUrl: score.home_logo },
        away: { name: score.away_team, logoUrl: score.away_logo },
        homeScore: String(score.home_score),
        awayScore: String(score.away_score),
        odds: [homeOdds ?? '-', drawOdds ?? '-', awayOdds ?? '-'],
        oddsLocked: homeOdds == null,
        markets,
        sportKey: 'api-football',
        kickedOffAt: null,
      });
    }
  }

  // ── Step 3: Scripted live matches ────────────────────────────────────────────
  for (const match of scriptedResult.data ?? []) {
    const scriptEventId = `sim:${match.id}`;
    if (sport && match.sport !== sport) continue;

    const matchOddsRows = byEvent.get(scriptEventId) ?? [];
    processedEventIds.add(scriptEventId);

    const { homeOdds, drawOdds, awayOdds, markets, suspended } = extractH2H(matchOddsRows);
    const minuteLabel = (match.current_minute ?? 0) > 0 ? `${match.current_minute}'` : 'LIVE';

    result.push({
      eventId: scriptEventId,
      oddsEventId: scriptEventId,
      league: match.competition ?? match.league_name ?? 'XfameBet League',
      sport: match.sport ?? 'football',
      isLive: true,
      status: minuteLabel,
      home: { name: match.team_a, logoUrl: match.home_logo ?? null },
      away: { name: match.team_b, logoUrl: match.away_logo ?? null },
      homeScore: String(match.team_a_score ?? 0),
      awayScore: String(match.team_b_score ?? 0),
      odds: [homeOdds ?? '-', drawOdds ?? '-', awayOdds ?? '-'],
      oddsLocked: suspended || homeOdds == null,
      markets,
      sportKey: match.sport ?? 'football',
      kickedOffAt: match.started_at ?? null,
    });
  }

  // ── Step 4: Fallback — odds_feed events past their start time with no score data ─
  // These are games where Odds API hasn't provided scores yet but the game has started.
  for (const [eventId, rows] of byEvent) {
    if (processedEventIds.has(eventId)) continue;

    const first = rows[0];
    if (!first.starts_at) continue;
    if (new Date(first.starts_at) > now) continue; // not started yet

    // If we have a score entry and it's completed, skip
    const scoreEntry = oddsApiScores.get(eventId);
    if (scoreEntry?.completed) continue;

    const eventSport = first.sport;
    if (sport && eventSport !== sport) continue;

    const { homeOdds, drawOdds, awayOdds, markets } = extractH2H(rows);
    const [homeName = first.event_name, awayName = ''] = first.event_name.includes(' vs ')
      ? first.event_name.split(' vs ').map((s: string) => s.trim())
      : [first.event_name];

    result.push({
      eventId,
      oddsEventId: eventId,
      league: first.league ?? 'Other',
      sport: eventSport,
      isLive: true,
      status: formatKickoff(first.starts_at),
      home: { name: homeName, logoUrl: null },
      away: { name: awayName, logoUrl: null },
      homeScore: null,
      awayScore: null,
      odds: [homeOdds ?? '-', drawOdds ?? '-', awayOdds ?? '-'],
      oddsLocked: homeOdds == null && awayOdds == null,
      markets,
      sportKey: eventSport,
      kickedOffAt: first.starts_at,
    });
  }

  // Sort: events with actual scores first, then those with odds, then locked
  result.sort((a, b) => {
    const aHasScore = a.homeScore !== null ? 1 : 0;
    const bHasScore = b.homeScore !== null ? 1 : 0;
    if (bHasScore !== aHasScore) return bHasScore - aHasScore;
    const aLocked = a.oddsLocked ? 0 : 1;
    const bLocked = b.oddsLocked ? 0 : 1;
    return bLocked - aLocked;
  });

  return result;
}
