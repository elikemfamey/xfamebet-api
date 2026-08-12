import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { env } from '../config/env';
import { broadcastOddsUpdate } from '../socket';
import { logger } from '../utils/logger';
import { LiveScore } from './liveScoreService';
import { resolveCanonicalEventId } from './liveFixtureIdentityService';
import { ingestOddsApiIoLiveFallback } from './oddsApiIoFallbackService';

function normalizeOdds(event: any) {
  const suspended = event?.status?.stopped || event?.status?.blocked || event?.status?.finished;
  for (const bookmaker of event?.bookmakers ?? []) {
    const bet = (bookmaker.bets ?? []).find((item: any) => /^(match winner|1x2|fulltime result)$/i.test(String(item.name ?? '').trim()));
    if (!bet?.values) continue;
    const mainValues = bet.values.filter((value: any) => value.main !== false);
    const values = mainValues.length ? mainValues : bet.values;
    const rows = values.map((value: any) => {
      const label = String(value.value ?? '').trim().toLowerCase();
      const selection = label === 'home' || label === '1' ? 'home' : label === 'away' || label === '2' ? 'away' : label === 'draw' || label === 'x' ? 'draw' : null;
      const odds_value = Number(value.odd);
      return selection && Number.isFinite(odds_value) && odds_value >= 1.01 ? { market_type: 'match_winner', selection, odds_value, active: !suspended } : null;
    }).filter(Boolean) as Array<{ market_type: string; selection: string; odds_value: number; active: boolean }>;
    if (rows.some(row => row.selection === 'home') && rows.some(row => row.selection === 'away')) return rows;
  }
  return [];
}

async function clearEvent(eventId: string) {
  await redis.del(REDIS_KEYS.LIVE_ODDS(eventId));
  const keys = await redis.keys('live_feed:*'); if (keys.length) await redis.del(...keys);
}

export async function ingestApiFootballLiveOdds(scores: LiveScore[]): Promise<void> {
  if (!env.API_FOOTBALL_KEY) {
    await ingestOddsApiIoLiveFallback(scores, new Set());
    return;
  }
  let response;
  try {
    response = await axios.get('https://v3.football.api-sports.io/odds/live', {
      headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, timeout: 12_000,
    });
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const upstreamMessage = error.response?.data?.message
        ?? error.response?.data?.errors
        ?? error.response?.data
        ?? error.message;
      logger.warn('[ApiFootballOdds] Primary request failed; trying mapped Odds-API.io fallback', { message: `HTTP ${error.response?.status ?? 'network'}: ${JSON.stringify(upstreamMessage)}` });
      await ingestOddsApiIoLiveFallback(scores, new Set());
      return;
    }
    logger.warn('[ApiFootballOdds] Primary request failed; trying mapped Odds-API.io fallback', { message: error instanceof Error ? error.message : String(error) });
    await ingestOddsApiIoLiveFallback(scores, new Set());
    return;
  }
  if (!Array.isArray(response.data?.response)) {
    logger.warn('[ApiFootballOdds] Primary response invalid; trying mapped Odds-API.io fallback', { message: JSON.stringify(response.data?.errors ?? response.data?.message ?? 'missing response array') });
    await ingestOddsApiIoLiveFallback(scores, new Set());
    return;
  }
  const events = new Map<number, any>((response.data?.response ?? []).map((event: any) => [event.fixture?.id, event]));
  const now = new Date().toISOString();
  const apiPricedEventIds = new Set<string>();
  for (const score of scores) {
    if (score.provider !== 'api_football') continue;
    const eventId = await resolveCanonicalEventId(score);
    const odds = normalizeOdds(events.get(score.fixture_id));
    // Do not erase a still-fresh fallback snapshot simply because API-Football
    // has not listed this particular fixture in the latest response.
    if (!odds.length) continue;
    apiPricedEventIds.add(eventId);
    await supabase.from('odds_feed').update({ status: 'suspended', lock_reason: 'Replaced by the latest API-Football live odds.', updated_at: now }).eq('event_id', eventId).eq('is_live', true);
    const rows = odds.map((odd: any) => ({ event_id: eventId, event_name: `${score.home_team} vs ${score.away_team}`, market_type: odd.market_type, selection: odd.selection, odds_value: odd.odds_value, source: 'api_football_live', sport: 'football', league: score.league, starts_at: score.starts_at ?? null, status: odd.active ? 'active' : 'suspended', lock_reason: odd.active ? null : 'Suspended by API-Football live odds provider.', is_live: true, provider_updated_at: now, updated_at: now }));
    const { error } = await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
    if (error) { logger.warn('[ApiFootballOdds] Failed to store live odds', { eventId, message: error.message }); continue; }
    await clearEvent(eventId); broadcastOddsUpdate(eventId, rows);
  }
  await ingestOddsApiIoLiveFallback(scores, apiPricedEventIds);
}
