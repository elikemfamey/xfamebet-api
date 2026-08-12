import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { broadcastOddsUpdate } from '../socket';
import { getSportMonksFixtureId } from './liveFixtureIdentityService';
import { regulateOdds } from './liveOddsRegulator';

const BASE_URL = 'https://api.sportmonks.com/v3/football';
export const LIVE_ODDS_MAX_AGE_MS = 45_000;

type SportMonksOdd = {
  fixture_id: number; label?: string; name?: string; value?: string | number;
  market_description?: string; market_id?: number; total?: string | number | null;
  handicap?: string | number | null; suspended?: boolean; stopped?: boolean;
  latest_bookmaker_update?: string; updated_at?: string;
};

function normalizeOdd(odd: SportMonksOdd) {
  const description = (odd.market_description ?? '').toLowerCase();
  const label = (odd.label ?? odd.name ?? '').trim();
  const value = Number(odd.value);
  if (!Number.isFinite(value) || value < 1.01) return null;
  let market_type = `sportmonks_${odd.market_id ?? 'market'}`;
  let selection = label.toLowerCase();
  if (/(fulltime result|match winner|1x2)/.test(description)) {
    market_type = 'match_winner';
    if (label === '1' || /^home$/i.test(label)) selection = 'home';
    else if (label.toUpperCase() === 'X' || /^draw$/i.test(label)) selection = 'draw';
    else if (label === '2' || /^away$/i.test(label)) selection = 'away';
  } else if (/over.?under|total goals/.test(description)) {
    market_type = 'totals';
    selection = `${label}${odd.total != null ? ` ${odd.total}` : ''}`.trim();
  }
  return { market_type, selection, odds_value: value, active: !odd.suspended && !odd.stopped,
    provider_updated_at: odd.latest_bookmaker_update ?? odd.updated_at ?? new Date().toISOString() };
}

export async function ingestSportMonksLiveOdds(canonicalEventId: string, eventName: string, league: string | null, startsAt: string | null): Promise<void> {
  if (!env.SPORTMONKS_API_TOKEN) throw new Error('SPORTMONKS_API_TOKEN not configured');
  const fixtureId = await getSportMonksFixtureId(canonicalEventId);
  if (!fixtureId) throw new Error('SportMonks fixture mapping unavailable');

  const resp = await axios.get(`${BASE_URL}/odds/inplay/fixtures/${fixtureId}`, {
    params: { api_token: env.SPORTMONKS_API_TOKEN }, timeout: 12_000,
  });
  const parsed = ((resp.data?.data ?? []) as SportMonksOdd[]).map(normalizeOdd).filter(Boolean) as Array<NonNullable<ReturnType<typeof normalizeOdd>>>;
  const now = new Date().toISOString();
  await supabase.from('odds_feed').update({ status: 'suspended', updated_at: now })
    .eq('event_id', canonicalEventId).eq('source', 'sportmonks_live').eq('is_live', true);

  if (!parsed.length) {
    await redis.del(REDIS_KEYS.LIVE_ODDS(canonicalEventId));
    throw new Error('SportMonks returned no in-play odds');
  }
  const rows = parsed.map(odd => ({ event_id: canonicalEventId, event_name: eventName,
    market_type: odd.market_type, selection: odd.selection, odds_value: odd.odds_value,
    source: 'sportmonks_live', sport: 'football', league, starts_at: startsAt,
    status: odd.active ? 'active' : 'suspended', is_live: true,
    provider_updated_at: odd.provider_updated_at, updated_at: now }));
  const { error } = await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
  if (error) throw error;
  await redis.del(REDIS_KEYS.LIVE_ODDS(canonicalEventId));
  const keys = await redis.keys('live_feed:*'); if (keys.length) await redis.del(...keys);
  broadcastOddsUpdate(canonicalEventId, rows);
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function sameTeam(left: string, right: string): boolean {
  const a = normalized(left); const b = normalized(right);
  return a === b || a.includes(b) || b.includes(a);
}

function sameFixture(left: string, right: string): boolean {
  const split = (name: string) => name.split(/\s+vs\.?\s+/i).map(part => part.trim());
  const [leftHome, leftAway] = split(left); const [rightHome, rightAway] = split(right);
  return !!leftHome && !!leftAway && !!rightHome && !!rightAway && sameTeam(leftHome, rightHome) && sameTeam(leftAway, rightAway);
}

/**
 * Conservative second provider: reuse only a same-fixture Odds API snapshot and
 * explicitly label it as a live fallback. SportMonks always takes precedence on
 * its next successful in-play poll.
 */
export async function ingestOddsApiLiveFallback(event: { eventId: string; eventName: string; league: string | null; startsAt: string | null }): Promise<void> {
  const { data } = await supabase.from('odds_feed')
    .select('event_name,market_type,selection,odds_value,league,starts_at,status,updated_at')
    .eq('source', 'odds_api').eq('sport', 'football').eq('status', 'active')
    .order('updated_at', { ascending: false }).limit(1000);
  const matched = (data ?? []).filter(row => sameFixture(row.event_name ?? '', event.eventName) && Date.now() - new Date(row.updated_at).getTime() <= 6 * 60_000);
  if (!matched.length) throw new Error('No matching Odds API fallback price');

  const now = new Date().toISOString();
  const rows = matched.map(row => ({
    event_id: event.eventId, event_name: event.eventName, market_type: row.market_type,
    selection: row.selection, odds_value: row.odds_value, source: 'odds_api_live_fallback',
    sport: 'football', league: event.league ?? row.league, starts_at: event.startsAt ?? row.starts_at,
    status: 'active', is_live: true, provider_updated_at: now, updated_at: now,
  }));
  const { error } = await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
  if (error) throw error;
  await redis.del(REDIS_KEYS.LIVE_ODDS(event.eventId));
  const keys = await redis.keys('live_feed:*'); if (keys.length) await redis.del(...keys);
  broadcastOddsUpdate(event.eventId, rows);
}

export function areLiveOddsFresh(rows: Array<{ provider_updated_at?: string | null; updated_at?: string | null }>): boolean {
  return rows.some(row => {
    const timestamp = row.provider_updated_at ?? row.updated_at;
    return !!timestamp && Date.now() - new Date(timestamp).getTime() <= LIVE_ODDS_MAX_AGE_MS;
  });
}

type LiveOddsEvent = { eventId: string; eventName: string; league: string | null; startsAt: string | null; homeScore: number; awayScore: number; minute: number; status: string };

async function regulateInternalLiveFallback(event: LiveOddsEvent): Promise<void> {
  const [teamAName, teamBName = 'Away'] = event.eventName.split(/\s+vs\.?\s+/i);
  const firstHalf = event.minute < 46 && event.status !== 'HT';
  await regulateOdds({ matchId: event.eventId, eventId: event.eventId, source: 'internal_live_fallback', isLive: true,
    sport: 'football', league: event.league ?? 'Live Football', startsAt: event.startsAt ?? new Date().toISOString(),
    teamAName, teamBName, scoreA: event.homeScore, scoreB: event.awayScore, currentMinute: event.minute,
    duration: 90, goalProb: 0.028, teamAStrength: 5, teamBStrength: 5,
    phase: firstHalf ? 'first_half' : 'second_half', firstScorerTeam: event.homeScore + event.awayScore > 0 ? 'recorded' : null,
  });
}

export async function ingestLiveOddsForEvents(events: LiveOddsEvent[]): Promise<void> {
  for (const event of events) {
    try { await ingestSportMonksLiveOdds(event.eventId, event.eventName, event.league, event.startsAt); }
    catch (err: any) {
      logger.warn('[SportMonksOdds] Live odds fetch failed; trying Odds API fallback', { eventId: event.eventId, message: err.message });
      try { await ingestOddsApiLiveFallback(event); }
      catch (fallbackErr: any) {
        logger.warn('[LiveOdds] External providers unavailable; using regulated internal fallback', { eventId: event.eventId, message: fallbackErr.message });
        await regulateInternalLiveFallback(event);
      }
    }
  }
}
