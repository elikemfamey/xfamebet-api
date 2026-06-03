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
      origin: [env.FRONTEND_URL, 'http://localhost:3000'],
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

    // Subscribe to live match
    socket.on('match:join', (matchId: string) => {
      socket.join(`match:${matchId}`);
      socket.emit('match:joined', { matchId });
    });

    socket.on('match:leave', (matchId: string) => {
      socket.leave(`match:${matchId}`);
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
