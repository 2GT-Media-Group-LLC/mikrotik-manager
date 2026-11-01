import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
// Optional Redis auth (outside review O3), passed outside the URL so any
// characters work. Set REDIS_PASSWORD in .env; compose gives it to both sides.
const auth = process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {};
// ioredis 6 speaks RESP3 by default. Every connection here, BullMQ's included,
// stays on RESP2, the protocol BullMQ's scripts and our pub/sub ran on under
// ioredis 5: RESP3 changes some reply shapes and gains us nothing.
const base = { ...auth, protocol: 2 as const };

export const redis = new Redis(redisUrl, {
  ...base,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redis.on('connect', () => {
  console.log('Redis connected');
});

// Separate connection for BullMQ (requires maxRetriesPerRequest: null)
export function createRedisConnection(): Redis {
  return new Redis(redisUrl, {
    ...base,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
}

/**
 * Connection for the rate limiters (outside review S5). It never queues: while
 * Redis is unreachable a command fails at once and the limiter uses its
 * in-memory fallback. On the shared connection a command that had timed out
 * stayed queued and ran when Redis came back, long after the request.
 */
let limiterConnection: Redis | null = null;
export function limiterRedis(): Redis {
  if (!limiterConnection) {
    limiterConnection = new Redis(redisUrl, {
      ...base,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
    limiterConnection.on('error', () => { /* reported by the main connection */ });
  }
  return limiterConnection;
}
