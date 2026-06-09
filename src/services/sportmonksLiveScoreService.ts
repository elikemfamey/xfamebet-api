import axios from 'axios';
import { redis } from '../config/redis';
import { broadcastLiveScoresUpdate, broadcastFixtureUpdate, FixtureStats, FixtureCommentaryEvent } from '../socket';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { persistFixtureLogos } from './teamLogoService';
import { LiveScore } from './liveScoreService';

const REDIS_KEY = 'scores:live:all';
const TTL = 90;
const BASE_URL = 'https://api.sportmonks.com/v3/football';

// SportMonks state developer_name → API-Football-compatible status_short
const STATE_TO_STATUS: Record<string, string> = {
  INPLAY_1ST_HALF:       '1H',
  HT:                    'HT',
  INPLAY_2ND_HALF:       '2H',
  BREAK:                 'BT',
  INPLAY_ET:             'ET',
  INPLAY_ET_2ND_HALF:    'ET',
  EXTRA_TIME_BREAK:      'BT',
  INPLAY_PENALTIES:      'P',
  PEN_BREAK:             'P',
  FT:                    'FT',
  AET:                   'AET',
  FT_PEN:                'PEN',
  INTERRUPTED:           'INT',
  SUSPENDED:             'INT',
};

const IN_PLAY_STATES = new Set([
  'INPLAY_1ST_HALF', 'HT', 'BREAK',
  'INPLAY_2ND_HALF', 'INPLAY_ET', 'EXTRA_TIME_BREAK',
  'INPLAY_ET_2ND_HALF', 'INPLAY_PENALTIES', 'PEN_BREAK', 'INTERRUPTED',
]);

// ─── Minute estimation ────────────────────────────────────────────────────────

function computeMinute(startingAt: string | null, developerName: string): number {
  if (!startingAt) return 0;
  const elapsed = Math.floor((Date.now() - new Date(startingAt).getTime()) / 60000);
  switch (developerName) {
    case 'INPLAY_1ST_HALF':    return Math.min(45,  Math.max(0,  elapsed));
    case 'HT':                 return 45;
    case 'INPLAY_2ND_HALF':    return Math.min(90,  Math.max(45, elapsed));
    case 'INPLAY_ET':          return Math.min(105, Math.max(90, elapsed));
    case 'INPLAY_ET_2ND_HALF': return Math.min(120, Math.max(105, elapsed));
    case 'INPLAY_PENALTIES':
    case 'PEN_BREAK':          return 120;
    default:                   return Math.max(0, elapsed);
  }
}

// ─── Statistics parsing ───────────────────────────────────────────────────────

function statKeyFromName(name: string): keyof FixtureStats | null {
  const lower = name.toLowerCase();
  if (lower.includes('possession'))                        return 'possession';
  if (lower === 'shots total' || lower === 'total shots')  return 'shots';
  if (lower.includes('shots on') || lower.includes('on target')) return 'shotsOnTarget';
  if (lower.includes('corner'))                            return 'corners';
  if (lower.includes('foul'))                              return 'fouls';
  if (lower.includes('yellow card'))                       return 'yellowCards';
  if (lower.includes('red card'))                          return 'redCards';
  if (lower.includes('offside'))                           return 'offsides';
  if (lower.includes('pass') && lower.includes('%'))       return 'passAccuracy';
  return null;
}

function parseStats(statistics: any[], homeParticipantId: number): FixtureStats | null {
  if (!Array.isArray(statistics) || statistics.length === 0) return null;

  const stats: FixtureStats = {
    possession:    { home: 0, away: 0 },
    shots:         { home: 0, away: 0 },
    shotsOnTarget: { home: 0, away: 0 },
    corners:       { home: 0, away: 0 },
    fouls:         { home: 0, away: 0 },
    yellowCards:   { home: 0, away: 0 },
    redCards:      { home: 0, away: 0 },
    offsides:      { home: 0, away: 0 },
    passAccuracy:  { home: 0, away: 0 },
  };

  for (const stat of statistics) {
    const typeName: string = stat.type?.name ?? '';
    if (!typeName) continue;

    const key = statKeyFromName(typeName);
    if (!key) continue;

    const raw = stat.data?.value ?? stat.value ?? 0;
    const value = typeof raw === 'string'
      ? parseInt(raw.replace('%', ''), 10) || 0
      : Number(raw) || 0;

    const side: 'home' | 'away' = stat.participant_id === homeParticipantId ? 'home' : 'away';
    (stats[key] as { home: number; away: number })[side] = value;
  }

  return stats;
}

// ─── Events parsing ───────────────────────────────────────────────────────────

function eventSignature(e: any): string {
  return `${e.minute ?? 0}:${e.type?.name ?? e.type_id ?? 'x'}:${e.player_id ?? 'x'}`;
}

function mapEventType(typeName: string): string {
  const lower = typeName.toLowerCase();
  if (lower.includes('own goal'))                      return 'goal';
  if (lower.includes('penalty') && lower.includes('score')) return 'penalty';
  if (lower.includes('goal'))                          return 'goal';
  if (lower.includes('yellow card'))                   return 'yellow_card';
  if (lower.includes('red card'))                      return 'red_card';
  if (lower.includes('yellow/red') || lower.includes('second yellow')) return 'red_card';
  if (lower.includes('substitut'))                     return 'substitution';
  if (lower.includes('var'))                           return 'var';
  if (lower.includes('penalty') && lower.includes('miss')) return 'shot_off_target';
  return 'default';
}

function buildDescription(typeName: string, playerName: string | null, relatedName: string | null): string {
  const lower = typeName.toLowerCase();
  if (lower.includes('own goal'))
    return playerName ? `Own goal by ${playerName}` : 'Own goal';
  if (lower.includes('penalty') && lower.includes('score'))
    return playerName ? `Penalty scored by ${playerName}` : 'Penalty goal';
  if (lower.includes('goal'))
    return playerName ? `Goal by ${playerName}${relatedName ? ` (assist: ${relatedName})` : ''}` : 'Goal scored';
  if (lower.includes('yellow card'))
    return playerName ? `Yellow Card — ${playerName}` : 'Yellow Card';
  if (lower.includes('red card'))
    return playerName ? `Red Card — ${playerName}` : 'Red Card';
  if (lower.includes('substitut'))
    return `Substitution: ${playerName ?? '?'} replaced by ${relatedName ?? '?'}`;
  if (lower.includes('var'))
    return `VAR Review`;
  if (lower.includes('penalty') && lower.includes('miss'))
    return playerName ? `${playerName} misses the penalty!` : 'Penalty missed';
  return typeName || 'Event';
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

export async function fetchAndCacheLiveScores(): Promise<LiveScore[]> {
  if (!env.SPORTMONKS_API_TOKEN) {
    logger.debug('[SportMonks] SPORTMONKS_API_TOKEN not configured, skipping');
    return [];
  }

  const resp = await axios.get(`${BASE_URL}/livescores/inplay`, {
    params: {
      api_token: env.SPORTMONKS_API_TOKEN,
      include: 'participants;scores;state;league;statistics.type;events.type',
    },
    timeout: 12000,
  });

  const fixtures: any[] = resp.data?.data ?? [];
  const scores: LiveScore[] = [];
  const enriched: any[] = [];

  for (const f of fixtures) {
    const participants: any[] = f.participants ?? [];
    const home = participants.find((p: any) => p.meta?.location === 'home');
    const away = participants.find((p: any) => p.meta?.location === 'away');
    if (!home || !away) continue;

    const developerName: string = f.state?.developer_name ?? '';
    const statusShort = STATE_TO_STATUS[developerName] ?? '';
    if (!IN_PLAY_STATES.has(developerName)) continue;

    const minute = computeMinute(f.starting_at ?? null, developerName);

    const scoreObjs: any[] = f.scores ?? [];
    const homeGoals = scoreObjs.find((s: any) => s.participant_id === home.id && s.description === 'CURRENT')?.score?.goals ?? 0;
    const awayGoals = scoreObjs.find((s: any) => s.participant_id === away.id && s.description === 'CURRENT')?.score?.goals ?? 0;

    const ls: LiveScore = {
      fixture_id: f.id,
      home_team: home.name,
      away_team: away.name,
      home_logo: home.image_path ?? null,
      away_logo: away.image_path ?? null,
      home_score: homeGoals,
      away_score: awayGoals,
      minute,
      status_short: statusShort,
      league: f.league?.name ?? '',
      country: f.league?.country?.name ?? '',
    };

    scores.push(ls);
    enriched.push({ fixture: f, homeId: home.id, ls });
  }

  if (scores.length > 0) {
    await redis.setex(REDIS_KEY, TTL, JSON.stringify(scores));
    logger.info(`[SportMonks] Cached ${scores.length} live matches`);

    const feedKeys = await redis.keys('live_feed:*');
    if (feedKeys.length > 0) await redis.del(...feedKeys);

    broadcastLiveScoresUpdate(scores.length);

    persistFixtureLogos(
      scores.flatMap(s => [
        { teamName: s.home_team, logoUrl: s.home_logo, source: 'sportmonks' as const },
        { teamName: s.away_team, logoUrl: s.away_logo, source: 'sportmonks' as const },
      ]),
    );

    await broadcastFixtureDetails(enriched);
  }

  return scores;
}

// ─── Per-fixture socket broadcasting ─────────────────────────────────────────

async function broadcastFixtureDetails(
  enriched: Array<{ fixture: any; homeId: number; ls: LiveScore }>,
): Promise<void> {
  const seenKeys = enriched.map(e => `sm:events:${e.fixture.id}`);
  const seenRaw = seenKeys.length > 0 ? await redis.mget(...seenKeys) : [];
  const pipeline = redis.pipeline();

  for (let i = 0; i < enriched.length; i++) {
    const { fixture: f, homeId, ls } = enriched[i];
    const stats = parseStats(f.statistics ?? [], homeId);
    const rawEvents: any[] = f.events ?? [];

    const seenSet = new Set<string>(seenRaw[i] ? JSON.parse(seenRaw[i]!) : []);
    const allSigs: string[] = [];
    const newCommentary: FixtureCommentaryEvent[] = [];

    for (const e of rawEvents) {
      const sig = eventSignature(e);
      allSigs.push(sig);
      if (seenSet.has(sig)) continue;

      const elapsed: number = e.minute ?? 0;
      const extra: number | null = e.extra_minute ?? null;
      const minuteLabel = extra ? `${elapsed}+${extra}` : `${elapsed}`;
      const isHome = e.participant_id === homeId;
      const playerName: string | null = e.player?.name ?? e.player_name ?? null;
      const relatedName: string | null = e.related?.name ?? e.related_player_name ?? null;
      const typeName: string = e.type?.name ?? '';
      const evtType = mapEventType(typeName);
      const description = buildDescription(typeName, playerName, relatedName);

      const commentary: FixtureCommentaryEvent = {
        id: `${f.id}:${sig}`,
        minute: elapsed,
        type: evtType,
        team: isHome ? 'home' : 'away',
        player: playerName,
        description,
      };

      if (evtType === 'goal' || evtType === 'penalty') {
        commentary.newScore = `${ls.home_score} - ${ls.away_score}`;
        commentary.description = `${description} — ${minuteLabel}'`;
      }

      newCommentary.push(commentary);
    }

    broadcastFixtureUpdate(f.id, { home: ls.home_score, away: ls.away_score }, ls.minute, ls.status_short, stats, newCommentary);

    if (allSigs.length > 0) {
      pipeline.setex(`sm:events:${f.id}`, 4 * 3600, JSON.stringify(allSigs));
    }
  }

  await pipeline.exec();
}
