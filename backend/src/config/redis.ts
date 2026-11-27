import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
// Optional Redis auth (outside review O3), passed outside the URL so any
// characters work. Set REDIS_PASSWORD in .env; compose gives it to both sides.
const auth = process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {};

export const redis = new Redis(redisUrl, {
  ...auth,
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

/**
 * Wait until Redis answers before anything that uses it starts (D507). After a
 * host reboot Docker restarts the containers in any order (depends_on only
 * orders `docker compose up`), so the backend can come up before Redis. The
 * connections retry on their own, but a BullMQ queue or worker made while
 * Redis is down keeps that first failure: polling, the scheduler and live
 * updates stayed broken until the backend was restarted by hand.
 */
export async function waitForRedis(
  client: Pick<Redis, 'status' | 'connect' | 'ping'> = redis,
  pauseMs = 1000,
  sayEveryMs = 30_000,
): Promise<void> {
  if (client.status === 'wait') await client.connect().catch(() => { /* it keeps retrying */ });
  let saidAt = 0;
  let why = 'not connected yet';
  for (;;) {
    if (client.status === 'ready') {
      let timer: NodeJS.Timeout | undefined;
      const answered = await Promise.race([
        client.ping().then(() => true, (e: Error) => { why = e.message; return false; }),
        new Promise<boolean>((r) => { timer = setTimeout(() => { why = 'no answer'; r(false); }, 5000); }),
      ]);
      clearTimeout(timer);
      if (answered) {
        if (saidAt) console.log('Redis is up; starting');
        return;
      }
    }
    if (Date.now() - saidAt >= sayEveryMs) {
      console.warn(`Waiting for Redis (${why})...`);
      saidAt = Date.now();
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
}

// Separate connection for BullMQ (requires maxRetriesPerRequest: null)
export function createRedisConnection(): Redis {
  return new Redis(redisUrl, {
    ...auth,
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
      ...auth,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
    limiterConnection.on('error', () => { /* reported by the main connection */ });
  }
  return limiterConnection;
}
