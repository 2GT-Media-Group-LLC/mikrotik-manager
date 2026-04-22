import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { query } from '../config/database';

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

let _loginLimitCache: { windowSec: number; max: number; cachedAt: number } | null = null;

async function getLoginLimits(): Promise<{ windowSec: number; max: number }> {
  const now = Date.now();
  if (_loginLimitCache && now - _loginLimitCache.cachedAt < 60_000) {
    return _loginLimitCache;
  }
  try {
    const rows = await query<{ key: string; value: unknown }>(
      `SELECT key, value FROM app_settings WHERE key IN ('login_rate_limit_window_sec', 'login_rate_limit_max')`
    );
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const windowSec = Number(map['login_rate_limit_window_sec']) || 60;
    const max = Number(map['login_rate_limit_max']) || 10;
    _loginLimitCache = { windowSec, max, cachedAt: now };
    return { windowSec, max };
  } catch {
    return { windowSec: 60, max: 10 };
  }
}

/**
 * Per-IP rate limiter for the login endpoint. Limits are read from app_settings
 * (login_rate_limit_window_sec / login_rate_limit_max) with a 60-second cache.
 */
export function loginRateLimit(): (req: Request, res: Response, next: NextFunction) => void {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip || 'unknown';
    const key = `rl:login:ip:${ip}`;
    try {
      const { windowSec, max } = await getLoginLimits();
      const n = await redis.incr(key);
      if (n === 1) {
        await redis.expire(key, windowSec);
      }
      if (n > max) {
        const ttl = await redis.ttl(key);
        const retryAfterSec = Math.max(1, ttl > 0 ? ttl : windowSec);
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
        return;
      }
    } catch (e) {
      console.warn('[loginRateLimit] Redis error, allowing request:', (e as Error).message);
    }
    next();
  };
}
