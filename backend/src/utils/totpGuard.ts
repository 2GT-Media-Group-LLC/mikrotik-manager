/**
 * Second-factor codes, per account (GHSA-63v6-w7qf-349f).
 *
 * The code check was limited per source address only, so guesses spread over
 * many addresses were never slowed, and a code that had worked could be used
 * again within its window. Now each account gets a few wrong codes per quarter
 * hour, and a code that has signed someone in is refused after that.
 *
 * Without Redis both checks step aside; the per-address limit still applies.
 */
import { redis } from '../config/redis';

export const TOTP_MAX_FAILURES = 5;
const FAILURE_WINDOW_S = 15 * 60;
const PERIOD_S = 30;

const failKey = (userId: number) => `totp:fail:${userId}`;
const usedKey = (userId: number, step: number) => `totp:used:${userId}:${step}`;

/** True when the account has had too many wrong codes lately. */
export async function totpLockedOut(userId: number): Promise<boolean> {
  try {
    return Number(await redis.get(failKey(userId))) >= TOTP_MAX_FAILURES;
  } catch {
    return false;
  }
}

/**
 * Count and expiry in one step. As two commands, a restart between them left a
 * counter with no expiry, and an account at the limit locked out for good.
 */
const FAIL_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

export async function recordTotpFailure(userId: number): Promise<void> {
  try {
    await redis.eval(FAIL_SCRIPT, 1, failKey(userId), String(FAILURE_WINDOW_S));
  } catch { /* no Redis: per-address limit only */ }
}

/**
 * Claim the code's time step for this account. False if a code from the same
 * step already signed it in. `delta` is the step offset otpauth matched.
 */
export async function claimTotpStep(userId: number, delta: number, now = Date.now()): Promise<boolean> {
  const step = Math.floor(now / 1000 / PERIOD_S) + delta;
  try {
    const ok = await redis.set(usedKey(userId, step), '1', 'EX', PERIOD_S * 4, 'NX');
    if (ok !== 'OK') return false;
    await redis.del(failKey(userId));
    return true;
  } catch {
    return true;
  }
}
