import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { broadcastOddsUpdate } from '../socket';

export const UPCOMING_ODDS_MAX_AGE_MS = 60 * 60 * 1000;
const HEALTH_KEY = 'upcoming_football:provider_health';
export const UPCOMING_FIXTURE_WINDOW_DAYS = 14;

type Mapping = { canonical_event_id: string; sportmonks_fixture_id?: number | null; api_football_fixture_id?: number | null; odds_api_event_id?: string | null; home_team: string; away_team: string; starts_at: string; competition_key: string; competition_name: string; country_name?: string | null };

function normal(value: string): string { return value.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function fixtureName(home: string, away: string) { return `${home} vs ${away}`; }

async function clearCaches(eventIds: string[]) {
  await redis.del(REDIS_KEYS.ALL_ODDS);
  await Promise.all(eventIds.map(id => redis.del(REDIS_KEYS.LIVE_ODDS(id))));
}

async function upsertMapping(input: Omit<Mapping, 'canonical_event_id'> & { canonical_event_id?: string }): Promise<Mapping> {
  const existingByProvider = input.sportmonks_fixture_id
    ? await supabase.from('upcoming_football_fixture_mappings').select('*').eq('sportmonks_fixture_id', input.sportmonks_fixture_id).maybeSingle()
    : input.api_football_fixture_id
      ? await supabase.from('upcoming_football_fixture_mappings').select('*').eq('api_football_fixture_id', input.api_football_fixture_id).maybeSingle()
    : input.odds_api_event_id
      ? await supabase.from('upcoming_football_fixture_mappings').select('*').eq('odds_api_event_id', input.odds_api_event_id).maybeSingle()
      : { data: null };
  if (existingByProvider.data) return existingByProvider.data as Mapping;
  const { data: candidates } = await supabase.from('upcoming_football_fixture_mappings').select('*')
    .gte('starts_at', new Date(new Date(input.starts_at).getTime() - 10 * 60_000).toISOString())
    .lte('starts_at', new Date(new Date(input.starts_at).getTime() + 10 * 60_000).toISOString()).limit(1);
  const candidate = (candidates ?? []).find((row: Mapping) => normal(row.home_team) === normal(input.home_team) && normal(row.away_team) === normal(input.away_team)) as Mapping | undefined;
  const canonical_event_id = candidate?.canonical_event_id ?? input.canonical_event_id ?? `upcoming:football:${input.sportmonks_fixture_id ? `sportmonks:${input.sportmonks_fixture_id}` : input.api_football_fixture_id ? `api-football:${input.api_football_fixture_id}` : `odds-api:${input.odds_api_event_id}`}`;
  const row = { ...input, canonical_event_id, sport: 'football', updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('upcoming_football_fixture_mappings').upsert({ ...candidate, ...row }, { onConflict: 'canonical_event_id' }).select('*').single();
  if (error) throw error;
  return data as Mapping;
}

async function writeSnapshot(mapping: Mapping, source: 'api_football_upcoming', odds: any[]) {
  const now = new Date().toISOString();
  await supabase.from('odds_feed').update({ status: 'suspended', lock_reason: 'Awaiting a refreshed verified upcoming price.', updated_at: now })
    .eq('event_id', mapping.canonical_event_id).eq('is_live', false);
  const rows = odds.map(odd => ({ event_id: mapping.canonical_event_id, event_name: fixtureName(mapping.home_team, mapping.away_team), market_type: odd.market_type, selection: odd.selection, odds_value: odd.odds_value,
    source, sport: 'football', league: mapping.competition_name, competition_key: mapping.competition_key, country_name: mapping.country_name ?? null, starts_at: mapping.starts_at,
    status: odd.active === false ? 'suspended' : 'active', lock_reason: odd.active === false ? 'Suspended by the odds provider.' : null, is_live: false, provider_updated_at: odd.provider_updated_at ?? now, updated_at: now }));
  if (!rows.length) return;
  const { error } = await supabase.from('odds_feed').upsert(rows, { onConflict: 'event_id,market_type,selection' });
  if (error) throw error;
  await clearCaches([mapping.canonical_event_id]);
  broadcastOddsUpdate(mapping.canonical_event_id, rows);
}

function apiFootballOdds(event: any) {
  const bookmaker = event.bookmakers?.[0];
  const market = bookmaker?.bets?.find((bet: any) => /match winner|winner|1x2/i.test(bet.name ?? ''));
  if (!market?.values) return [];
  return market.values.map((value: any) => {
    const label = String(value.value ?? '').trim();
    const selection = label === 'Home' || label === '1' ? 'home' : label === 'Away' || label === '2' ? 'away' : 'draw';
    return { market_type: 'match_winner', selection, odds_value: Number(value.odd), active: true, provider_updated_at: event.update ?? new Date().toISOString() };
  }).filter((odd: any) => Number.isFinite(odd.odds_value) && odd.odds_value >= 1.01);
}

async function ingestApiFootballUpcomingOdds() {
  if (!env.API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not configured');
  // Fixtures and prices are deliberately separate: fixtures remain visible
  // with suspended markets even when an upcoming match has no listed price.
  const dates = Array.from({ length: UPCOMING_FIXTURE_WINDOW_DAYS }, (_, index) =>
    new Date(Date.now() + index * 86_400_000).toISOString().slice(0, 10));
  const fixtureResponses = await Promise.all(dates.map(date => axios.get('https://v3.football.api-sports.io/fixtures', {
    params: { date }, headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, timeout: 12_000,
  })));
  const fixtures = fixtureResponses.flatMap(response => {
    if (!Array.isArray(response.data?.response)) throw new Error('API-Football returned malformed upcoming fixtures');
    return response.data.response;
  });
  for (const event of fixtures) {
    const fixture = event.fixture; const home = event.teams?.home?.name; const away = event.teams?.away?.name;
    if (!fixture?.id || !fixture.date || !home || !away || new Date(fixture.date).getTime() <= Date.now()) continue;
    await upsertMapping({ api_football_fixture_id: fixture.id, home_team: home, away_team: away, starts_at: fixture.date, competition_key: `api-football:${event.league?.id ?? 'unknown'}`, competition_name: event.league?.name ?? 'Other Football', country_name: event.league?.country ?? null });
  }

  let pricedEvents = 0;
  for (const date of dates) {
    for (let page = 1; page <= 10; page++) {
      const response = await axios.get('https://v3.football.api-sports.io/odds', { params: { date, page }, headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, timeout: 12_000 });
      const events = response.data?.response;
      if (!Array.isArray(events) || !events.length) break;
      for (const event of events) {
        const fixture = event.fixture; const home = event.teams?.home?.name; const away = event.teams?.away?.name;
        if (!fixture?.id || !fixture.date || !home || !away) continue;
        const odds = apiFootballOdds(event); if (!odds.length) continue;
        const mapping = await upsertMapping({ api_football_fixture_id: fixture.id, home_team: home, away_team: away, starts_at: fixture.date, competition_key: `api-football:${event.league?.id ?? 'unknown'}`, competition_name: event.league?.name ?? 'Other Football', country_name: event.league?.country ?? null });
        await writeSnapshot(mapping, 'api_football_upcoming', odds);
        pricedEvents += 1;
      }
      if ((response.data?.paging?.current ?? page) >= (response.data?.paging?.total ?? page)) break;
    }
  }
  logger.info('[UpcomingFootball] API-Football catalogue refreshed', { fixtures: fixtures.length, pricedEvents, days: UPCOMING_FIXTURE_WINDOW_DAYS });
}

export async function expireStaleUpcomingFootballOdds(): Promise<void> {
  const cutoff = new Date(Date.now() - UPCOMING_ODDS_MAX_AGE_MS).toISOString();
  const { data } = await supabase.from('odds_feed').update({ status: 'suspended', lock_reason: 'Markets suspended because the verified price is over one hour old.', updated_at: new Date().toISOString() })
    .eq('sport', 'football').eq('is_live', false).in('source', ['api_football_upcoming']).eq('status', 'active').lt('provider_updated_at', cutoff).select('event_id');
  const ids = [...new Set((data ?? []).map(row => row.event_id))];
  if (ids.length) await clearCaches(ids);
}

export async function ingestUpcomingFootballOdds(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    await ingestApiFootballUpcomingOdds();
    await redis.set(HEALTH_KEY, JSON.stringify({ activeSource: 'api_football', lastSuccessAt: startedAt, lastFailureAt: null, freshnessMs: UPCOMING_ODDS_MAX_AGE_MS }));
  } catch (error: any) {
    // Keep the last accepted API-Football snapshot through its one-hour
    // freshness window; never overwrite it with another provider's data.
    logger.warn('[UpcomingFootball] API-Football upcoming ingestion failed', { message: error.message });
    const previous = await redis.get(HEALTH_KEY);
    let lastSuccessAt: string | null = null;
    try { lastSuccessAt = previous ? JSON.parse(previous).lastSuccessAt ?? null : null; } catch { /* ignore corrupt health metadata */ }
    await redis.set(HEALTH_KEY, JSON.stringify({ activeSource: 'api_football_unavailable', lastSuccessAt, lastFailureAt: startedAt, lastFailure: error.message, freshnessMs: UPCOMING_ODDS_MAX_AGE_MS }));
  }
  await expireStaleUpcomingFootballOdds();
}

export async function getUpcomingFootballFixtures(liveFixtureIds: number[] = []) {
  const now = new Date().toISOString();
  const end = new Date(Date.now() + UPCOMING_FIXTURE_WINDOW_DAYS * 86_400_000).toISOString();
  const [{ data: futureMappings, error }, { data: liveMappings }] = await Promise.all([
    supabase.from('upcoming_football_fixture_mappings').select('*').gt('starts_at', now).lte('starts_at', end).order('starts_at').limit(5000),
    liveFixtureIds.length ? supabase.from('upcoming_football_fixture_mappings').select('*').in('api_football_fixture_id', liveFixtureIds) : Promise.resolve({ data: [] as Mapping[] }),
  ]);
  const mappings = [...new Map([...(futureMappings ?? []), ...(liveMappings ?? [])].map((mapping: any) => [mapping.canonical_event_id, mapping])).values()];
  // A missing migration must not turn the public sportsbook into a hanging
  // request. The client will immediately use the established generic feed.
  if (error) {
    logger.error('[UpcomingFootball] Fixture mapping query failed', { message: error.message });
    return [];
  }
  const ids = mappings.map(row => row.canonical_event_id);
  const { data: rows } = ids.length ? await supabase.from('odds_feed').select('*').in('event_id', ids).eq('is_live', false).eq('source', 'api_football_upcoming').in('status', ['active', 'suspended']) : { data: [] as any[] };
  const byEvent = new Map<string, any[]>(); for (const row of rows ?? []) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);
  const canonicalFixtures = mappings.map((mapping: Mapping) => {
    const odds = byEvent.get(mapping.canonical_event_id) ?? [];
    const fresh = odds.some(row => row.status === 'active' && row.provider_updated_at && Date.now() - new Date(row.provider_updated_at).getTime() <= UPCOMING_ODDS_MAX_AGE_MS);
    return { eventId: mapping.canonical_event_id, apiFootballFixtureId: mapping.api_football_fixture_id ?? null, home: mapping.home_team, away: mapping.away_team, startsAt: mapping.starts_at, sport: 'football', competitionKey: mapping.competition_key, competitionName: mapping.competition_name, country: mapping.country_name ?? null,
      oddsStatus: fresh ? 'active' : 'suspended', oddsLockReason: fresh ? undefined : odds[0]?.lock_reason ?? 'Markets suspended while verified prices are unavailable.', odds };
  });
  if (canonicalFixtures.length) return canonicalFixtures;

  // Deployment recovery: before the first canonical cycle completes (or when
  // migration 024 has just been applied), expose previously ingested upcoming
  // football rows rather than making the sportsbook appear empty.
  const { data: legacyRows, error: legacyError } = await supabase.from('odds_feed').select('*')
    .eq('sport', 'football').eq('status', 'active').in('source', ['api_football_upcoming']).gt('starts_at', now)
    .order('starts_at', { ascending: true }).limit(3000);
  if (legacyError) {
    logger.error('[UpcomingFootball] Legacy recovery query failed', { message: legacyError.message });
    return [];
  }
  const legacyByEvent = new Map<string, any[]>();
  for (const row of legacyRows ?? []) legacyByEvent.set(row.event_id, [...(legacyByEvent.get(row.event_id) ?? []), row]);
  return [...legacyByEvent.entries()].map(([eventId, eventOdds]) => {
    const first = eventOdds[0];
    const [home = 'Home', away = 'Away'] = String(first.event_name ?? '').split(/\s+vs\.?\s+/i);
    const competitionName = first.league ?? 'Other Football';
    return { eventId, home, away, startsAt: first.starts_at, sport: 'football', competitionKey: `recovery:${competitionName}`, competitionName, country: first.country_name ?? null,
      oddsStatus: 'active', odds: eventOdds };
  });
}
