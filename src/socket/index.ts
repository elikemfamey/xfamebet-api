import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyAccessToken } from '../utils/crypto';
import { redis, REDIS_KEYS } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';

let io: Server;

export function initSocketIO(server: HttpServer) {
  io = new Server(server, {
    cors: {
      origin: [...env.FRONTEND_URL.split(',').map(u => u.trim()), 'http://localhost:3000'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth.token ?? socket.handshake.headers.authorization?.split(' ')[1];
    if (!token) {
      // Allow unauthenticated connections for public rooms (live odds, simulations)
      socket.data.userId = null;
      return next();
    }
    try {
      const payload = verifyAccessToken(token);
      const session = await redis.get(REDIS_KEYS.SESSION(payload.sessionId));
      if (!session) return next(new Error('Session expired'));
      socket.data.userId = payload.userId;
      socket.data.role = payload.role;
      socket.data.sessionId = payload.sessionId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId;

    if (userId) {
      socket.join(`user:${userId}`);
      logger.debug(`User ${userId} connected via Socket.IO`);
    }

    // Subscribe to live match (MatchCard path — raw id, no prefix)
    socket.on('match:join', (matchId: string) => {
      socket.join(`match:${matchId}`);
      socket.emit('match:joined', { matchId });
    });

    socket.on('match:leave', (matchId: string) => {
      socket.leave(`match:${matchId}`);
    });

    // Subscribe to live match (MatchDetailsModal path — full prefixed id, e.g. 'af:12345')
    socket.on('subscribe_match', ({ matchId }: { matchId: string }) => {
      const cleanId = matchId.startsWith('af:') ? matchId.slice(3)
        : matchId.startsWith('sim:') ? matchId.slice(4)
        : matchId;
      socket.join(`match:${cleanId}`);
      socket.emit('match:joined', { matchId: cleanId });
    });

    socket.on('unsubscribe_match', ({ matchId }: { matchId: string }) => {
      const cleanId = matchId.startsWith('af:') ? matchId.slice(3)
        : matchId.startsWith('sim:') ? matchId.slice(4)
        : matchId;
      socket.leave(`match:${cleanId}`);
    });

    // Subscribe to odds updates for an event
    socket.on('odds:subscribe', (eventId: string) => {
      socket.join(`odds:${eventId}`);
    });

    socket.on('odds:unsubscribe', (eventId: string) => {
      socket.leave(`odds:${eventId}`);
    });

    // Admin room
    if (socket.data.role === 'admin' || socket.data.role === 'super_admin') {
      socket.join('admin');
    }

    socket.on('disconnect', () => {
      if (userId) logger.debug(`User ${userId} disconnected`);
    });

    socket.on('error', (err) => logger.error('Socket error', { err }));
  });

  logger.info('Socket.IO server initialized');
  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export function broadcastOddsUpdate(eventId: string, updates: unknown[]) {
  if (!io) return;
  io.to(`odds:${eventId}`).emit('odds:update', { eventId, updates });
  io.emit('odds:update:global', { eventId, updates });
}

export function broadcastWalletUpdate(userId: string, balance: number) {
  if (!io) return;
  io.to(`user:${userId}`).emit('wallet:update', { balance });
}

export function broadcastAdminAlert(message: string, data?: unknown) {
  if (!io) return;
  io.to('admin').emit('admin:alert', { message, data, timestamp: new Date().toISOString() });
}

export function broadcastBetWon(userId: string, payload: {
  betId: string;
  amount: number;
  currency: string;
  shareCode?: string;
}) {
  if (!io) return;
  io.to(`user:${userId}`).emit('bet:won', payload);
}

export function broadcastLiveScoresUpdate(count: number) {
  if (!io) return;
  io.emit('scores:update', { count, timestamp: new Date().toISOString() });
}

// ─── API-Football fixture broadcast ───────────────────────────────────────────

export interface FixtureStats {
  possession: { home: number; away: number };
  shots: { home: number; away: number };
  shotsOnTarget: { home: number; away: number };
  corners: { home: number; away: number };
  fouls: { home: number; away: number };
  yellowCards: { home: number; away: number };
  redCards: { home: number; away: number };
  offsides: { home: number; away: number };
  passAccuracy: { home: number; away: number };
}

export interface FixtureCommentaryEvent {
  id: string;
  minute: number;
  type: string;
  team: 'home' | 'away';
  player: string | null;
  description: string;
  newScore?: string;
}

function toMatchStatus(statusShort: string): string {
  switch (statusShort) {
    case 'HT': case 'BT': return 'halftime';
    case 'FT': case 'AET': case 'PEN': return 'fulltime';
    case 'ET': case 'P': return 'injury_time';
    case '2H': return 'second_half';
    default: return 'live';
  }
}

export function broadcastFixtureUpdate(
  fixtureId: number,
  score: { home: number; away: number },
  minute: number,
  statusShort: string,
  stats: FixtureStats | null,
  newEvents: FixtureCommentaryEvent[],
) {
  if (!io) return;

  const room = `match:${fixtureId}`;
  const fullId = `af:${fixtureId}`;
  const status = toMatchStatus(statusShort);

  // MatchCard: match:state (room-based, uses numeric id as matchId)
  io.to(room).emit('match:state', {
    matchId: String(fixtureId),
    scoreA: score.home,
    scoreB: score.away,
    minute,
    possession: stats ? { a: stats.possession.home, b: stats.possession.away } : undefined,
  });

  // MatchDetailsModal: namespaced events (uses full prefixed id)
  io.to(room).emit(`match:${fullId}:score`, { home: score.home, away: score.away });
  io.to(room).emit(`match:${fullId}:timer`, { timer: `${minute}` });
  io.to(room).emit(`match:${fullId}:status`, { status });

  if (stats) {
    io.to(room).emit(`match:${fullId}:possession`, { home: stats.possession.home, away: stats.possession.away });
    io.to(room).emit(`match:${fullId}:stats`, {
      possession: { h: stats.possession.home, a: stats.possession.away },
      shots: { h: stats.shots.home, a: stats.shots.away },
      shotsOnTarget: { h: stats.shotsOnTarget.home, a: stats.shotsOnTarget.away },
      passAccuracy: { h: stats.passAccuracy.home, a: stats.passAccuracy.away },
      corners: { h: stats.corners.home, a: stats.corners.away },
      fouls: { h: stats.fouls.home, a: stats.fouls.away },
      yellowCards: { h: stats.yellowCards.home, a: stats.yellowCards.away },
      redCards: { h: stats.redCards.home, a: stats.redCards.away },
      offsides: { h: stats.offsides.home, a: stats.offsides.away },
    });
  }

  for (const evt of newEvents) {
    // MatchDetailsModal commentary
    io.to(room).emit(`match:${fullId}:commentary`, evt);
    // MatchDetailsModal recent action
    io.to(room).emit(`match:${fullId}:recent_action`, {
      type: evt.type,
      team: evt.team,
      player: evt.player,
      minute: evt.minute,
    });
    // MatchCard event flash
    io.to(room).emit('match:event', {
      simulation_id: String(fixtureId),
      event_type: evt.type,
      player: evt.player,
      team: evt.team,
      commentary: evt.description,
      score_a: score.home,
      score_b: score.away,
      minute: evt.minute,
    });
  }
}
