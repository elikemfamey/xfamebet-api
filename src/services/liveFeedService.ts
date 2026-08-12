import { supabase } from '../config/supabase';
import { getCachedLiveScores, LiveScore } from './liveScoreService';
import { getAllCachedOddsApiScores, OddsApiScoreEntry } from './oddsApiScoreService';
import { resolveCanonicalEventId } from './liveFixtureIdentityService';
import { areLiveOddsFresh } from './sportmonksLiveOddsService';

export interface LiveFeedTeam { name: string; logoUrl: string | null; }
export interface LiveFeedMatch {
  eventId: string; oddsEventId: string | null; league: string; sport: string; isLive: boolean;
  status: string; home: LiveFeedTeam; away: LiveFeedTeam; homeScore: string | null; awayScore: string | null;
  odds: [string | number, string | number, string | number]; oddsLocked: boolean;
  oddsStatus: 'active' | 'suspended'; oddsLockReason?: string; markets: number; sportKey: string;
  kickedOffAt: string | null; countryCode?: string | null;
}
interface OddsRow { event_id: string; event_name: string; market_type: string; selection: string; odds_value: number; sport: string; league: string | null; starts_at: string | null; status: string; provider_updated_at?: string | null; updated_at?: string | null; is_live?: boolean; }
const IN_PLAY = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT']);
const NO_DRAW = new Set(['basketball', 'tennis', 'american_football', 'baseball', 'ice_hockey', 'mma', 'golf', 'horse_racing', 'aussie_rules', 'boxing', 'greyhound']);
const sportFromKey = (key: string) => ({ soccer: 'football', basketball: 'basketball', tennis: 'tennis', americanfootball: 'american_football', baseball: 'baseball', icehockey: 'ice_hockey', cricket: 'cricket', rugbyunion: 'rugby', rugbyleague: 'rugby_league', mma: 'mma', golf: 'golf', aussierules: 'aussie_rules', boxing: 'boxing' }[key.split('_')[0]] ?? 'football');
const status = (score: LiveScore) => score.status_short === 'HT' ? 'HT' : score.status_short === 'BT' ? 'BT' : score.status_short === 'P' ? 'PEN' : score.minute > 0 ? `${score.minute}'` : 'LIVE';
function h2h(rows: OddsRow[]) { return { home: rows.find(r => r.market_type === 'match_winner' && r.selection === 'home')?.odds_value, draw: rows.find(r => r.market_type === 'match_winner' && r.selection === 'draw')?.odds_value, away: rows.find(r => r.market_type === 'match_winner' && r.selection === 'away')?.odds_value }; }
function scoreFor(entry: OddsApiScoreEntry, side: 'home' | 'away') { const team = side === 'home' ? entry.home_team : entry.away_team; return entry.scores?.find(s => s.name === team)?.score ?? null; }

export async function buildLiveFeed(sport?: string): Promise<LiveFeedMatch[]> {
  const [footballScores, oddsScores, oddsResult, simulations] = await Promise.all([
    getCachedLiveScores(), getAllCachedOddsApiScores(),
    supabase.from('odds_feed').select('event_id,event_name,market_type,selection,odds_value,sport,league,starts_at,status,provider_updated_at,updated_at,is_live').in('status', ['active', 'suspended']).limit(2000),
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
    const fresh = areLiveOddsFresh(liveRows);
    const prices = fresh ? h2h(liveRows.filter(row => row.status === 'active')) : { home: undefined, draw: undefined, away: undefined };
    const locked = !fresh || prices.home == null || prices.away == null;
    result.push({ eventId, oddsEventId: eventId, league: score.league, sport: 'football', isLive: true, status: status(score), home: { name: score.home_team, logoUrl: score.home_logo }, away: { name: score.away_team, logoUrl: score.away_logo }, homeScore: String(score.home_score), awayScore: String(score.away_score), odds: [locked ? '-' : prices.home!, locked ? '-' : prices.draw ?? '-', locked ? '-' : prices.away!], oddsLocked: locked, oddsStatus: locked ? 'suspended' : 'active', oddsLockReason: locked ? 'Live markets are temporarily suspended while verified odds are unavailable.' : undefined, markets: locked ? 0 : liveRows.length, sportKey: 'football', kickedOffAt: score.starts_at ?? null });
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
    if (sport && match.sport !== sport) continue; const eventId = `sim:${match.id}`; const rows = byEvent.get(eventId) ?? []; const prices = h2h(rows.filter(r => r.status === 'active')); const locked = prices.home == null || prices.away == null;
    result.push({ eventId, oddsEventId: eventId, league: match.competition ?? match.league_name ?? 'PrimeWin League', sport: match.sport ?? 'football', isLive: true, status: (match.current_minute ?? 0) > 0 ? `${match.current_minute}'` : 'LIVE', home: { name: match.team_a, logoUrl: match.home_logo ?? null }, away: { name: match.team_b, logoUrl: match.away_logo ?? null }, homeScore: String(match.team_a_score ?? 0), awayScore: String(match.team_b_score ?? 0), odds: [locked ? '-' : prices.home!, locked ? '-' : prices.draw ?? '-', locked ? '-' : prices.away!], oddsLocked: locked, oddsStatus: locked ? 'suspended' : 'active', oddsLockReason: locked ? 'Markets suspended.' : undefined, markets: rows.length, sportKey: match.sport ?? 'football', kickedOffAt: match.started_at ?? null, countryCode: match.country_code ?? null });
  }
  return result.sort((a, b) => Number(b.homeScore !== null) - Number(a.homeScore !== null));
}
