import { supabase } from '../config/supabase';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

// League name → bonus points. Checked case-insensitively via .includes().
const LEAGUE_SCORES: [string, number][] = [
  // Top tier (60)
  ['premier league', 60], ['english premier league', 60],
  ['champions league', 60], ['uefa champions league', 60],
  ['la liga', 60], ['laliga', 60],
  ['serie a', 60], ['bundesliga', 60], ['ligue 1', 60],
  ['world cup', 60], ['euro 2024', 60], ['euros', 60],
  ['nba', 60], ['nfl', 60], ['mlb', 60],
  ['wimbledon', 60], ['us open tennis', 60], ['french open', 60], ['australian open', 60],
  // Mid tier (35)
  ['europa league', 35], ['nhl', 35],
  ['fa cup', 35], ['carabao cup', 35], ['mls', 35],
  ['eredivisie', 35], ['primeira liga', 35],
  ['atp', 35], ['wta', 35],
  ['euroleague', 35],
  // Lower tier (15)
  ['six nations', 15], ['super rugby', 15], ['ncaaf', 15], ['ncaab', 15],
];

function leagueScore(league?: string | null): number {
  if (!league) return 0;
  const lc = league.toLowerCase();
  for (const [key, pts] of LEAGUE_SCORES) {
    if (lc.includes(key)) return pts;
  }
  return 0;
}

function timeScore(startsAt?: string | null): number {
  if (!startsAt) return 0;
  const hoursAway = (new Date(startsAt).getTime() - Date.now()) / 3_600_000;
  if (hoursAway < 0) return 0;   // already started / live
  if (hoursAway <= 24) return 40; // today
  if (hoursAway <= 48) return 25; // tomorrow
  if (hoursAway <= 168) return 10; // this week
  return 0;
}

const CACHE_KEY = (date: string) => `popular_matches:${date}`;
const CACHE_TTL = 24 * 60 * 60; // 24 h
const POPULAR_COUNT = 9;
const MAX_PER_SPORT = 5;

interface OddsFeedRow {
  event_id: string;
  event_name: string;
  market_type: string;
  selection: string;
  odds_value: number;
  sport: string;
  league?: string | null;
  starts_at?: string | null;
  status: string;
}

export async function buildPopularMatches(): Promise<OddsFeedRow[]> {
  const { data, error } = await supabase
    .from('odds_feed')
    .select('event_id, event_name, market_type, selection, odds_value, sport, league, starts_at, status')
    .eq('status', 'active')
    .not('sport', 'like', 'virtual_%')
    .order('starts_at', { ascending: true, nullsFirst: false });

  if (error || !data?.length) return [];

  // Aggregate per event
  const eventMap = new Map<string, { sport: string; league?: string | null; starts_at?: string | null; marketTypes: Set<string> }>();
  for (const row of data as OddsFeedRow[]) {
    if (!eventMap.has(row.event_id)) {
      eventMap.set(row.event_id, {
        sport: row.sport,
        league: row.league,
        starts_at: row.starts_at,
        marketTypes: new Set(),
      });
    }
    eventMap.get(row.event_id)!.marketTypes.add(row.market_type);
  }

  // Score and rank
  const ranked = [...eventMap.entries()]
    .map(([eventId, ev]) => ({
      eventId,
      sport: ev.sport,
      score: leagueScore(ev.league) + ev.marketTypes.size * 3 + timeScore(ev.starts_at),
    }))
    .sort((a, b) => b.score - a.score);

  // Pick with sport-diversity cap
  const sportCount: Record<string, number> = {};
  const selected = new Set<string>();

  for (const ev of ranked) {
    if (selected.size >= POPULAR_COUNT) break;
    if ((sportCount[ev.sport] ?? 0) >= MAX_PER_SPORT) continue;
    sportCount[ev.sport] = (sportCount[ev.sport] ?? 0) + 1;
    selected.add(ev.eventId);
  }

  // Fill remaining slots ignoring the cap (in case of very narrow sport variety)
  for (const ev of ranked) {
    if (selected.size >= POPULAR_COUNT) break;
    selected.add(ev.eventId);
  }

  return (data as OddsFeedRow[]).filter(row => selected.has(row.event_id));
}

export async function getPopularMatches(): Promise<OddsFeedRow[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = CACHE_KEY(today);

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const matches = await buildPopularMatches();
  if (matches.length > 0) {
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(matches));
  }
  return matches;
}

export async function refreshPopularMatches(): Promise<void> {
  // Clear all dated keys (today + any stale previous days)
  const keys = await redis.keys('popular_matches:*');
  if (keys.length > 0) await redis.del(...keys as [string, ...string[]]);

  const matches = await buildPopularMatches();
  const today = new Date().toISOString().slice(0, 10);
  if (matches.length > 0) {
    await redis.setex(CACHE_KEY(today), CACHE_TTL, JSON.stringify(matches));
  }

  const uniqueEvents = new Set(matches.map(m => m.event_id)).size;
  logger.info('[PopularMatches] Daily refresh complete', { events: uniqueEvents });
}
