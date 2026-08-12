import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { env } from '../config/env';
import { broadcastOddsUpdate } from '../socket';
import { logger } from '../utils/logger';
import { LiveScore } from './liveScoreService';

function normalizeOdds(event: any) {
  const bookmaker = event.bookmakers?.[0];
  if (!bookmaker) return [];
  return (bookmaker.bets ?? []).flatMap((bet: any) => {
    if (!/match winner|winner|1x2/i.test(String(bet.name ?? ''))) return [];
    return (bet.values ?? []).map((value: any) => {
      const label = String(value.value ?? '').trim().toLowerCase();
      const selection = label === 'home' || label === '1' ? 'home' : label === 'away' || label === '2' ? 'away' : label === 'draw' || label === 'x' ? 'draw' : null;
      const odds_value = Number(value.odd);
      return selection && Number.isFinite(odds_value) && odds_value >= 1.01 ? { market_type: 'match_winner', selection, odds_value } : null;
    }).filter(Boolean);
  });
}

async function clearEvent(eventId: string) {
  await redis.del(REDIS_KEYS.LIVE_ODDS(eventId));
  const keys = await redis.keys('live_feed:*'); if (keys.length) await redis.del(...keys);
}

export async function ingestApiFootballLiveOdds(scores: LiveScore[]): Promise<void> {
  if (!env.API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not configured');
  const response = await axios.get('https://v3.football.api-sports.io/odds/live', { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, timeout: 12_000 });
  const events = new Map<number, any>((response.data?.response ?? []).map((event: any) => [event.fixture?.id, event]));
  const now = new Date().toISOString();
  for (const score of scores) {
    if (score.provider !== 'api_football') continue;
    const eventId = `live:football:api_football:${score.fixture_id}`;
    const odds = normalizeOdds(events.get(score.fixture_id));
    await supabase.from('odds_feed').update({ status: 'suspended', lock_reason: 'Awaiting refreshed API-Football live odds.', updated_at: now }).eq('event_id', eventId).eq('is_live', true);
    if (!odds.length) { await clearEvent(eventId); continue; }
    const rows = odds.map((odd: any) => ({ event_id: eventId, event_name: `${score.home_team} vs ${score.away_team}`, market_type: odd.market_type, selection: odd.selection, odds_value: odd.odds_value, source: 'api_football_live', sport: 'football', league: score.league, starts_at: score.starts_at ?? null, status: 'active', lock_reason: null, is_live: true, provider_updated_at: now, updated_at: now }));
    const { error } = await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
    if (error) { logger.warn('[ApiFootballOdds] Failed to store live odds', { eventId, message: error.message }); continue; }
    await clearEvent(eventId); broadcastOddsUpdate(eventId, rows);
  }
}
