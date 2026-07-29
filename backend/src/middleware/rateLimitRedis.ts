import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { query } from '../config/database';

// Per-process sliding-window fallback used ONLY when Redis is unavailable, so
// throttling degrades gracefully (esp. for /login) instead of failing fully
// open exactly when infrastructure is under stress. It's best-effort and not
// shared across replicas, but far better than no limit during a Redis outage.
const memBuckets = new Map<string, number[]>();
let lastSweep = Date.now();

// The Redis client uses maxRetriesPerRequest:null, so commands QUEUE (hang)
// rather than throw when Redis is down. Bound each call so an outage fails fast
// into the in-memory fallback instead of stalling the request.
const REDIS_OP_TIMEOUT_MS = 800;
function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('redis timeout')), REDIS_OP_TIMEOUT_MS)),
  ]);
}

function memoryLimitExceeded(key: string, windowSec: number, max: number): boolean {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  if (now - lastSweep > 60_000) {
    for (const [k, ts] of memBuckets) {
      const kept = ts.filter((t) => now - t < windowMs);
      if (kept.length) memBuckets.set(k, kept); else memBuckets.delete(k);
    }
    lastSweep = now;
  }
  const recent = (memBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  memBuckets.set(key, recent);
  return recent.length > max;
}

/**
 * Fixed-window rate limit using Redis INCR (shared across API replicas).
 */
export function rateLimitRedis(options: {
  windowSec: number;
  max: number;
  keyPrefix: string;
  /** When true, applies to all HTTP methods instead of only mutating ones. */
  allMethods?: boolean;
}): (req: Request, res: Response, next: NextFunction) => void {
  const { windowSec, max, keyPrefix, allMethods = false } = options;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!allMethods && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }
    const uid = req.user?.userId;
    const key = `rl:${keyPrefix}:${uid != null ? `u:${uid}` : `ip:${req.ip || 'unknown'}`}`;
    try {
      const n = await withTimeout(redis.incr(key));
      if (n === 1) {
        await withTimeout(redis.expire(key, windowSec));
      }
      if (n > max) {
        const ttl = await withTimeout(redis.ttl(key));
        const retryAfterSec = Math.max(1, ttl > 0 ? ttl : windowSec);
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }
    } catch (e) {
      console.warn('[rateLimitRedis] Redis error, using in-memory fallback:', (e as Error).message);
      if (memoryLimitExceeded(key, windowSec, max)) {
        res.setHeader('Retry-After', String(windowSec));
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }
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
    // Resolved outside the try so the fallback can reuse the limits on Redis failure
    // (getLoginLimits has its own catch and never throws).
    const { windowSec, max } = await getLoginLimits();
    try {
      const n = await withTimeout(redis.incr(key));
      if (n === 1) {
        await withTimeout(redis.expire(key, windowSec));
      }
      if (n > max) {
        const ttl = await withTimeout(redis.ttl(key));
        const retryAfterSec = Math.max(1, ttl > 0 ? ttl : windowSec);
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
        return;
      }
    } catch (e) {
      console.warn('[loginRateLimit] Redis error, using in-memory fallback:', (e as Error).message);
      if (memoryLimitExceeded(key, windowSec, max)) {
        res.setHeader('Retry-After', String(windowSec));
        res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
        return;
      }
    }
    next();
  };
}
