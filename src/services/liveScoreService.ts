import axios from 'axios';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { persistFixtureLogos } from './teamLogoService';

export interface LiveScore {
  fixture_id: number;
  home_team: string;
  away_team: string;
  home_logo: string | null;
  away_logo: string | null;
  home_score: number;
  away_score: number;
  minute: number;
  status_short: string; // '1H', 'HT', '2H', 'ET', 'BT', 'P', 'FT'
  league: string;
  country: string;
}

const REDIS_KEY = 'scores:live:all';
const TTL = 90; // seconds

export async function fetchAndCacheLiveScores(): Promise<LiveScore[]> {
  if (!env.API_FOOTBALL_KEY) {
    logger.debug('[LiveScores] API_FOOTBALL_KEY not configured, skipping');
    return [];
  }

  try {
    const resp = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { live: 'all' },
      headers: { 'x-apisports-key': env.API_FOOTBALL_KEY },
      timeout: 12000,
    });

    const fixtures: any[] = resp.data?.response ?? [];

    const scores: LiveScore[] = fixtures.map(f => ({
      fixture_id: f.fixture.id,
      home_team: f.teams.home.name,
      away_team: f.teams.away.name,
      home_logo: f.teams.home.logo ?? null,
      away_logo: f.teams.away.logo ?? null,
      home_score: f.goals.home ?? 0,
      away_score: f.goals.away ?? 0,
      minute: f.fixture.status.elapsed ?? 0,
      status_short: f.fixture.status.short ?? '',
      league: f.league.name,
      country: f.league.country,
    }));

    if (scores.length > 0) {
      await redis.setex(REDIS_KEY, TTL, JSON.stringify(scores));
      logger.info(`[LiveScores] Cached ${scores.length} live matches`);

      // Persist team logos to Supabase as a background side-effect (no await)
      persistFixtureLogos(
        scores.flatMap(s => [
          { teamName: s.home_team, logoUrl: s.home_logo },
          { teamName: s.away_team, logoUrl: s.away_logo },
        ]),
      );
    }

    return scores;
  } catch (err: any) {
    logger.error('[LiveScores] Fetch error', { message: err.message });
    return [];
  }
}

export async function getCachedLiveScores(): Promise<LiveScore[]> {
  const cached = await redis.get(REDIS_KEY);
  return cached ? JSON.parse(cached) : [];
}

/**
 * Finds a live score for a given event name ("TeamA vs TeamB").
 * Matches by checking if both team names appear in the fixture teams, case-insensitive.
 */
export function matchScoreToEvent(
  scores: LiveScore[],
  eventName: string,
): LiveScore | undefined {
  if (!eventName.includes(' vs ')) return undefined;
  const [homeTeam, awayTeam] = eventName.split(' vs ').map(s => s.trim().toLowerCase());

  return scores.find(s => {
    const h = s.home_team.toLowerCase();
    const a = s.away_team.toLowerCase();
    return (
      (h.includes(homeTeam) || homeTeam.includes(h)) &&
      (a.includes(awayTeam) || awayTeam.includes(a))
    );
  });
}
