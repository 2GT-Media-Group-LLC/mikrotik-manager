/**
 * One writer per device at a time.
 *
 * Change Guard arms a revert that restores a backup taken before its change.
 * Any other write to the device while that revert is armed, or while the change
 * is still being proved, would be silently undone if the revert fired, and a
 * binary restore also reboots the device. So every write request to a device
 * takes the same lock Change Guard uses, and a second writer is told the device
 * is busy instead of racing it (outside review P2-8, S10).
 *
 * A guarded change inside a request that already holds the lock runs under it:
 * the lock is recognised through AsyncLocalStorage rather than acquired twice.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { redis } from '../../config/redis';

export const deviceLockKey = (deviceId: number): string => `changeguard:lock:${deviceId}`;

/** Longest a write request can hold a device before the lock lapses by itself. */
const WRITE_LOCK_TTL_SEC = 600;
/** A lock that can't be checked this quickly is skipped rather than waited on. */
const REDIS_TIMEOUT_MS = 2_000;

const held = new AsyncLocalStorage<Map<number, string>>();

/** The token this request holds for `deviceId`, if it holds that device's lock. */
export function heldLockToken(deviceId: number): string | undefined {
  return held.getStore()?.get(deviceId);
}

/** Delete the key only if it still holds `token`, so a later owner's lock survives. */
const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis timeout')), REDIS_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Put the lock back to `token` after a guarded change inside this request released it. */
export async function restoreHeldLock(deviceId: number, token: string): Promise<void> {
  await withTimeout(redis.set(deviceLockKey(deviceId), token, 'EX', WRITE_LOCK_TTL_SEC)).catch(() => {});
}

/**
 * Express middleware: hold the device's lock for the length of a write request.
 * `getDeviceId` returns the target device, or null for requests that don't
 * write to one device (they pass straight through).
 */
export function deviceWriteLock(getDeviceId: (req: Request) => number | null) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return; }
    const deviceId = getDeviceId(req);
    if (!deviceId) { next(); return; }
    if (heldLockToken(deviceId)) { next(); return; }

    const key = deviceLockKey(deviceId);
    const token = randomBytes(8).toString('hex');
    let acquired: boolean;
    try {
      acquired = (await withTimeout(redis.set(key, token, 'EX', WRITE_LOCK_TTL_SEC, 'NX'))) === 'OK';
    } catch {
      // Redis unavailable: don't block writes, as Change Guard itself doesn't.
      next();
      return;
    }
    if (!acquired) {
      // A request's own lock lasts only as long as the request, so its expiry
      // says nothing useful. Change Guard's hold (value '1') is different: it
      // runs until a revert that may still fire has had its chance.
      const holder = await withTimeout(redis.get(key)).catch(() => null);
      const ttl = holder === '1' ? await withTimeout(redis.ttl(key)).catch(() => -1) : -1;
      res.status(409).json({
        code: 'device_busy',
        error: ttl > 0
          ? `A protected change to this device is still in progress or being verified (for up to ${ttl}s). ` +
            'Try again after that.'
          : 'Another change to this device is being applied right now. Try again in a few seconds.',
      });
      return;
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      withTimeout(redis.eval(RELEASE_IF_OWNER, 1, key, token)).catch(() => {});
    };
    res.on('finish', release);
    res.on('close', release);

    const store = new Map(held.getStore() ?? []);
    store.set(deviceId, token);
    held.run(store, () => next());
  };
}

/**
 * Device write routes that don't need the lock: they change only the manager's
 * own records, or only read from the device.
 */
const UNLOCKED_DEVICE_ROUTES: RegExp[] = [
  /^\/\d+\/?$/, // edit or remove the device record in the manager
  /^\/\d+\/(location|monitoring)\/?$/,
  /^\/\d+\/(preflight|sync|test|ap-scan|check-update|check-routerboard)\/?$/,
  /^\/\d+\/(config-health\/scan|change-guard\/(check|probe)|ssh-key\/verify)\/?$/,
  /^\/\d+\/tools\//,
  /^\/\d+\/spectral-scan\//,
  /^\/\d+\/lte\/data-cap\//,
];

/** Device id from `/:id/...` paths on the devices and wireless routers. */
export function deviceIdFromPath(req: Request): number | null {
  const m = /^\/(\d+)(?:\/|$)/.exec(req.path);
  if (!m) return null;
  if (UNLOCKED_DEVICE_ROUTES.some((re) => re.test(req.path))) return null;
  return parseInt(m[1], 10);
}

/** Device id from ?deviceId= or body.deviceId, for the network-services and guest routers. */
export function deviceIdFromQuery(req: Request): number | null {
  const raw = req.query.deviceId ?? (req.body as { deviceId?: unknown } | undefined)?.deviceId;
  const id = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}
