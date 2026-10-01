import { Request, Response, NextFunction } from 'express';
import { limiterRedis } from '../config/redis';
import { query } from '../config/database';

// Per-process fallback used ONLY when Redis is unavailable, so throttling
// degrades gracefully (esp. for /login) instead of failing fully open exactly
// when infrastructure is under stress. Best-effort and not shared across
// replicas, but far better than no limit during a Redis outage. Each bucket
// keeps its own window: pruning every bucket with the caller's window let a
// 60-second limit cut short the 15-minute login one (outside review S5).
const memBuckets = new Map<string, { windowMs: number; hits: number[] }>();
let lastSweep = Date.now();

// Even with no offline queue, a stalled connection shouldn't hold a request.
const REDIS_OP_TIMEOUT_MS = 800;
function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('redis timeout')), REDIS_OP_TIMEOUT_MS)),
  ]);
}

export function memoryLimitExceeded(key: string, windowSec: number, max: number, now = Date.now()): boolean {
  const windowMs = windowSec * 1000;
  if (now - lastSweep > 60_000) {
    for (const [k, b] of memBuckets) {
      b.hits = b.hits.filter((t) => now - t < b.windowMs);
      if (b.hits.length === 0) memBuckets.delete(k);
    }
    lastSweep = now;
  }
  const bucket = memBuckets.get(key) ?? { windowMs, hits: [] };
  bucket.windowMs = windowMs;
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  bucket.hits.push(now);
  memBuckets.set(key, bucket);
  return bucket.hits.length > max;
}

/**
 * Count one hit and return the count and the milliseconds left in the window,
 * in one atomic step (outside review S5). INCR then EXPIRE as two commands
 * could leave a counter with no expiry, and once over the limit that IP or
 * account stayed blocked until someone deleted the key. The script also gives
 * an expiry to any key that is missing one, which repairs keys left that way.
 */
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`;

async function hit(key: string, windowSec: number): Promise<{ count: number; ttlMs: number }> {
  const [count, ttlMs] = await withTimeout(
    limiterRedis().eval(HIT_SCRIPT, 1, key, String(windowSec * 1000)) as Promise<[number, number]>);
  return { count: Number(count), ttlMs: Number(ttlMs) };
}

/** Shared decision for both limiters; true when the request was refused. */
async function limited(res: Response, key: string, windowSec: number, max: number, message: string, tag: string): Promise<boolean> {
  try {
    const { count, ttlMs } = await hit(key, windowSec);
    if (count > max) {
      res.setHeader('Retry-After', String(Math.max(1, ttlMs > 0 ? Math.ceil(ttlMs / 1000) : windowSec)));
      res.status(429).json({ error: message });
      return true;
    }
  } catch (e) {
    console.warn(`[${tag}] Redis unavailable, using in-memory fallback:`, (e as Error).message);
    if (memoryLimitExceeded(key, windowSec, max)) {
      res.setHeader('Retry-After', String(windowSec));
      res.status(429).json({ error: message });
      return true;
    }
  }
  return false;
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
    if (await limited(res, key, windowSec, max, 'Too many requests. Please try again later.', 'rateLimitRedis')) return;
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
    const { windowSec, max } = await getLoginLimits();
    if (await limited(res, key, windowSec, max, 'Too many login attempts. Please try again later.', 'loginRateLimit')) return;
    next();
  };
}
