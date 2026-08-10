import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis } from '../config/redis';

const CACHE_PREFIX = 'league_logo:';
const HIT_TTL = 3600;
const MISS_TTL = 300;

export interface LeagueLogoResult {
  league_name: string;
  logo_url: string | null;
  source: 'thesportsdb' | 'manual' | null;
}

const LEAGUE_LOOKUPS: Record<string, { country: string; league: string; sport?: string }> = {
  'premier league': { country: 'England', league: 'English Premier League' },
  'english premier league': { country: 'England', league: 'English Premier League' },
  'la liga': { country: 'Spain', league: 'Spanish La Liga' },
  'serie a': { country: 'Italy', league: 'Italian Serie A' },
  bundesliga: { country: 'Germany', league: 'German Bundesliga' },
  'ligue 1': { country: 'France', league: 'French Ligue 1' },
  'champions league': { country: 'International', league: 'UEFA Champions League' },
  'uefa champions league': { country: 'International', league: 'UEFA Champions League' },
};

function keyFor(name: string) { return name.trim().toLowerCase(); }

async function getStored(name: string) {
  const { data } = await supabase.from('league_logos').select('logo_url, source').ilike('league_name', name).maybeSingle();
  return data as { logo_url: string | null; source: 'thesportsdb' | 'manual' } | null;
}

async function store(name: string, logoUrl: string | null, source: 'thesportsdb' | 'manual') {
  await supabase.from('league_logos').upsert(
    { league_name: name, logo_url: logoUrl, source, updated_at: new Date().toISOString() },
    { onConflict: 'league_name' },
  );
}

async function fetchFromSportsDb(name: string, sport?: string): Promise<string | null> {
  const lookup = LEAGUE_LOOKUPS[keyFor(name)];
  if (!lookup) return null;
  const response = await axios.get('https://www.thesportsdb.com/api/v1/json/3/search_all_leagues.php', {
    params: { c: lookup.country, s: sport === 'basketball' ? 'Basketball' : 'Soccer' },
    timeout: 5000,
  });
  const expected = lookup.league.toLowerCase();
  const league = (response.data?.countries ?? []).find((item: { strLeague?: string }) => item.strLeague?.toLowerCase() === expected);
  return league?.strBadge ?? null;
}

export async function resolveLeagueLogo(leagueName: string, sport?: string): Promise<LeagueLogoResult> {
  const name = leagueName.trim();
  if (!name) return { league_name: leagueName, logo_url: null, source: null };
  const cacheKey = `${CACHE_PREFIX}${keyFor(name)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as LeagueLogoResult;
  } catch {}

  const stored = await getStored(name).catch(() => null);
  if (stored?.logo_url) {
    const result: LeagueLogoResult = { league_name: name, logo_url: stored.logo_url, source: stored.source };
    redis.setex(cacheKey, HIT_TTL, JSON.stringify(result)).catch(() => {});
    return result;
  }

  const remoteUrl = await fetchFromSportsDb(name, sport).catch(() => null);
  if (remoteUrl) {
    const result: LeagueLogoResult = { league_name: name, logo_url: remoteUrl, source: 'thesportsdb' };
    await Promise.all([store(name, remoteUrl, 'thesportsdb').catch(() => {}), redis.setex(cacheKey, HIT_TTL, JSON.stringify(result)).catch(() => {})]);
    return result;
  }

  const result: LeagueLogoResult = { league_name: name, logo_url: null, source: null };
  redis.setex(cacheKey, MISS_TTL, JSON.stringify(result)).catch(() => {});
  return result;
}
