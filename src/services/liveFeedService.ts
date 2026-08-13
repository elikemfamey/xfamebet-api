import { supabase } from '../config/supabase';
import { getCachedLiveScores, LiveScore } from './liveScoreService';
import { getAllCachedOddsApiScores, OddsApiScoreEntry } from './oddsApiScoreService';
import { resolveCanonicalEventId } from './liveFixtureIdentityService';
import { isOddsApiIoLiveFresh } from './oddsApiIoFallbackService';
import { estimateFootballMarkets } from './liveOddsRegulator';

export interface LiveFeedTeam { name: string; logoUrl: string | null; }
export interface LiveFeedMatch {
  eventId: string; oddsEventId: string | null; league: string; sport: string; isLive: boolean;
  status: string; home: LiveFeedTeam; away: LiveFeedTeam; homeScore: string | null; awayScore: string | null;
  odds: [string | number, string | number, string | number]; oddsLocked: boolean;
  oddsStatus: 'active' | 'suspended'; oddsLockReason?: string; markets: number; sportKey: string;
  headlineOdds?: Array<{ selection: 'home' | 'draw' | 'away'; odds_value: number; status: string; lock_reason?: string | null }>;
  kickedOffAt: string | null; countryCode?: string | null; oddsEstimated?: boolean; estimatedMarkets?: Array<Record<string, unknown>>;
  apiFootballFixtureId?: number | null; competitionKey?: string | null; country?: string | null;
}
interface OddsRow { event_id: string; event_name: string; market_type: string; selection: string; odds_value: number; sport: string; league: string | null; starts_at: string | null; status: string; source?: string | null; provider_updated_at?: string | null; updated_at?: string | null; is_live?: boolean; }
const IN_PLAY = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT']);
const NO_DRAW = new Set(['basketball', 'tennis', 'american_football', 'baseball', 'ice_hockey', 'mma', 'golf', 'horse_racing', 'aussie_rules', 'boxing', 'greyhound']);
const sportFromKey = (key: string) => ({ soccer: 'football', basketball: 'basketball', tennis: 'tennis', americanfootball: 'american_football', baseball: 'baseball', icehockey: 'ice_hockey', cricket: 'cricket', rugbyunion: 'rugby', rugbyleague: 'rugby_league', mma: 'mma', golf: 'golf', aussierules: 'aussie_rules', boxing: 'boxing' }[key.split('_')[0]] ?? 'football');
const status = (score: LiveScore) => score.status_short === 'HT' ? 'HT' : score.status_short === 'BT' ? 'BT' : score.status_short === 'P' ? 'PEN' : score.minute > 0 ? `${score.minute}'` : 'LIVE';
function h2h(rows: OddsRow[]) { return { home: rows.find(r => r.market_type === 'match_winner' && r.selection === 'home')?.odds_value, draw: rows.find(r => r.market_type === 'match_winner' && r.selection === 'draw')?.odds_value, away: rows.find(r => r.market_type === 'match_winner' && r.selection === 'away')?.odds_value }; }
function scoreFor(entry: OddsApiScoreEntry, side: 'home' | 'away') { const team = side === 'home' ? entry.home_team : entry.away_team; return entry.scores?.find(s => s.name === team)?.score ?? null; }

// Fallback live estimate for the headline market when the full catalogue is unavailable.
function liveEstimate(homeScore: number, awayScore: number, minute: number): [number, number, number] {
  const remaining = Math.max(0, 90 - Math.min(90, minute));
  const lambda = 2.55 * remaining / 90 / 2;
  const pmf = (goals: number) => {
    let value = Math.exp(-lambda);
    for (let i = 1; i <= goals; i++) value = value * lambda / i;
    return value;
  };
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= 9; h++) for (let a = 0; a <= 9; a++) {
    const probability = pmf(h) * pmf(a);
    if (homeScore + h > awayScore + a) home += probability;
    else if (homeScore + h < awayScore + a) away += probability;
    else draw += probability;
  }
  const total = home + draw + away;
  return [home, draw, away].map(probability => Number((1 / (Math.max(0.005, probability / total) * 1.04)).toFixed(2))) as [number, number, number];
}

export async function buildLiveFeed(sport?: string): Promise<LiveFeedMatch[]> {
  const [footballScores, oddsScores, oddsResult, simulations] = await Promise.all([
    getCachedLiveScores(), getAllCachedOddsApiScores(),
    supabase.from('odds_feed').select('event_id,event_name,market_type,selection,odds_value,sport,league,starts_at,status,source,provider_updated_at,updated_at,is_live').in('status', ['active', 'suspended']).limit(2000),
    supabase.from('simulated_matches').select('id,team_a,team_b,team_a_score,team_b_score,current_minute,sport,competition,league_name,country_code,home_logo,away_logo,started_at').eq('status', 'live'),
  ]);
  const byEvent = new Map<string, OddsRow[]>();
  for (const row of (oddsResult.data ?? []) as OddsRow[]) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);
  const result: LiveFeedMatch[] = [];

  // Football is score-provider authoritative. It never becomes live merely because kickoff passed.
  if (!sport || sport === 'football') for (const score of footballScores) {
    if (!IN_PLAY.has(score.status_short)) continue;
    const eventId = await resolveCanonicalEventId(score);
    const liveRows = (byEvent.get(eventId) ?? []).filter(row => row.is_live === true);
    const apiRows = liveRows.filter(row => row.source === 'api_football_live');
    const fallbackRows = liveRows.filter(row => row.source === 'odds_api_io_live');
    const apiFresh = apiRows.some(row => isOddsApiIoLiveFresh(row));
    const fallbackFresh = fallbackRows.some(row => isOddsApiIoLiveFresh(row));
    const selectedRows = apiFresh ? apiRows : fallbackFresh ? fallbackRows : liveRows;
    const fresh = apiFresh || fallbackFresh;
    const prices = fresh ? h2h(selectedRows.filter(row => row.status === 'active')) : { home: undefined, draw: undefined, away: undefined };
    const locked = !fresh || prices.home == null || prices.away == null;
    const estimatedMarkets = locked ? estimateFootballMarkets({ eventId, home: score.home_team, away: score.away_team, league: score.league, startsAt: score.starts_at ?? new Date().toISOString(), isLive: true, homeScore: score.home_score, awayScore: score.away_score, minute: score.minute }) : undefined;
    const headline = estimatedMarkets?.filter(row => row.market_type === 'match_winner');
    const estimate = headline ? [Number(headline.find(row => row.selection === 'home')?.odds_value), Number(headline.find(row => row.selection === 'draw')?.odds_value), Number(headline.find(row => row.selection === 'away')?.odds_value)] as [number, number, number] : locked ? liveEstimate(score.home_score, score.away_score, score.minute) : null;
    result.push({ eventId, oddsEventId: eventId, league: score.league, sport: 'football', isLive: true, status: status(score), home: { name: score.home_team, logoUrl: score.home_logo }, away: { name: score.away_team, logoUrl: score.away_logo }, homeScore: String(score.home_score), awayScore: String(score.away_score), odds: locked ? estimate! : [prices.home!, prices.draw ?? '-', prices.away!], oddsLocked: false, oddsStatus: 'active', oddsEstimated: locked, estimatedMarkets, markets: locked ? (estimatedMarkets?.length ?? 3) : selectedRows.length, sportKey: 'football', kickedOffAt: score.starts_at ?? null, apiFootballFixtureId: score.fixture_id, competitionKey: score.competition_key ?? `api-football:${score.league}`, country: score.country ?? null });
  }

  // Other sports require a score-bearing Odds API entry; football is deliberately excluded above.
  for (const [eventId, entry] of oddsScores) {
    if (entry.completed || !entry.scores) continue;
    const eventRows = byEvent.get(eventId) ?? []; const first = eventRows[0]; const eventSport = first?.sport ?? sportFromKey(entry.sport_key);
    if (eventSport === 'football' || (sport && eventSport !== sport)) continue;
    const prices = h2h(eventRows.filter(r => r.status === 'active'));
    const locked = prices.home == null || prices.away == null;
    result.push({ eventId, oddsEventId: eventId, league: first?.league ?? 'Other', sport: eventSport, isLive: true, status: 'LIVE', home: { name: entry.home_team, logoUrl: null }, away: { name: entry.away_team, logoUrl: null }, homeScore: scoreFor(entry, 'home'), awayScore: scoreFor(entry, 'away'), odds: [locked ? '-' : prices.home!, NO_DRAW.has(eventSport) || locked ? '-' : prices.draw ?? '-', locked ? '-' : prices.away!], oddsLocked: locked, oddsStatus: locked ? 'suspended' : 'active', oddsLockReason: locked ? 'Markets suspended.' : undefined, markets: eventRows.length, sportKey: entry.sport_key, kickedOffAt: first?.starts_at ?? null });
  }

  for (const match of simulations.data ?? []) {
    if (sport && match.sport !== sport) continue;
    const eventId = `sim:${match.id}`;
    const rows = byEvent.get(eventId) ?? [];
    const headlineOdds = (['home', 'draw', 'away'] as const).map(selection => {
      const row = rows.find(item => item.market_type === 'match_winner' && item.selection === selection);
      return { selection, odds_value: Number(row?.odds_value ?? 0), status: row?.status ?? 'suspended', lock_reason: (row as any)?.lock_reason ?? 'Market unavailable.' };
    });
    const locked = headlineOdds.every(odd => odd.status !== 'active');
    result.push({ eventId, oddsEventId: eventId, league: match.competition ?? match.league_name ?? 'PrimeWin League', sport: match.sport ?? 'football', isLive: true, status: (match.current_minute ?? 0) > 0 ? `${match.current_minute}'` : 'LIVE', home: { name: match.team_a, logoUrl: match.home_logo ?? null }, away: { name: match.team_b, logoUrl: match.away_logo ?? null }, homeScore: String(match.team_a_score ?? 0), awayScore: String(match.team_b_score ?? 0), odds: [headlineOdds[0].odds_value, headlineOdds[1].odds_value, headlineOdds[2].odds_value], oddsLocked: locked, oddsStatus: locked ? 'suspended' : 'active', oddsLockReason: locked ? 'Markets suspended.' : undefined, headlineOdds, markets: rows.length, sportKey: match.sport ?? 'football', kickedOffAt: match.started_at ?? null, countryCode: match.country_code ?? null });
  }
  return result.sort((a, b) => Number(b.homeScore !== null) - Number(a.homeScore !== null));
}
