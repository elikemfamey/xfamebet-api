import axios from 'axios';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export interface OddsApiScoreEntry {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  completed: boolean;
  scores: Array<{ name: string; score: string }> | null;
  last_update: string | null;
}

const SCORE_TTL = 150; // 150 seconds — outlasts the 2-min poller interval so cache never goes dark

function scoreKey(sportKey: string) {
  return `scores:odds_api:${sportKey}`;
}

export async function fetchAndCacheScoresForSport(sportKey: string): Promise<void> {
  try {
    const resp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/`,
      {
        params: { apiKey: env.ODDS_API_KEY, dateFormat: 'iso' },
        timeout: 12000,
      },
    );
    const entries: OddsApiScoreEntry[] = resp.data ?? [];
    await redis.setex(scoreKey(sportKey), SCORE_TTL, JSON.stringify(entries));

    const live = entries.filter(e => !e.completed && e.scores).length;
    if (live > 0) {
      logger.info(`[OddsScores] ${sportKey}: ${live} live events`);
    }
  } catch (err: any) {
    // 422 = no scores endpoint for this sport (e.g. outrights) — not an error
    if (err.response?.status === 404 || err.response?.status === 422) return;
    logger.error(`[OddsScores] Fetch failed for ${sportKey}`, { message: err.message });
  }
}

export async function getCachedScoresForSport(sportKey: string): Promise<OddsApiScoreEntry[]> {
  const cached = await redis.get(scoreKey(sportKey));
  return cached ? JSON.parse(cached) : [];
}

/**
 * Returns a map of event_id → score entry for ALL cached sports.
 * Only includes events that have scores data (live or recently completed).
 */
export async function getAllCachedOddsApiScores(): Promise<Map<string, OddsApiScoreEntry>> {
  const keys = await redis.keys('scores:odds_api:*');
  const result = new Map<string, OddsApiScoreEntry>();
  if (!keys.length) return result;

  const values = await redis.mget(...keys);
  for (const val of values) {
    if (!val) continue;
    const entries: OddsApiScoreEntry[] = JSON.parse(val);
    for (const entry of entries) {
      // Include all entries (with or without scores) so we can filter completed events
      result.set(entry.id, entry);
    }
  }
  return result;
}

/**
 * Fetches scores for all provided sport keys.
 * Politely pauses 200ms between each call to avoid rate-limiting.
 */
export async function fetchAllSportsScores(sportKeys: string[]): Promise<void> {
  if (!env.ODDS_API_KEY) return;

  for (const sportKey of sportKeys) {
    await fetchAndCacheScoresForSport(sportKey);
    await new Promise(r => setTimeout(r, 200));
  }
}
