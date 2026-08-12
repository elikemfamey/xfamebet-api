import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { broadcastOddsUpdate } from '../socket';

const SPORTMONKS_BASE = 'https://api.sportmonks.com/v3/football';
export const UPCOMING_ODDS_MAX_AGE_MS = 60 * 60 * 1000;
const HEALTH_KEY = 'upcoming_football:provider_health';
const FIXTURE_WINDOW_DAYS = 3;
const MAX_FIXTURES_PER_CYCLE = 150;
const ODDS_REQUEST_CONCURRENCY = 5;

type ProviderFixture = { id: number; starting_at?: string; league?: { id?: number; name?: string; country?: { name?: string } }; participants?: Array<{ name?: string; meta?: { location?: string } }> };
type ProviderOdd = { label?: string; name?: string; value?: number | string; market_description?: string; market_id?: number; total?: number | string | null; suspended?: boolean; stopped?: boolean; latest_bookmaker_update?: string; updated_at?: string };
type Mapping = { canonical_event_id: string; sportmonks_fixture_id?: number | null; odds_api_event_id?: string | null; home_team: string; away_team: string; starts_at: string; competition_key: string; competition_name: string; country_name?: string | null };

function normal(value: string): string { return value.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function fixtureName(home: string, away: string) { return `${home} vs ${away}`; }
function providerTeams(fixture: ProviderFixture) {
  const participants = fixture.participants ?? [];
  return {
    home: participants.find(item => item.meta?.location === 'home')?.name ?? '',
    away: participants.find(item => item.meta?.location === 'away')?.name ?? '',
  };
}
function normalizeOdd(odd: ProviderOdd) {
  const value = Number(odd.value);
  if (!Number.isFinite(value) || value < 1.01) return null;
  const description = (odd.market_description ?? '').toLowerCase();
  const label = (odd.label ?? odd.name ?? '').trim();
  let market_type = `sportmonks_${odd.market_id ?? 'market'}`;
  let selection = label.toLowerCase();
  if (/(fulltime result|match winner|1x2)/.test(description)) {
    market_type = 'match_winner';
    selection = label === '1' || /^home$/i.test(label) ? 'home' : label === '2' || /^away$/i.test(label) ? 'away' : 'draw';
  } else if (/over.?under|total goals/.test(description)) {
    market_type = 'totals'; selection = `${label}${odd.total != null ? ` ${odd.total}` : ''}`.trim();
  }
  return { market_type, selection, odds_value: value, active: !odd.suspended && !odd.stopped, provider_updated_at: odd.latest_bookmaker_update ?? odd.updated_at ?? new Date().toISOString() };
}

async function clearCaches(eventIds: string[]) {
  await redis.del(REDIS_KEYS.ALL_ODDS);
  await Promise.all(eventIds.map(id => redis.del(REDIS_KEYS.LIVE_ODDS(id))));
}

async function upsertMapping(input: Omit<Mapping, 'canonical_event_id'> & { canonical_event_id?: string }): Promise<Mapping> {
  const existingByProvider = input.sportmonks_fixture_id
    ? await supabase.from('upcoming_football_fixture_mappings').select('*').eq('sportmonks_fixture_id', input.sportmonks_fixture_id).maybeSingle()
    : input.odds_api_event_id
      ? await supabase.from('upcoming_football_fixture_mappings').select('*').eq('odds_api_event_id', input.odds_api_event_id).maybeSingle()
      : { data: null };
  if (existingByProvider.data) return existingByProvider.data as Mapping;
  const { data: candidates } = await supabase.from('upcoming_football_fixture_mappings').select('*')
    .gte('starts_at', new Date(new Date(input.starts_at).getTime() - 10 * 60_000).toISOString())
    .lte('starts_at', new Date(new Date(input.starts_at).getTime() + 10 * 60_000).toISOString()).limit(1);
  const candidate = (candidates ?? []).find((row: Mapping) => normal(row.home_team) === normal(input.home_team) && normal(row.away_team) === normal(input.away_team)) as Mapping | undefined;
  const canonical_event_id = candidate?.canonical_event_id ?? input.canonical_event_id ?? `upcoming:football:${input.sportmonks_fixture_id ? `sportmonks:${input.sportmonks_fixture_id}` : `odds-api:${input.odds_api_event_id}`}`;
  const row = { ...input, canonical_event_id, sport: 'football', updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('upcoming_football_fixture_mappings').upsert({ ...candidate, ...row }, { onConflict: 'canonical_event_id' }).select('*').single();
  if (error) throw error;
  return data as Mapping;
}

async function writeSnapshot(mapping: Mapping, source: 'sportmonks_upcoming' | 'odds_api_upcoming_fallback', odds: Array<NonNullable<ReturnType<typeof normalizeOdd>> | any>) {
  const now = new Date().toISOString();
  const { data: existing } = await supabase.from('odds_feed').select('source,provider_updated_at,updated_at')
    .eq('event_id', mapping.canonical_event_id).eq('is_live', false).limit(1);
  const first = existing?.[0];
  const freshPrimary = first?.source === 'sportmonks_upcoming' && Date.now() - new Date(first.provider_updated_at ?? first.updated_at).getTime() <= UPCOMING_ODDS_MAX_AGE_MS;
  if (source === 'odds_api_upcoming_fallback' && freshPrimary) return;
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

async function ingestOddsApiFallback() {
  const { data } = await supabase.from('odds_feed').select('*').eq('source', 'odds_api').eq('sport', 'football').eq('status', 'active')
    .gt('starts_at', new Date().toISOString()).gte('updated_at', new Date(Date.now() - UPCOMING_ODDS_MAX_AGE_MS).toISOString()).limit(5000);
  const events = new Map<string, any[]>();
  for (const row of data ?? []) events.set(row.event_id, [...(events.get(row.event_id) ?? []), row]);
  for (const [oddsApiEventId, rows] of events) {
    const first = rows[0]; const [home_team = '', away_team = ''] = String(first.event_name ?? '').split(/\s+vs\.?\s+/i);
    if (!home_team || !away_team || !first.starts_at) continue;
    const mapping = await upsertMapping({ odds_api_event_id: oddsApiEventId, home_team, away_team, starts_at: first.starts_at, competition_key: `odds-api:${first.league ?? 'unknown'}`, competition_name: first.league ?? 'Other Football', country_name: first.country_name ?? null });
    await writeSnapshot(mapping, 'odds_api_upcoming_fallback', rows.map(row => ({ ...row, active: true, provider_updated_at: row.updated_at })));
  }
}

export async function expireStaleUpcomingFootballOdds(): Promise<void> {
  const cutoff = new Date(Date.now() - UPCOMING_ODDS_MAX_AGE_MS).toISOString();
  const { data } = await supabase.from('odds_feed').update({ status: 'suspended', lock_reason: 'Markets suspended because the verified price is over one hour old.', updated_at: new Date().toISOString() })
    .eq('sport', 'football').eq('is_live', false).in('source', ['sportmonks_upcoming', 'odds_api_upcoming_fallback']).eq('status', 'active').lt('provider_updated_at', cutoff).select('event_id');
  const ids = [...new Set((data ?? []).map(row => row.event_id))];
  if (ids.length) await clearCaches(ids);
}

export async function ingestUpcomingFootballOdds(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    if (!env.SPORTMONKS_API_TOKEN) throw new Error('SPORTMONKS_API_TOKEN not configured');
    const start = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + FIXTURE_WINDOW_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const response = await axios.get(`${SPORTMONKS_BASE}/fixtures/between/${start}/${end}`, { params: { api_token: env.SPORTMONKS_API_TOKEN, include: 'participants;league;league.country' }, timeout: 12_000 });
    const fixtures = response.data?.data;
    if (!Array.isArray(fixtures)) throw new Error('SportMonks returned malformed upcoming fixtures');
    let primaryOddsUnavailable = false;
    const eligibleFixtures = (fixtures as ProviderFixture[]).filter(fixture => {
      const { home, away } = providerTeams(fixture);
      return !!fixture.id && !!home && !!away && !!fixture.starting_at && new Date(fixture.starting_at!).getTime() > Date.now();
    }).slice(0, MAX_FIXTURES_PER_CYCLE);
    for (let index = 0; index < eligibleFixtures.length; index += ODDS_REQUEST_CONCURRENCY) {
      const batch = eligibleFixtures.slice(index, index + ODDS_REQUEST_CONCURRENCY);
      const results = await Promise.all(batch.map(async fixture => {
        const { home, away } = providerTeams(fixture);
      const mapping = await upsertMapping({ sportmonks_fixture_id: fixture.id, home_team: home, away_team: away, starts_at: fixture.starting_at!, competition_key: `sportmonks:${fixture.league?.id ?? fixture.league?.name ?? 'unknown'}`, competition_name: fixture.league?.name ?? 'Other Football', country_name: fixture.league?.country?.name ?? null });
      try {
        const oddsResponse = await axios.get(`${SPORTMONKS_BASE}/odds/pre-match/fixtures/${fixture.id}`, { params: { api_token: env.SPORTMONKS_API_TOKEN }, timeout: 12_000 });
        const odds = (oddsResponse.data?.data ?? []).map(normalizeOdd).filter(Boolean) as Array<NonNullable<ReturnType<typeof normalizeOdd>>>;
        if (odds.length) await writeSnapshot(mapping, 'sportmonks_upcoming', odds);
        else return false;
      } catch (error: any) { logger.warn('[UpcomingFootball] SportMonks fixture odds unavailable', { fixtureId: fixture.id, message: error.message }); return false; }
      return true;
      }));
      if (results.some(result => !result)) primaryOddsUnavailable = true;
    }
    // A healthy fixture listing can still have an unavailable odds endpoint.
    // Reconcile and use fallback prices only for events without a fresh primary.
    if (primaryOddsUnavailable) await ingestOddsApiFallback();
    await redis.set(HEALTH_KEY, JSON.stringify({ activeSource: 'sportmonks', lastSuccessAt: startedAt, lastFailureAt: null, freshnessMs: UPCOMING_ODDS_MAX_AGE_MS }));
  } catch (error: any) {
    logger.warn('[UpcomingFootball] SportMonks failed; using The Odds API fallback', { message: error.message });
    try {
      await ingestOddsApiFallback();
      await redis.set(HEALTH_KEY, JSON.stringify({ activeSource: 'odds_api', lastSuccessAt: new Date().toISOString(), lastFailureAt: startedAt, lastFailure: error.message, freshnessMs: UPCOMING_ODDS_MAX_AGE_MS }));
    } catch (fallbackError: any) {
      logger.error('[UpcomingFootball] Both odds providers failed', { message: fallbackError.message });
      await redis.set(HEALTH_KEY, JSON.stringify({ activeSource: 'unavailable', lastSuccessAt: null, lastFailureAt: new Date().toISOString(), lastFailure: `${error.message}; fallback: ${fallbackError.message}`, freshnessMs: UPCOMING_ODDS_MAX_AGE_MS }));
    }
  }
  await expireStaleUpcomingFootballOdds();
}

export async function getUpcomingFootballFixtures() {
  const now = new Date().toISOString();
  const { data: mappings, error } = await supabase.from('upcoming_football_fixture_mappings').select('*').gt('starts_at', now).order('starts_at').limit(1000);
  // A missing migration must not turn the public sportsbook into a hanging
  // request. The client will immediately use the established generic feed.
  if (error) {
    logger.error('[UpcomingFootball] Fixture mapping query failed', { message: error.message });
    return [];
  }
  const ids = (mappings ?? []).map(row => row.canonical_event_id);
  const { data: rows } = ids.length ? await supabase.from('odds_feed').select('*').in('event_id', ids).eq('is_live', false).in('status', ['active', 'suspended']) : { data: [] as any[] };
  const byEvent = new Map<string, any[]>(); for (const row of rows ?? []) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);
  const canonicalFixtures = (mappings ?? []).map((mapping: Mapping) => {
    const odds = byEvent.get(mapping.canonical_event_id) ?? [];
    const fresh = odds.some(row => row.status === 'active' && row.provider_updated_at && Date.now() - new Date(row.provider_updated_at).getTime() <= UPCOMING_ODDS_MAX_AGE_MS);
    return { eventId: mapping.canonical_event_id, home: mapping.home_team, away: mapping.away_team, startsAt: mapping.starts_at, sport: 'football', competitionKey: mapping.competition_key, competitionName: mapping.competition_name, country: mapping.country_name ?? null,
      oddsStatus: fresh ? 'active' : 'suspended', oddsLockReason: fresh ? undefined : odds[0]?.lock_reason ?? 'Markets suspended while verified prices are unavailable.', odds };
  });
  if (canonicalFixtures.length) return canonicalFixtures;

  // Deployment recovery: before the first canonical cycle completes (or when
  // migration 024 has just been applied), expose previously ingested upcoming
  // football rows rather than making the sportsbook appear empty.
  const { data: legacyRows, error: legacyError } = await supabase.from('odds_feed').select('*')
    .eq('sport', 'football').eq('status', 'active').gt('starts_at', now)
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
