const store = new Map<string, string>();
jest.mock('../../config/redis', () => ({
  redis: {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    incr: jest.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
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
