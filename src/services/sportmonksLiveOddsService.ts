import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { broadcastOddsUpdate } from '../socket';
import { getSportMonksFixtureId } from './liveFixtureIdentityService';

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
  if (!env.SPORTMONKS_API_TOKEN) return;
  const fixtureId = await getSportMonksFixtureId(canonicalEventId);
  if (!fixtureId) return; // Safe default: score remains visible, betting remains suspended.

  const resp = await axios.get(`${BASE_URL}/odds/inplay/fixtures/${fixtureId}`, {
    params: { api_token: env.SPORTMONKS_API_TOKEN }, timeout: 12_000,
  });
  const parsed = ((resp.data?.data ?? []) as SportMonksOdd[]).map(normalizeOdd).filter(Boolean) as Array<NonNullable<ReturnType<typeof normalizeOdd>>>;
  const now = new Date().toISOString();
  await supabase.from('odds_feed').update({ status: 'suspended', updated_at: now })
    .eq('event_id', canonicalEventId).eq('source', 'sportmonks_live').eq('is_live', true);

  if (!parsed.length) {
    await redis.del(REDIS_KEYS.LIVE_ODDS(canonicalEventId));
    return;
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

export function areLiveOddsFresh(rows: Array<{ provider_updated_at?: string | null; updated_at?: string | null }>): boolean {
  return rows.some(row => {
    const timestamp = row.provider_updated_at ?? row.updated_at;
    return !!timestamp && Date.now() - new Date(timestamp).getTime() <= LIVE_ODDS_MAX_AGE_MS;
  });
}

export async function ingestLiveOddsForEvents(events: Array<{ eventId: string; eventName: string; league: string | null; startsAt: string | null }>): Promise<void> {
  for (const event of events) {
    try { await ingestSportMonksLiveOdds(event.eventId, event.eventName, event.league, event.startsAt); }
    catch (err: any) { logger.warn('[SportMonksOdds] Live odds fetch failed', { eventId: event.eventId, message: err.message }); }
  }
}
