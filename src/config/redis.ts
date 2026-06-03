import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error', { err }));
redis.on('close', () => logger.warn('Redis connection closed'));

export const REDIS_KEYS = {
  SESSION: (id: string) => `session:${id}`,
  USER_SESSIONS: (userId: string) => `user:${userId}:sessions`,
  LIVE_ODDS: (eventId: string) => `odds:live:${eventId}`,
  ALL_ODDS: 'odds:all',
  RATE_LIMIT: (ip: string, route: string) => `ratelimit:${ip}:${route}`,
  FRAUD_EVENTS: (userId: string) => `fraud:${userId}:events`,
  LIVE_MATCH: (matchId: string) => `live:match:${matchId}`,
  SIMULATION: (matchId: string) => `sim:${matchId}`,
  WALLET_LOCK: (userId: string) => `wallet:lock:${userId}`,
  OTP: (userId: string) => `otp:${userId}`,
  OTP_COOLDOWN: (phone: string) => `otp_cooldown:${phone}`,
  AFFILIATE_CLICKS: (affiliateId: string) => `affiliate:${affiliateId}:clicks`,
};

export const REDIS_STREAMS = {
  ODDS_UPDATES: 'stream:odds:updates',
  BET_EVENTS: 'stream:bet:events',
  FRAUD_EVENTS: 'stream:fraud:events',
  PAYMENT_EVENTS: 'stream:payment:events',
  SIMULATION_EVENTS: 'stream:simulation:events',
  NOTIFICATION_EVENTS: 'stream:notification:events',
};
