import { runProxyBackfills, startProxyBackfillsInBackground } from '../ProxyBackfillService';
import { pool } from '../../config/database';
import { backfillProxySources } from '../ProxyLogService';
import { backfillProxyUsage } from '../ProxyUsageService';

jest.mock('../../config/database', () => ({ pool: { connect: jest.fn() }, query: jest.fn() }));
jest.mock('../ProxyLogService', () => ({ backfillProxySources: jest.fn() }));
jest.mock('../ProxyUsageService', () => ({ backfillProxyUsage: jest.fn() }));

const connect = pool.connect as unknown as jest.Mock;
const sources = backfillProxySources as unknown as jest.Mock;
const usage = backfillProxyUsage as unknown as jest.Mock;

function fakeClient(lockGranted: boolean) {
  const release = jest.fn();
  const query = jest.fn(async (text: string) =>
    text.includes('pg_try_advisory_lock') ? { rows: [{ ok: lockGranted }] } : { rows: [] });
  connect.mockResolvedValue({ query, release });
  return { query, release };
}

describe('runProxyBackfills', () => {
  beforeEach(() => { connect.mockReset(); sources.mockReset(); usage.mockReset(); sources.mockResolvedValue(0); usage.mockResolvedValue(0); });

  it('runs the instance list then the rollup on its own client and releases the lock', async () => {
    const c = fakeClient(true);
    const order: string[] = [];
    sources.mockImplementation(async () => { order.push('sources'); return 2; });
    usage.mockImplementation(async () => { order.push('usage'); return 5; });
    await expect(runProxyBackfills()).resolves.toBe(true);
    expect(order).toEqual(['sources', 'usage']);
    expect(c.query.mock.calls.map(([t]) => String(t))).toEqual(expect.arrayContaining([
      expect.stringContaining('pg_try_advisory_lock'), expect.stringContaining('pg_advisory_unlock'),
    ]));
    expect(c.release).toHaveBeenCalled();
  });

  it('does nothing when another instance holds the lock', async () => {
    const c = fakeClient(false);
    await expect(runProxyBackfills()).resolves.toBe(true);
    expect(sources).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
    expect(c.release).toHaveBeenCalled();
  });

  it('unlocks and releases when a step fails, and rejects', async () => {
    const c = fakeClient(true);
    usage.mockRejectedValue(new Error('boom'));
    await expect(runProxyBackfills()).rejects.toThrow('boom');
    expect(c.query.mock.calls.some(([t]) => String(t).includes('pg_advisory_unlock'))).toBe(true);
    expect(c.release).toHaveBeenCalled();
  });

  it('does not start a second pass while one is running in this process', async () => {
    fakeClient(true);
    let finish!: () => void;
    sources.mockImplementation(() => new Promise<number>((r) => { finish = () => r(0); }));
    const first = runProxyBackfills();
    await new Promise((r) => setImmediate(r));
    await expect(runProxyBackfills()).resolves.toBe(false);
    finish();
    await first;
  });
});

describe('startProxyBackfillsInBackground', () => {
  beforeEach(() => { connect.mockReset(); sources.mockReset(); usage.mockReset(); sources.mockResolvedValue(0); usage.mockResolvedValue(0); });

  it('returns without waiting for a retry once a pass succeeds', async () => {
    fakeClient(true);
    await startProxyBackfillsInBackground([0, 10_000]);
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure and stops once it succeeds', async () => {
    fakeClient(true);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    usage.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(1);
    await startProxyBackfillsInBackground([0, 5]);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('gives up quietly after the last attempt so startup is never affected', async () => {
    fakeClient(true);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    usage.mockRejectedValue(new Error('boom'));
    await expect(startProxyBackfillsInBackground([0, 5])).resolves.toBeUndefined();
    expect(usage).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
