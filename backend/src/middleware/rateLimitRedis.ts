import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';

/**
 * Fixed-window rate limit using Redis INCR (shared across API replicas).
 */
export function rateLimitRedis(options: {
  windowSec: number;
  max: number;
  keyPrefix: string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const { windowSec, max, keyPrefix } = options;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }
    const uid = req.user?.userId;
    const key = `rl:${keyPrefix}:${uid != null ? `u:${uid}` : `ip:${req.ip || 'unknown'}`}`;
    try {
      const n = await redis.incr(key);
      if (n === 1) {
        await redis.expire(key, windowSec);
      }
      if (n > max) {
        const ttl = await redis.ttl(key);
        const retryAfterSec = Math.max(1, ttl > 0 ? ttl : windowSec);
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }
    } catch (e) {
      console.warn('[rateLimitRedis] Redis error, allowing request:', (e as Error).message);
    }
    next();
  };
}
