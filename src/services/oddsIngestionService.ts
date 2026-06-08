import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { broadcastOddsUpdate } from '../socket';
import { logger } from '../utils/logger';
import { env } from '../config/env';

// Map The Odds API sport groups → our sport_type enum values
const GROUP_TO_SPORT: Record<string, string> = {
  'Soccer': 'football',
  'Basketball': 'basketball',
  'Tennis': 'tennis',
  'Horse Racing': 'horse_racing',
  'Greyhound Racing': 'greyhound',
  'American Football': 'american_football',
  'Baseball': 'baseball',
  'Ice Hockey': 'ice_hockey',
  'Cricket': 'cricket',
  'Rugby Union': 'rugby',
  'Rugby League': 'rugby_league',
  'Mixed Martial Arts': 'mma',
  'Golf': 'golf',
  'Australian Rules': 'aussie_rules',
  'Boxing': 'boxing',
};

interface OddsApiSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface OddsApiMarket {
  key: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  markets: OddsApiMarket[];
}

interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

// Prefer sharper bookmakers for more accurate lines
const PREFERRED_BOOKMAKERS = [
  'pinnacle', 'betway', 'williamhill', 'bet365',
  'unibet', 'betfair_ex_uk', 'onexbet', 'draftkings',
];

function pickBookmaker(bookmakers: OddsApiBookmaker[]): OddsApiBookmaker | null {
  if (!bookmakers?.length) return null;
  for (const pref of PREFERRED_BOOKMAKERS) {
    const found = bookmakers.find(b => b.key === pref);
    if (found) return found;
  }
  return bookmakers[0];
}

function buildOddsRows(
  event: OddsApiEvent,
  sport: string,
  league: string,
) {
  const bookmaker = pickBookmaker(event.bookmakers);
  if (!bookmaker) return [];

  const eventName = `${event.home_team} vs ${event.away_team}`;
  const rows = [];

  for (const market of bookmaker.markets) {
    for (const outcome of market.outcomes) {
      let marketType: string;
      let selection: string;

      if (market.key === 'h2h') {
        marketType = 'match_winner';
        if (outcome.name === event.home_team) selection = 'home';
        else if (outcome.name === event.away_team) selection = 'away';
        else selection = 'draw';
      } else if (market.key === 'totals') {
        marketType = 'totals';
        selection = `${outcome.name}${outcome.point != null ? ` ${outcome.point}` : ''}`;
      } else if (market.key === 'spreads') {
        marketType = 'handicap';
        const sign = outcome.point != null
          ? (outcome.point >= 0 ? `+${outcome.point}` : `${outcome.point}`)
          : '';
        selection = `${outcome.name === event.home_team ? 'home' : 'away'} ${sign}`.trim();
      } else {
        marketType = market.key;
        selection = outcome.name;
      }

      rows.push({
        event_id: event.id,
        event_name: eventName,
        market_type: marketType,
        selection,
        odds_value: outcome.price,
        source: 'odds_api',
        sport,
        league,
        starts_at: event.commence_time,
        status: 'active',
        updated_at: new Date().toISOString(),
      });
    }
  }

  return rows;
}

// Fetch all active sports from The Odds API (cached 30 min in Redis)
const SPORTS_CACHE_KEY = 'odds_api:active_sports';

export async function getActiveSports(): Promise<Array<{ key: string; sport: string; league: string }>> {
  const cached = await redis.get(SPORTS_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const resp = await axios.get('https://api.the-odds-api.com/v4/sports', {
    params: { apiKey: env.ODDS_API_KEY },
    timeout: 10000,
  });

  const all: OddsApiSport[] = resp.data;

  const mapped = all
    .filter(s => s.active && !s.has_outrights && GROUP_TO_SPORT[s.group])
    .map(s => ({
      key: s.key,
      sport: GROUP_TO_SPORT[s.group],
      league: s.title,
    }));

  await redis.setex(SPORTS_CACHE_KEY, 1800, JSON.stringify(mapped)); // cache 30 min
  logger.info(`[OddsIngestion] Discovered ${mapped.length} active sports/competitions`);
  return mapped;
}

async function ingestOddsForSport(
  sportConfig: { key: string; sport: string; league: string },
): Promise<number> {
  try {
    const resp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${sportConfig.key}/odds`,
      {
        params: {
          apiKey: env.ODDS_API_KEY,
          regions: 'eu,uk',
          markets: 'h2h,totals',
          oddsFormat: 'decimal',
          dateFormat: 'iso',
        },
        timeout: 15000,
      },
    );

    const events: OddsApiEvent[] = resp.data;
    if (!Array.isArray(events) || events.length === 0) return 0;

    const rows = events.flatMap(e => buildOddsRows(e, sportConfig.sport, sportConfig.league));
    if (rows.length === 0) return 0;

    const eventIds = [...new Set(rows.map(r => r.event_id))];

    // Replace stale entries for these events
    await supabase.from('odds_feed')
      .delete()
      .in('event_id', eventIds)
      .eq('source', 'odds_api');

    const { error } = await supabase.from('odds_feed').insert(rows);
    if (error) {
      logger.error('odds_feed insert error', { message: error.message, sport: sportConfig.key });
      return 0;
    }

    // Cache event_id → sport_key mapping so settlement can look it up after events leave odds_feed
    await Promise.all(
      eventIds.map(id => redis.setex(`event:sport_key:${id}`, 7 * 24 * 3600, sportConfig.key))
    );

    // Bust Redis caches
    await redis.del(REDIS_KEYS.ALL_ODDS);
    await Promise.all(eventIds.map(id => redis.del(REDIS_KEYS.LIVE_ODDS(id))));

    // Broadcast per-event odds updates
    for (const eventId of eventIds) {
      broadcastOddsUpdate(eventId, rows.filter(r => r.event_id === eventId));
    }

    const remaining = resp.headers['x-requests-remaining'];
    logger.info(
      `[OddsIngestion] ${sportConfig.league}: ${eventIds.length} events, ${rows.length} rows. Quota left: ${remaining ?? '?'}`,
    );
    return rows.length;
  } catch (err: any) {
    if (err.response?.status === 404 || err.response?.status === 422) {
      return 0; // no events — normal, not an error
    }
    if (err.response?.status === 401) {
      logger.error('[OddsIngestion] Invalid ODDS_API_KEY');
      throw new Error('INVALID_KEY');
    }
    if (err.response?.status === 429) {
      logger.warn('[OddsIngestion] Rate limited');
      throw new Error('RATE_LIMITED');
    }
    logger.error(`[OddsIngestion] Error for ${sportConfig.key}`, { message: err.message });
    return 0;
  }
}

export async function ingestAllOdds(): Promise<void> {
  if (!env.ODDS_API_KEY) {
    logger.debug('[OddsIngestion] ODDS_API_KEY not configured, skipping');
    return;
  }

  logger.info('[OddsIngestion] Starting ingestion cycle');

  let sports: Array<{ key: string; sport: string; league: string }>;
  try {
    sports = await getActiveSports();
  } catch (err: any) {
    logger.error('[OddsIngestion] Could not fetch sports list', { message: err.message });
    return;
  }

  let totalRows = 0;
  let totalEvents = 0;

  for (const sport of sports) {
    try {
      const n = await ingestOddsForSport(sport);
      if (n > 0) { totalRows += n; totalEvents++; }
    } catch (err: any) {
      if (err.message === 'INVALID_KEY' || err.message === 'RATE_LIMITED') break;
    }
    // Polite pause between requests
    await new Promise(r => setTimeout(r, 250));
  }

  logger.info(`[OddsIngestion] Cycle complete — ${totalEvents} competitions, ${totalRows} total rows`);
}
