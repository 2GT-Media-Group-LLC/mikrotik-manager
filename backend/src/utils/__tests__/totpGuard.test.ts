const store = new Map<string, string>();
const ttls = new Map<string, number>();
jest.mock('../../config/redis', () => ({
  redis: {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    incr: jest.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    // The failure script, as Redis would run it: count, and give an expiry to a
    // key that has none.
    eval: jest.fn(async (_script: string, _n: number, k: string, ttl: string) => {
      const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n));
      if (!ttls.has(k)) ttls.set(k, Number(ttl));
      return n;
    }),
    del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
    set: jest.fn(async (k: string, v: string, ..._rest: unknown[]) => { if (store.has(k)) return null; store.set(k, v); return 'OK'; }),
  },
}));
import { totpLockedOut, recordTotpFailure, claimTotpStep, TOTP_MAX_FAILURES } from '../totpGuard';

beforeEach(() => store.clear());

// GHSA-63v6-w7qf-349f
describe('second-factor codes per account', () => {
  it('locks the account after too many wrong codes, from any address', async () => {
    for (let i = 0; i < TOTP_MAX_FAILURES - 1; i++) await recordTotpFailure(7);
    expect(await totpLockedOut(7)).toBe(false);
    await recordTotpFailure(7);
    expect(await totpLockedOut(7)).toBe(true);
    expect(await totpLockedOut(8)).toBe(false);
  });

  it('accepts a code once', async () => {
    const now = 1_700_000_000_000;
    expect(await claimTotpStep(7, 0, now)).toBe(true);
    expect(await claimTotpStep(7, 0, now + 5_000)).toBe(false);
    expect(await claimTotpStep(8, 0, now)).toBe(true);
  });

  it('clears the wrong-code count after a good code', async () => {
    await recordTotpFailure(7);
    await claimTotpStep(7, 0);
    expect(store.has('totp:fail:7')).toBe(false);
  });
});

describe('recordTotpFailure expiry', () => {
  it('a counter left without an expiry gets one, so a lockout always ends', async () => {
    store.set('totp:fail:99', '5'); // as left by a restart between INCR and EXPIRE
    ttls.delete('totp:fail:99');
    await recordTotpFailure(99);
    expect(store.get('totp:fail:99')).toBe('6');
    expect(ttls.get('totp:fail:99')).toBe(15 * 60);
  });
});
