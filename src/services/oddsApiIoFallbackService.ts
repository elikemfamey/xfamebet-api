import axios from 'axios';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { broadcastOddsUpdate } from '../socket';
import { logger } from '../utils/logger';
import { LiveScore } from './liveScoreService';
import { resolveCanonicalEventId } from './liveFixtureIdentityService';

const BASE_URL = 'https://api.odds-api.io/v3';
const PROVIDER = 'odds_api_io';
const LIVE_MAX_AGE_MS = 4 * 60_000;
const UPCOMING_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_LIVE_EVENTS = 10;
const DAILY_LIMIT = 500;
const HOURLY_LIMIT = 100;

type ProviderEvent = { id: string; home: string; away: string; startsAt: string; raw: any };
type Mapping = { canonical_event_id: string; api_football_fixture_id?: number | null; odds_api_io_event_id?: string | null; home_team: string; away_team: string; starts_at: string; competition_name?: string | null; competition_key?: string | null; country_name?: string | null };

function normal(value: unknown): string { return String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function eventFrom(raw: any): ProviderEvent | null {
  const id = raw?.id ?? raw?.eventId ?? raw?.event_id;
  const home = raw?.home ?? raw?.homeTeam ?? raw?.home_team ?? raw?.teams?.home?.name;
  const away = raw?.away ?? raw?.awayTeam ?? raw?.away_team ?? raw?.teams?.away?.name;
  const startsAt = raw?.commence_time ?? raw?.commenceTime ?? raw?.startTime ?? raw?.starts_at ?? raw?.date ?? raw?.time;
  if (id == null || !home || !away || !startsAt || Number.isNaN(new Date(startsAt).getTime())) return null;
  return { id: String(id), home: String(home), away: String(away), startsAt: new Date(startsAt).toISOString(), raw };
}

async function reserveRequest(): Promise<boolean> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = `${day}:${String(now.getUTCHours()).padStart(2, '0')}`;
  const dailyKey = `odds_api_io:quota:day:${day}`;
  const hourlyKey = `odds_api_io:quota:hour:${hour}`;
  const [daily, hourly] = await Promise.all([redis.incr(dailyKey), redis.incr(hourlyKey)]);
  if (daily === 1) await redis.expire(dailyKey, 2 * 24 * 60 * 60);
  if (hourly === 1) await redis.expire(hourlyKey, 2 * 60 * 60);
  if (daily <= DAILY_LIMIT && hourly <= HOURLY_LIMIT) return true;
  await Promise.all([redis.decr(dailyKey), redis.decr(hourlyKey)]);
  logger.warn('[OddsApiIo] Request skipped because free-tier quota is exhausted', { daily, hourly });
  return false;
}

async function request<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
  if (!env.ODDS_API_IO_KEY) return null;
  if (!await reserveRequest()) return null;
  try {
    const response = await axios.get<T>(`${BASE_URL}${path}`, { params: { ...params, apiKey: env.ODDS_API_IO_KEY }, timeout: 12_000 });
    await redis.set('odds_api_io:provider_health', JSON.stringify({ activeSource: PROVIDER, lastSuccessAt: new Date().toISOString(), lastFailureAt: null }));
    return response.data;
  } catch (error: any) {
    logger.warn('[OddsApiIo] Provider request failed', { path, status: error?.response?.status, message: error?.message });
    await redis.set('odds_api_io:provider_health', JSON.stringify({ activeSource: 'odds_api_io_unavailable', lastSuccessAt: null, lastFailureAt: new Date().toISOString(), lastFailure: error?.message ?? 'Provider request failed' }));
    return null;
  }
}

function h2h(raw: any): Array<{ market_type: string; selection: string; odds_value: number; provider_updated_at?: string }> {
  const result = new Map<string, { market_type: string; selection: string; odds_value: number; provider_updated_at?: string }>();
  for (const [bookmaker, markets] of Object.entries(raw?.bookmakers ?? {})) {
    if (!bookmaker || !Array.isArray(markets)) continue;
    for (const market of markets as any[]) {
      if (!/^(ml|match winner|1x2|fulltime result)$/i.test(String(market?.name ?? '').trim())) continue;
      for (const line of market?.odds ?? []) {
        for (const [key, selection] of [['home', 'home'], ['away', 'away'], ['draw', 'draw']] as const) {
          const value = Number(line?.[key]);
          if (Number.isFinite(value) && value >= 1.01 && !result.has(selection)) result.set(selection, { market_type: 'match_winner', selection, odds_value: value, provider_updated_at: market?.updatedAt ?? raw?.updatedAt });
        }
      }
    }
  }
  return [...result.values()];
}

async function invalidate(eventId: string) {
  await redis.del(REDIS_KEYS.LIVE_ODDS(eventId), REDIS_KEYS.ALL_ODDS);
  const keys = await redis.keys('live_feed:*'); if (keys.length) await redis.del(...keys);
}

async function audit(eventId: string, providerEventId: string, isLive: boolean, payload: any, providerUpdatedAt?: string) {
  const { error } = await supabase.from('provider_odds_snapshots').insert({ provider: PROVIDER, provider_event_id: providerEventId, canonical_event_id: eventId, is_live: isLive, provider_updated_at: providerUpdatedAt ?? null, payload });
  if (error) logger.warn('[OddsApiIo] Snapshot audit write failed', { eventId, message: error.message });
}

async function writeSnapshot(mapping: Mapping, providerEventId: string, isLive: boolean, payload: any): Promise<boolean> {
  const odds = h2h(payload);
  if (odds.length < 2) return false;
  const now = new Date().toISOString();
  const rows = odds.map(odd => ({ event_id: mapping.canonical_event_id, event_name: `${mapping.home_team} vs ${mapping.away_team}`, market_type: odd.market_type, selection: odd.selection, odds_value: odd.odds_value, source: isLive ? 'odds_api_io_live' : 'odds_api_io_upcoming', sport: 'football', league: mapping.competition_name ?? 'Other Football', competition_key: mapping.competition_key ?? 'odds-api-io:unknown', country_name: mapping.country_name ?? null, starts_at: mapping.starts_at, status: 'active', lock_reason: null, is_live: isLive, provider_updated_at: odd.provider_updated_at ?? now, updated_at: now }));
  const { error } = await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
  if (error) { logger.warn('[OddsApiIo] Failed to write normalized odds', { eventId: mapping.canonical_event_id, message: error.message }); return false; }
  await audit(mapping.canonical_event_id, providerEventId, isLive, payload, rows[0]?.provider_updated_at);
  await invalidate(mapping.canonical_event_id);
  broadcastOddsUpdate(mapping.canonical_event_id, rows);
  return true;
}

async function fetchMulti(eventIds: string[]): Promise<Map<string, any>> {
  if (!eventIds.length) return new Map();
  const data: any = await request('/odds/multi', { eventIds: eventIds.join(',') });
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.events) ? data.events : [];
  return new Map(rows.map((row: any) => [String(row?.id ?? row?.eventId ?? row?.event_id), row]));
}

function priority(mapping: Mapping, popularApiIds: Set<number>): number {
  const league = String(mapping.competition_name ?? '').toLowerCase();
  const popular = mapping.api_football_fixture_id && popularApiIds.has(mapping.api_football_fixture_id) ? 10_000 : 0;
  const major = /premier league|champions league|la liga|serie a|bundesliga|ligue 1|world cup|europa league/.test(league) ? 1_000 : 0;
  return popular + major - new Date(mapping.starts_at).getTime() / 1e12;
}

export async function ingestOddsApiIoLiveFallback(scores: LiveScore[], apiPricedEventIds: Set<string>): Promise<void> {
  if (!env.ODDS_API_IO_KEY) return;
  // The primary worker runs every 30 seconds, but the free fallback is strictly
  // capped to one global batch poll every four minutes across API instances.
  const pollLock = await redis.set('odds_api_io:live_poll_lock', '1', 'EX', 240, 'NX');
  if (pollLock !== 'OK') return;
  const live = [] as Array<{ score: LiveScore; eventId: string; mapping: Mapping }>;
  for (const score of scores) {
    if (score.provider !== 'api_football') continue;
    const eventId = await resolveCanonicalEventId(score);
    if (apiPricedEventIds.has(eventId)) continue;
    const { data } = await supabase.from('live_fixture_mappings').select('*').eq('canonical_event_id', eventId).maybeSingle();
    if (data?.odds_api_io_event_id) live.push({ score, eventId, mapping: { ...data, home_team: score.home_team, away_team: score.away_team, starts_at: score.starts_at ?? new Date().toISOString(), competition_name: score.league, competition_key: score.competition_key, country_name: score.country } });
  }
  const popularCache = await redis.get(REDIS_KEYS.POPULAR_MATCHES(new Date().toISOString().slice(0, 10)));
  let popularRows: any[] = [];
  try { popularRows = popularCache ? JSON.parse(popularCache) : []; } catch { /* cache recovery */ }
  const popularApiIds = new Set<number>(popularRows.map((row: any) => Number(String(row.event_id).match(/api_football:(\d+)/)?.[1])).filter(Number.isFinite));
  const selected = live.sort((a, b) => priority(b.mapping, popularApiIds) - priority(a.mapping, popularApiIds)).slice(0, MAX_LIVE_EVENTS);
  const prices = await fetchMulti(selected.map(item => String(item.mapping.odds_api_io_event_id)));
  const now = Date.now();
  for (const item of selected) {
    const payload = prices.get(String(item.mapping.odds_api_io_event_id));
    if (payload && await writeSnapshot(item.mapping, String(item.mapping.odds_api_io_event_id), true, payload)) continue;
    const { data: existing } = await supabase.from('odds_feed').select('provider_updated_at,updated_at,source').eq('event_id', item.eventId).eq('is_live', true).eq('status', 'active').maybeSingle();
    const updatedAt = existing?.provider_updated_at ?? existing?.updated_at;
    if (!updatedAt || now - new Date(updatedAt).getTime() > LIVE_MAX_AGE_MS) {
      await supabase.from('odds_feed').update({ status: 'suspended', lock_reason: 'Markets suspended while verified live prices are unavailable.', updated_at: new Date().toISOString() }).eq('event_id', item.eventId).eq('is_live', true);
      await invalidate(item.eventId);
    }
  }
}

export async function refreshOddsApiIoUpcomingFallback(): Promise<void> {
  if (!env.ODDS_API_IO_KEY) {
    logger.warn('[OddsApiIo] Upcoming fallback skipped because ODDS_API_IO_KEY is not configured');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const lockKey = `odds_api_io:upcoming_refresh:${today}`;
  // This provider is deliberately refreshed once per UTC day, including after
  // restarts and across horizontally scaled API workers.
  // A previous provider error must not suppress every retry until the next day.
  const healthRaw = await redis.get('odds_api_io:provider_health');
  try {
    if (healthRaw && JSON.parse(healthRaw).activeSource === 'odds_api_io_unavailable') await redis.del(lockKey);
  } catch { /* a corrupt health value must not block ingestion */ }
  const dailyLock = await redis.set(lockKey, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
  if (dailyLock !== 'OK') return;
  // Odds-API.io rejects oversized event requests. A bounded catalogue is also
  // sufficient because API-Football remains the primary source for all games.
  const catalogue: any = await request('/events', { sport: 'football', status: 'pending', limit: 100 });
  const providerEvents = (Array.isArray(catalogue) ? catalogue : catalogue?.data ?? catalogue?.events ?? []).map(eventFrom).filter(Boolean) as ProviderEvent[];
  if (!providerEvents.length) {
    // A failed/malformed catalogue fetch must be retried by the next upcoming
    // ingestion cycle; only a successful daily catalogue consumes the lock.
    await redis.del(lockKey);
    return;
  }
  const { data: mappings } = await supabase.from('upcoming_football_fixture_mappings').select('*').gt('starts_at', new Date().toISOString()).lte('starts_at', new Date(Date.now() + 30 * 86_400_000).toISOString()).order('starts_at').limit(500);
  const matched: Mapping[] = [];
  for (const mapping of mappings ?? []) {
    const match = providerEvents.find(event => normal(event.home) === normal(mapping.home_team) && normal(event.away) === normal(mapping.away_team) && Math.abs(new Date(event.startsAt).getTime() - new Date(mapping.starts_at).getTime()) <= 10 * 60_000);
    if (!match) continue;
    await supabase.from('upcoming_football_fixture_mappings').update({ odds_api_io_event_id: match.id, updated_at: new Date().toISOString() }).eq('canonical_event_id', mapping.canonical_event_id);
    matched.push({ ...mapping, odds_api_io_event_id: match.id });
  }
  // API-Football remains primary. Only candidates without a currently active primary price are fetched.
  const ids = matched.map(row => row.canonical_event_id);
  const { data: primary } = ids.length ? await supabase.from('odds_feed').select('event_id,status,provider_updated_at,updated_at').in('event_id', ids).eq('source', 'api_football_upcoming').eq('is_live', false).eq('status', 'active') : { data: [] as any[] };
  const freshPrimary = new Set((primary ?? []).filter(row => Date.now() - new Date(row.provider_updated_at ?? row.updated_at).getTime() <= 60 * 60_000).map(row => row.event_id));
  const candidates = matched.filter(row => !freshPrimary.has(row.canonical_event_id)).slice(0, 100);
  for (let index = 0; index < candidates.length; index += MAX_LIVE_EVENTS) {
    const group = candidates.slice(index, index + MAX_LIVE_EVENTS);
    const prices = await fetchMulti(group.map(row => String(row.odds_api_io_event_id)));
    for (const mapping of group) {
      const payload = prices.get(String(mapping.odds_api_io_event_id));
      if (payload) await writeSnapshot(mapping, String(mapping.odds_api_io_event_id), false, payload);
    }
  }
  logger.info('[OddsApiIo] Upcoming fallback refreshed', { providerEvents: providerEvents.length, mapped: matched.length, candidates: candidates.length });
}

export function isOddsApiIoLiveFresh(row: { source?: string | null; provider_updated_at?: string | null; updated_at?: string | null }): boolean {
  const updatedAt = row.provider_updated_at ?? row.updated_at;
  const maxAge = row.source === 'odds_api_io_live' ? LIVE_MAX_AGE_MS : 45_000;
  return Boolean(updatedAt) && Date.now() - new Date(updatedAt!).getTime() <= maxAge;
}

export function isUpcomingFallbackFresh(row: { source?: string | null; provider_updated_at?: string | null; updated_at?: string | null }): boolean {
  const updatedAt = row.provider_updated_at ?? row.updated_at;
  const maxAge = row.source === 'odds_api_io_upcoming' ? UPCOMING_MAX_AGE_MS : 60 * 60_000;
  return Boolean(updatedAt) && Date.now() - new Date(updatedAt!).getTime() <= maxAge;
}
