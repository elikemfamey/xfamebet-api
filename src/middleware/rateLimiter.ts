import rateLimit, { MemoryStore, type Options, type Store } from 'express-rate-limit';
import { Request, Response } from 'express';
import { env } from '../config/env';
import { redis } from '../config/redis';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';

const handler = (_req: Request, res: Response) => {
  sendError(res, 'Too many requests, please try again later.', 429);
};

/**
 * A shared Redis counter keeps limits correct across API instances.  The
 * default in-memory store is per-process, which is unsuitable once the API is
 * horizontally scaled.
 */
class RedisRateLimitStore implements Store {
  readonly prefix: string;
  private usingFallback = false;

  constructor(namespace: string, private readonly windowMs: number, private readonly fallback?: MemoryStore) {
    this.prefix = `rate-limit:${namespace}:`;
  }

  init(options: Options) {
    this.fallback?.init(options);
  }

  async increment(key: string) {
    if (this.fallback && redis.status !== 'ready') return this.incrementFallback(key, this.fallback);

    const redisKey = `${this.prefix}${key}`;
    try {
      const result = await redis.eval(
        "local hits = redis.call('INCR', KEYS[1]); if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return { hits, redis.call('PTTL', KEYS[1]) };",
        1,
        redisKey,
        this.windowMs,
      ) as [number, number];
      if (this.usingFallback) {
        this.usingFallback = false;
        logger.info('General rate limiter restored its shared Redis store');
      }
      return { totalHits: Number(result[0]), resetTime: new Date(Date.now() + Number(result[1])) };
    } catch (error) {
      if (!this.fallback) throw error;
      return this.incrementFallback(key, this.fallback);
    }
  }

  private incrementFallback(key: string, fallback: MemoryStore) {
    if (!this.usingFallback) {
      this.usingFallback = true;
      logger.warn('General rate limiter is using per-instance counters because Redis is unavailable');
    }
    return fallback.increment(key);
  }

  async decrement(key: string) {
    const redisKey = `${this.prefix}${key}`;
    await redis.eval(
      "local hits = redis.call('DECR', KEYS[1]); if hits <= 0 then redis.call('DEL', KEYS[1]); end; return hits;",
      1,
      redisKey,
    );
  }

  async resetKey(key: string) {
    await redis.del(`${this.prefix}${key}`);
  }
}

export const generalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  store: new RedisRateLimitStore('general', env.RATE_LIMIT_WINDOW_MS, new MemoryStore()),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

export const authLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
  store: new RedisRateLimitStore('auth', env.AUTH_RATE_LIMIT_WINDOW_MS),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

export const betLimiter = rateLimit({
  windowMs: env.BET_RATE_LIMIT_WINDOW_MS,
  max: env.BET_RATE_LIMIT_MAX_REQUESTS,
  keyGenerator: (req) => req.user ? `user:${req.user.id}` : `ip:${req.ip}`,
  store: new RedisRateLimitStore('bet', env.BET_RATE_LIMIT_WINDOW_MS),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

export const paymentLimiter = rateLimit({
  // Authenticate runs before this middleware on every payment route. Scope to
  // the account, not the IP: mobile networks and offices commonly share one IP.
  windowMs: env.PAYMENT_RATE_LIMIT_WINDOW_MS,
  max: env.PAYMENT_RATE_LIMIT_MAX_REQUESTS,
  keyGenerator: (req) => req.user ? `user:${req.user.id}` : `ip:${req.ip}`,
  store: new RedisRateLimitStore('payment', env.PAYMENT_RATE_LIMIT_WINDOW_MS),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Team logo lookups are read-only and cached server-side; allow a higher burst
// so page loads showing many teams don't get throttled.
export const teamLogoLimiter = rateLimit({
  windowMs: env.TEAM_LOGO_RATE_LIMIT_WINDOW_MS,
  max: env.TEAM_LOGO_RATE_LIMIT_MAX_REQUESTS,
  store: new RedisRateLimitStore('team-logo', env.TEAM_LOGO_RATE_LIMIT_WINDOW_MS),
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});
