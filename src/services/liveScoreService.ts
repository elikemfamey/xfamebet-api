import axios from 'axios';
import { redis } from '../config/redis';
import { broadcastLiveScoresUpdate, broadcastFixtureUpdate, FixtureStats, FixtureCommentaryEvent } from '../socket';
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

// ─── Statistics parsing ───────────────────────────────────────────────────────

function parseStat(teamStats: any[], type: string): number {
  const entry = teamStats.find((s: any) => s.type === type);
  if (!entry || entry.value == null) return 0;
  if (typeof entry.value === 'string') return parseInt(entry.value.replace('%', ''), 10) || 0;
  return typeof entry.value === 'number' ? entry.value : 0;
}

function parseFixtureStats(fixture: any): FixtureStats | null {
  const statsArr = fixture.statistics;
  if (!Array.isArray(statsArr) || statsArr.length < 2) return null;

  const homeId = fixture.teams?.home?.id;
  const homeBlock = statsArr.find((s: any) => s.team?.id === homeId);
  const awayBlock = statsArr.find((s: any) => s.team?.id !== homeId);
  if (!homeBlock?.statistics || !awayBlock?.statistics) return null;

  const h = homeBlock.statistics as any[];
  const a = awayBlock.statistics as any[];

  return {
    possession:    { home: parseStat(h, 'Ball Possession'),  away: parseStat(a, 'Ball Possession')  },
    shots:         { home: parseStat(h, 'Total Shots'),       away: parseStat(a, 'Total Shots')       },
    shotsOnTarget: { home: parseStat(h, 'Shots on Goal'),     away: parseStat(a, 'Shots on Goal')     },
    corners:       { home: parseStat(h, 'Corner Kicks'),      away: parseStat(a, 'Corner Kicks')      },
    fouls:         { home: parseStat(h, 'Fouls'),             away: parseStat(a, 'Fouls')             },
    yellowCards:   { home: parseStat(h, 'Yellow Cards'),      away: parseStat(a, 'Yellow Cards')      },
    redCards:      { home: parseStat(h, 'Red Cards'),         away: parseStat(a, 'Red Cards')         },
    offsides:      { home: parseStat(h, 'Offsides'),          away: parseStat(a, 'Offsides')          },
    passAccuracy:  { home: parseStat(h, 'Passes %'),          away: parseStat(a, 'Passes %')          },
  };
}

// ─── Events parsing ───────────────────────────────────────────────────────────

function eventSignature(e: any): string {
  return `${e.time?.elapsed}:${e.type}:${e.detail}:${e.player?.id ?? 'x'}`;
}

function mapEventType(type: string, detail: string): string {
  if (type === 'Goal') {
    if (detail === 'Own Goal') return 'goal';
    if (detail === 'Penalty') return 'penalty';
    return 'goal';
  }
  if (type === 'Card') {
    if (detail === 'Yellow Card') return 'yellow_card';
    if (detail === 'Red Card') return 'red_card';
    if (detail === 'Yellow-Red Card') return 'red_card';
    return 'yellow_card';
  }
  if (type === 'subst') return 'substitution';
  if (type === 'VAR') return 'var';
  if (type === 'Miss Penalty') return 'shot_off_target';
  return 'default';
}

function buildDescription(type: string, detail: string, playerName: string | null, assist: string | null): string {
  if (type === 'Goal') {
    if (detail === 'Own Goal') return playerName ? `Own goal by ${playerName}` : 'Own goal';
    if (detail === 'Penalty') return playerName ? `Penalty scored by ${playerName}` : 'Penalty goal';
    return playerName ? `Goal by ${playerName}${assist ? ` (assist: ${assist})` : ''}` : 'Goal scored';
  }
  if (type === 'Card') return playerName ? `${detail} — ${playerName}` : detail;
  if (type === 'subst') return `Substitution: ${playerName ?? '?'} replaced by ${assist ?? '?'}`;
  if (type === 'VAR') return `VAR Review: ${detail}`;
  if (type === 'Miss Penalty') return playerName ? `${playerName} misses the penalty!` : 'Penalty missed';
  return detail || type;
}

function parseFixtureEvents(fixture: any): any[] {
  const evts = fixture.events;
  if (!Array.isArray(evts)) return [];
  return evts;
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

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

      // Bust live-feed variant caches so next request rebuilds with fresh scores
      const feedKeys = await redis.keys('live_feed:*');
      if (feedKeys.length > 0) await redis.del(...feedKeys);

      // Notify all connected clients so they refetch the live feed immediately
      broadcastLiveScoresUpdate(scores.length);

      // Persist team logos to Supabase as background side-effect (no await)
      persistFixtureLogos(
        scores.flatMap(s => [
          { teamName: s.home_team, logoUrl: s.home_logo },
          { teamName: s.away_team, logoUrl: s.away_logo },
        ]),
      );

      // Per-fixture broadcasts: statistics + new events → socket rooms
      await broadcastFixtureDetails(fixtures);
    }

    return scores;
  } catch (err: any) {
    logger.error('[LiveScores] Fetch error', { message: err.message });
    return [];
  }
}

// ─── Per-fixture socket broadcasting ─────────────────────────────────────────

async function broadcastFixtureDetails(fixtures: any[]): Promise<void> {
  // Load all seen-event sets in one pipeline to avoid N round-trips
  const seenKeys = fixtures.map(f => `apifb:events:${f.fixture.id}`);
  const seenRaw = seenKeys.length > 0
    ? await redis.mget(...seenKeys)
    : [];

  const pipeline = redis.pipeline();

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const fixtureId: number = f.fixture.id;
    const homeScore: number = f.goals.home ?? 0;
    const awayScore: number = f.goals.away ?? 0;
    const minute: number = f.fixture.status.elapsed ?? 0;
    const statusShort: string = f.fixture.status.short ?? '';

    const stats = parseFixtureStats(f);
    const rawEvents = parseFixtureEvents(f);

    // Determine which events are new
    const seenSet = new Set<string>(seenRaw[i] ? JSON.parse(seenRaw[i]!) : []);
    const allSigs: string[] = [];
    const newCommentary: FixtureCommentaryEvent[] = [];

    for (const e of rawEvents) {
      const sig = eventSignature(e);
      allSigs.push(sig);
      if (seenSet.has(sig)) continue;

      const elapsed: number = e.time?.elapsed ?? 0;
      const extra: number | null = e.time?.extra ?? null;
      const minuteLabel = extra ? `${elapsed}+${extra}` : `${elapsed}`;
      const isHome = e.team?.id === f.teams?.home?.id;
      const playerName: string | null = e.player?.name ?? null;
      const assistName: string | null = e.assist?.name ?? null;
      const evtType = mapEventType(e.type ?? '', e.detail ?? '');
      const description = buildDescription(e.type ?? '', e.detail ?? '', playerName, assistName);

      const commentary: FixtureCommentaryEvent = {
        id: `${fixtureId}:${sig}`,
        minute: elapsed,
        type: evtType,
        team: isHome ? 'home' : 'away',
        player: playerName,
        description,
      };

      // Attach updated score for goals
      if (evtType === 'goal' || evtType === 'penalty') {
        commentary.newScore = `${homeScore} - ${awayScore}`;
        commentary.description = `${description} — ${minuteLabel}'`;
      }

      newCommentary.push(commentary);
    }

    // Broadcast to room if anyone is subscribed
    broadcastFixtureUpdate(fixtureId, { home: homeScore, away: awayScore }, minute, statusShort, stats, newCommentary);

    // Cache latest stats for REST endpoint access (same TTL as live scores)
    if (stats) {
      pipeline.setex(`stats:af:${fixtureId}`, TTL, JSON.stringify(stats));
    }

    // Persist updated seen-events set (4h TTL covers any match duration)
    if (allSigs.length > 0) {
      pipeline.setex(`apifb:events:${fixtureId}`, 4 * 3600, JSON.stringify(allSigs));
    }
  }

  await pipeline.exec();
}

// ─── Public helpers ───────────────────────────────────────────────────────────

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
