import { supabase } from '../config/supabase';
import { LiveScore } from './liveScoreService';
import axios from 'axios';
import { env } from '../config/env';
import { redis } from '../config/redis';

export type ScoreProvider = 'api_football' | 'sportmonks';

export function fallbackCanonicalEventId(provider: ScoreProvider, fixtureId: number): string {
  return `live:football:${provider}:${fixtureId}`;
}

/**
 * Resolves an externally supplied fixture to the event id used by every public live endpoint.
 * A previously mapped provider id always wins; otherwise a safe, provider-scoped id is created.
 */
export async function resolveCanonicalEventId(score: LiveScore): Promise<string> {
  const provider = (score.provider ?? 'api_football') as ScoreProvider;
  const providerColumn = provider === 'sportmonks' ? 'sportmonks_fixture_id' : 'api_football_fixture_id';
  const { data: existing } = await supabase.from('live_fixture_mappings')
    .select('canonical_event_id').eq(providerColumn, score.fixture_id).maybeSingle();
  if (existing?.canonical_event_id) return existing.canonical_event_id;

  // A fixture first catalogued as upcoming must keep exactly the same public
  // event id when it becomes live. This also carries its persisted fallback
  // provider mapping into the live odds worker.
  if (provider === 'api_football') {
    const { data: upcoming } = await supabase.from('upcoming_football_fixture_mappings')
      .select('canonical_event_id,odds_api_io_event_id').eq('api_football_fixture_id', score.fixture_id).maybeSingle();
    if (upcoming?.canonical_event_id) {
      await supabase.from('live_fixture_mappings').upsert({
        canonical_event_id: upcoming.canonical_event_id,
        api_football_fixture_id: score.fixture_id,
        odds_api_io_event_id: upcoming.odds_api_io_event_id ?? null,
        sport: 'football', updated_at: new Date().toISOString(),
      }, { onConflict: 'canonical_event_id' });
      return upcoming.canonical_event_id;
    }
  }

  const canonicalEventId = fallbackCanonicalEventId(provider, score.fixture_id);
  await supabase.from('live_fixture_mappings').upsert({
    canonical_event_id: canonicalEventId,
    [providerColumn]: score.fixture_id,
    sport: 'football',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'canonical_event_id' });
  return canonicalEventId;
}

export async function getSportMonksFixtureId(canonicalEventId: string): Promise<number | null> {
  const { data } = await supabase.from('live_fixture_mappings')
    .select('sportmonks_fixture_id').eq('canonical_event_id', canonicalEventId).maybeSingle();
  return data?.sportmonks_fixture_id ?? null;
}

function normalizeTeam(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function sameTeam(a: string, b: string): boolean {
  const left = normalizeTeam(a); const right = normalizeTeam(b);
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * API-Football and SportMonks have unrelated fixture ids. On first live-odds fetch,
 * resolve the SportMonks in-play fixture once and persist the association. SportMonks
 * data is used only for identity/odds here; it never replaces the primary score.
 */
export async function ensureSportMonksFixtureMapping(score: LiveScore, canonicalEventId: string): Promise<number | null> {
  const known = await getSportMonksFixtureId(canonicalEventId);
  if (known) return known;
  if (score.provider === 'sportmonks') {
    await supabase.from('live_fixture_mappings').update({ sportmonks_fixture_id: score.fixture_id, updated_at: new Date().toISOString() }).eq('canonical_event_id', canonicalEventId);
    return score.fixture_id;
  }
  if (!env.SPORTMONKS_API_TOKEN) return null;
  const retryKey = `live_fixture_mapping:retry:${canonicalEventId}`;
  if (await redis.get(retryKey)) return null;
  const resp = await axios.get('https://api.sportmonks.com/v3/football/livescores/inplay', {
    params: { api_token: env.SPORTMONKS_API_TOKEN, include: 'participants' }, timeout: 12_000,
  });
  const match = (resp.data?.data ?? []).find((fixture: any) => {
    const participants = fixture.participants ?? [];
    const home = participants.find((p: any) => p.meta?.location === 'home')?.name;
    const away = participants.find((p: any) => p.meta?.location === 'away')?.name;
    return home && away && sameTeam(home, score.home_team) && sameTeam(away, score.away_team);
  });
  if (!match?.id) {
    await redis.setex(retryKey, 300, '1');
    return null;
  }
  await supabase.from('live_fixture_mappings').update({ sportmonks_fixture_id: match.id, updated_at: new Date().toISOString() }).eq('canonical_event_id', canonicalEventId);
  return match.id;
}
