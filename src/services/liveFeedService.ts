import { supabase } from '../config/supabase';
import { getCachedLiveScores, LiveScore } from './liveScoreService';

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

// API-Football status codes that indicate a match is actively in play
const IN_PLAY_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT']);

function deriveStatus(s: LiveScore): string {
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
}

function formatKickoffAsStatus(isoString: string): string {
  const d = new Date(isoString);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}`;
}

export async function buildLiveFeed(sport?: string): Promise<LiveFeedMatch[]> {
  const now = new Date().toISOString();

  const [liveScores, oddsResult, scriptedResult] = await Promise.all([
    getCachedLiveScores(),
    supabase
      .from('odds_feed')
      .select('event_id, event_name, market_type, selection, odds_value, sport, league, starts_at')
      .eq('status', 'active')
      .lte('starts_at', now)
      .not('sport', 'ilike', 'virtual_%')
      .order('updated_at', { ascending: false })
      .limit(500),
    supabase
      .from('simulated_matches')
      .select('id, team_a, team_b, team_a_score, team_b_score, current_minute, sport, competition, league_name, home_logo, away_logo, started_at')
      .eq('is_scripted', true)
      .eq('status', 'live'),
  ]);

  const allOdds: OddsRow[] = oddsResult.data ?? [];

  // Group odds rows by event_id
  const byEvent = new Map<string, OddsRow[]>();
  for (const row of allOdds) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push(row);
    byEvent.set(row.event_id, list);
  }

  const result: LiveFeedMatch[] = [];
  const matchedEventIds = new Set<string>();

  // 1. Process API-Football live matches (real scores, may or may not have odds)
  if (!sport || sport === 'football') {
    for (const score of liveScores) {
      if (!IN_PLAY_STATUSES.has(score.status_short)) continue;

      let matchedRows: OddsRow[] = [];
      let matchedEventId: string | null = null;

      for (const [eid, rows] of byEvent) {
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

      if (matchedEventId) matchedEventIds.add(matchedEventId);

      const h2h = matchedRows.filter(r => r.market_type === 'match_winner');
      const homeOdds = h2h.find(r => r.selection === 'home')?.odds_value;
      const drawOdds = h2h.find(r => r.selection === 'draw')?.odds_value;
      const awayOdds = h2h.find(r => r.selection === 'away')?.odds_value;
      const markets = matchedRows.filter(r => r.market_type !== 'match_winner').length;

      result.push({
        eventId: `af:${score.fixture_id}`,
        oddsEventId: matchedEventId,
        league: score.league,
        sport: 'football',
        isLive: true,
        status: deriveStatus(score),
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

  // 2. Scripted live matches — appear as real matches with live scores
  for (const match of scriptedResult.data ?? []) {
    const scriptEventId = `sim:${match.id}`;

    if (sport && match.sport !== sport) continue;

    const matchOddsRows = byEvent.get(scriptEventId) ?? [];
    matchedEventIds.add(scriptEventId); // prevent duplicate in step 3

    const h2h     = matchOddsRows.filter(r => r.market_type === 'match_winner');
    const homeOdds = h2h.find(r => r.selection === 'home')?.odds_value;
    const drawOdds = h2h.find(r => r.selection === 'draw')?.odds_value;
    const awayOdds = h2h.find(r => r.selection === 'away')?.odds_value;
    const markets  = matchOddsRows.filter(r => r.market_type !== 'match_winner').length;

    const minuteLabel = (match.current_minute ?? 0) > 0 ? `${match.current_minute}'` : 'LIVE';

    result.push({
      eventId:     scriptEventId,
      oddsEventId: scriptEventId,
      league:      match.competition ?? match.league_name ?? 'XfameBet League',
      sport:       match.sport ?? 'football',
      isLive:      true,
      status:      minuteLabel,
      home:        { name: match.team_a, logoUrl: match.home_logo ?? null },
      away:        { name: match.team_b, logoUrl: match.away_logo ?? null },
      homeScore:   String(match.team_a_score ?? 0),
      awayScore:   String(match.team_b_score ?? 0),
      odds:        [homeOdds ?? '-', drawOdds ?? '-', awayOdds ?? '-'],
      oddsLocked:  homeOdds == null,
      markets,
      sportKey:    match.sport ?? 'football',
      kickedOffAt: match.started_at ?? null,
    });
  }

  // 3. Process Odds API events not matched to any API-Football fixture or scripted match
  for (const [eventId, rows] of byEvent) {
    if (matchedEventIds.has(eventId)) continue;

    const first = rows[0];
    const eventSport = first.sport;

    // Apply sport filter
    if (sport) {
      const matches =
        sport === 'baseball'
          ? eventSport.startsWith('baseball')
          : eventSport === sport;
      if (!matches) continue;
    }

    const h2h = rows.filter(r => r.market_type === 'match_winner');
    const homeOdds = h2h.find(r => r.selection === 'home')?.odds_value;
    const drawOdds = h2h.find(r => r.selection === 'draw')?.odds_value;
    const awayOdds = h2h.find(r => r.selection === 'away')?.odds_value;
    const markets = rows.filter(r => r.market_type !== 'match_winner').length;

    const [homeName = first.event_name, awayName = ''] = first.event_name.includes(' vs ')
      ? first.event_name.split(' vs ').map((s: string) => s.trim())
      : [first.event_name];

    const statusStr = first.starts_at ? formatKickoffAsStatus(first.starts_at) : 'LIVE';

    result.push({
      eventId,
      oddsEventId: eventId,
      league: first.league ?? 'Other',
      sport: eventSport,
      isLive: true,
      status: statusStr,
      home: { name: homeName, logoUrl: null },
      away: { name: awayName, logoUrl: null },
      homeScore: null,
      awayScore: null,
      odds: [homeOdds ?? '-', drawOdds ?? '-', awayOdds ?? '-'],
      oddsLocked: homeOdds == null && awayOdds == null,
      markets,
      sportKey: eventSport,
      kickedOffAt: first.starts_at ?? null,
    });
  }

  return result;
}
