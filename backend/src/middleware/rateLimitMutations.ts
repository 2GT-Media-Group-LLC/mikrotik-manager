import { Request, Response, NextFunction } from 'express';

type Bucket = { resetAt: number; count: number };

const buckets = new Map<string, Bucket>();

/**
 * Simple in-memory sliding-window limiter for mutating HTTP methods.
 * Keyed by authenticated user id (fallback: IP). Not suitable for multi-instance
 * without Redis; good enough for small deployments and complements future Redis limits.
 */
export function rateLimitMutations(options: {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const { windowMs, max, keyPrefix = 'rl' } = options;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }
    const uid = req.user?.userId;
    const key = `${keyPrefix}:${uid != null ? `u${uid}` : `ip:${req.ip || 'unknown'}`}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { resetAt: now + windowMs, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }
    next();
  };
}
