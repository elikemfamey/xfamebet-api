import { Router } from 'express';
import { supabase } from '../../config/supabase';
import { redis, REDIS_KEYS } from '../../config/redis';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { getCachedLiveScores } from '../../services/liveScoreService';
import { buildLiveFeed } from '../../services/liveFeedService';
import { getPopularMatches } from '../../services/popularMatchService';

const router = Router();

// GET /matches - list all available matches with odds
router.get('/', async (req, res) => {
  const sport = req.query.sport as string;
  const live = req.query.live === 'true';
  const page = parseInt(req.query.page as string) || 1;
  // High limit so all 35+ market rows per match fit without truncation
  const limit = parseInt(req.query.limit as string) || 1000;
  const offset = (page - 1) * limit;

  // Only cache the unfiltered page-1 response — sport-filtered requests skip
  // cache to avoid collisions, and existing bust logic (del ALL_ODDS) stays valid
  const canCache = !sport && page === 1;
  const cacheKey = REDIS_KEYS.ALL_ODDS;
  if (canCache && !live) {
    const cached = await redis.get(cacheKey);
    if (cached) return sendSuccess(res, JSON.parse(cached));
  }

  let query = supabase
    .from('odds_feed')
    .select('*', { count: 'exact' })
    .eq('status', 'active')
    .order('starts_at', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (sport) query = query.eq('sport', sport);
  if (live) query = query.not('starts_at', 'is', null).lte('starts_at', new Date().toISOString());

  const { data, count } = await query;

  if (canCache && !live) {
    await redis.setex(cacheKey, 30, JSON.stringify(data));
  }

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

// GET /matches/live - live matches (optional ?sport= filter)
router.get('/live', async (req, res) => {
  const sport = req.query.sport as string | undefined;

  let query = supabase
    .from('odds_feed')
    .select('*')
    .eq('status', 'active')
    .lte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true, nullsFirst: false })
    .limit(100);

  if (sport) query = query.eq('sport', sport);

  const { data } = await query;
  return sendSuccess(res, data ?? []);
});

// GET /matches/live-feed - unified live matches (API-Football scores + Odds API odds merged)
router.get('/live-feed', async (req, res) => {
  const sport = (req.query.sport as string) || '';
  const cacheKey = `live_feed:${sport}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return sendSuccess(res, JSON.parse(cached));

    const feed = await buildLiveFeed(sport || undefined);
    await redis.setex(cacheKey, 30, JSON.stringify(feed));
    return sendSuccess(res, feed);
  } catch {
    return sendError(res, 'Failed to build live feed', 500);
  }
});

// GET /matches/scores/live - live scores from API-Football cache
router.get('/scores/live', async (req, res) => {
  const scores = await getCachedLiveScores();
  return sendSuccess(res, scores);
});

// GET /matches/debug/feed-state - inspect what each pipeline stage has (dev only)
router.get('/debug/feed-state', async (req, res) => {
  const { getAllCachedOddsApiScores } = await import('../../services/oddsApiScoreService');
  const [smScores, oddsApiScores, oddsResult] = await Promise.all([
    getCachedLiveScores(),
    getAllCachedOddsApiScores(),
    supabase.from('odds_feed').select('event_id, event_name, sport, status, starts_at').in('status', ['active', 'suspended']).limit(20),
  ]);
  return sendSuccess(res, {
    sportmonks_cached: smScores.length,
    sportmonks_matches: smScores,
    odds_api_events: oddsApiScores.size,
    odds_api_with_scores: Array.from(oddsApiScores.values()).filter(e => e.scores).length,
    odds_feed_rows: oddsResult.data?.length ?? 0,
    odds_feed_sample: oddsResult.data ?? [],
  });
});

// GET /matches/popular - daily curated popular matches (cached 24 h, refreshed at midnight)
router.get('/popular', async (req, res) => {
  try {
    const matches = await getPopularMatches();
    return sendSuccess(res, matches);
  } catch (err) {
    return sendError(res, 'Failed to fetch popular matches', 500);
  }
});

// GET /matches/football/live-stats - cached stats for all live football fixtures
// Returns Record<"af:{fixtureId}", FixtureStats> so the frontend can enrich live cards
router.get('/football/live-stats', async (req, res) => {
  try {
    const scores = await getCachedLiveScores();
    if (!scores.length) return sendSuccess(res, {});

    const keys = scores.map(s => `stats:af:${s.fixture_id}`);
    const raw = await redis.mget(...keys);

    const result: Record<string, unknown> = {};
    for (let i = 0; i < scores.length; i++) {
      if (raw[i]) {
        result[`af:${scores[i].fixture_id}`] = JSON.parse(raw[i]!);
      }
    }
    return sendSuccess(res, result);
  } catch {
    return sendError(res, 'Failed to fetch live stats', 500);
  }
});

// GET /matches/logos?ids=sim:uuid1,sim:uuid2,... - batch logo lookup for simulation matches
// Returns Record<eventId, { home_logo, away_logo }>
router.get('/logos', async (req, res) => {
  const raw = (req.query.ids as string) ?? '';
  const eventIds = raw.split(',').map(s => s.trim()).filter(Boolean);
  const simIds = eventIds.filter(id => id.startsWith('sim:'));

  if (simIds.length === 0) return sendSuccess(res, {});

  const matchIds = simIds.map(id => id.slice(4));
  const { data } = await supabase
    .from('simulated_matches')
    .select('id, home_logo, away_logo')
    .in('id', matchIds);

  const result: Record<string, { home_logo: string | null; away_logo: string | null }> = {};
  for (const row of data ?? []) {
    result[`sim:${row.id}`] = { home_logo: row.home_logo ?? null, away_logo: row.away_logo ?? null };
  }
  return sendSuccess(res, result);
});

// GET /matches/:eventId/meta - logo and metadata for a match (simulation only)
router.get('/:eventId/meta', async (req, res) => {
  const { eventId } = req.params;

  if (!eventId.startsWith('sim:')) {
    return sendSuccess(res, { home_logo: null, away_logo: null });
  }

  const matchId = eventId.slice(4);
  const { data } = await supabase
    .from('simulated_matches')
    .select('home_logo, away_logo')
    .eq('id', matchId)
    .single();

  return sendSuccess(res, {
    home_logo: data?.home_logo ?? null,
    away_logo: data?.away_logo ?? null,
  });
});

// GET /matches/:eventId/odds - all markets for an event
router.get('/:eventId/odds', async (req, res) => {
  const cached = await redis.get(REDIS_KEYS.LIVE_ODDS(req.params.eventId));
  if (cached) return sendSuccess(res, JSON.parse(cached));

  const { data, error } = await supabase
    .from('odds_feed')
    .select('*')
    .eq('event_id', req.params.eventId)
    .eq('status', 'active');

  if (error) return sendError(res, 'Failed to fetch odds', 500);

  await redis.setex(REDIS_KEYS.LIVE_ODDS(req.params.eventId), 15, JSON.stringify(data));
  return sendSuccess(res, data ?? []);
});

export default router;
