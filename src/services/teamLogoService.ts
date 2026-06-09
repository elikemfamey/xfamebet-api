import axios from 'axios';
import { supabase } from '../config/supabase';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

const REDIS_TTL_HIT  = 3600; // 1 hour for found logos
const REDIS_TTL_MISS = 300;  // 5 min for not-found (avoids hammering external APIs)
const REDIS_PREFIX   = 'team_logo:';

export type LogoSource = 'api_football' | 'sportmonks' | 'thesportsdb' | 'manual';

export interface TeamLogoResult {
  team_name: string;
  logo_url: string | null;
  source: LogoSource | null;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function dbGet(teamName: string): Promise<string | null> {
  const { data } = await supabase
    .from('team_logos')
    .select('logo_url')
    .ilike('team_name', teamName)
    .maybeSingle();
  return data?.logo_url ?? null;
}

async function dbUpsert(teamName: string, logoUrl: string | null, source: LogoSource): Promise<void> {
  const { error } = await supabase
    .from('team_logos')
    .upsert(
      { team_name: teamName, logo_url: logoUrl, source, updated_at: new Date().toISOString() },
      { onConflict: 'team_name' },
    );
  if (error) {
    logger.warn('[TeamLogo] DB upsert failed', { teamName, error: error.message });
  }
}

// ── External API fetchers ─────────────────────────────────────────────────────

const INDIVIDUAL_SPORTS = new Set(['tennis', 'boxing', 'mma', 'golf']);

async function fromTheSportsDB(name: string, sport?: string): Promise<string | null> {
  try {
    const isIndividual = sport ? INDIVIDUAL_SPORTS.has(sport) : false;
    if (isIndividual) {
      const res = await axios.get('https://www.thesportsdb.com/api/v1/json/3/searchplayers.php', {
        params: { p: name },
        timeout: 5000,
      });
      const player = res.data?.player?.[0];
      return (player?.strCutout || player?.strThumb) as string | undefined ?? null;
    }
    const res = await axios.get('https://www.thesportsdb.com/api/v1/json/3/searchteams.php', {
      params: { t: name },
      timeout: 5000,
    });
    return (res.data?.teams?.[0]?.strTeamBadge as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Resolves a team logo URL through the full cache/lookup chain:
 *   knownLogoUrl → Redis → Supabase → TheSportsDB
 *
 * Pass knownLogoUrl when you already have the URL from an API-Football
 * fixture response — it will be persisted asynchronously and returned immediately.
 */
export async function resolveTeamLogo(
  teamName: string,
  knownLogoUrl?: string | null,
  sport?: string,
): Promise<TeamLogoResult> {
  const key = teamName.trim();
  if (!key) return { team_name: teamName, logo_url: null, source: null };

  // 1. Caller already has the logo from an API-Football fixture — persist & return
  if (knownLogoUrl) {
    dbUpsert(key, knownLogoUrl, 'api_football').catch(() => {});
    return { team_name: key, logo_url: knownLogoUrl, source: 'api_football' };
  }

  const cacheKey = `${REDIS_PREFIX}${key.toLowerCase()}`;

  // 2. Redis cache
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) as TeamLogoResult;
  } catch {
    // Redis unavailable — continue to next layer
  }

  // 3. Supabase (populated automatically by persistFixtureLogos during live score sync)
  const dbLogo = await dbGet(key).catch(() => null);
  if (dbLogo) {
    const result: TeamLogoResult = { team_name: key, logo_url: dbLogo, source: 'api_football' };
    redis.setex(cacheKey, REDIS_TTL_HIT, JSON.stringify(result)).catch(() => {});
    return result;
  }

  // 4. TheSportsDB name lookup (no key required, fast — skipping slow API-Football team search)
  const sdbLogo = await fromTheSportsDB(key, sport);
  if (sdbLogo) {
    const result: TeamLogoResult = { team_name: key, logo_url: sdbLogo, source: 'thesportsdb' };
    await Promise.all([
      dbUpsert(key, sdbLogo, 'thesportsdb'),
      redis.setex(cacheKey, REDIS_TTL_HIT, JSON.stringify(result)).catch(() => {}),
    ]);
    return result;
  }

  // 5. Nothing found — cache briefly to prevent hammering
  const emptyResult: TeamLogoResult = { team_name: key, logo_url: null, source: null };
  redis.setex(cacheKey, REDIS_TTL_MISS, JSON.stringify(emptyResult)).catch(() => {});
  return emptyResult;
}

/**
 * Bulk-persist logo URLs from a live score sync batch.
 * Call without await — this is intentionally fire-and-forget.
 */
export function persistFixtureLogos(
  fixtures: Array<{ teamName: string; logoUrl: string | null; source?: LogoSource }>,
  defaultSource: LogoSource = 'api_football',
): void {
  for (const { teamName, logoUrl, source } of fixtures) {
    if (teamName && logoUrl) {
      dbUpsert(teamName, logoUrl, source ?? defaultSource).catch(() => {});
    }
  }
}
