import { SwrCache } from '../swrCache';

/** A loader whose calls are counted and whose promises the test settles by hand. */
function deferredLoader<T>() {
  const pending: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
  const load = jest.fn(() => new Promise<T>((resolve, reject) => { pending.push({ resolve, reject }); }));
  return { load, pending };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('SwrCache (#368)', () => {
  let now = 0;
  const cache = () => new SwrCache<string>({ freshMs: 100, staleMs: 1000 }, () => now);
  beforeEach(() => { now = 0; });

  it('overlapping requests share one query', async () => {
    const c = cache();
    const { load, pending } = deferredLoader<string>();
    const a = c.get('k', load);
    const b = c.get('k', load);
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    pending[0].resolve('v1');
    await expect(Promise.all([a, b])).resolves.toEqual(['v1', 'v1']);
  });

  it('serves a fresh value without asking again', async () => {
    const c = cache();
    const load = jest.fn(async () => 'v1');
    await c.get('k', load);
    now = 99;
    await expect(c.get('k', load)).resolves.toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves a stale value at once and refreshes it in the background', async () => {
    const c = cache();
    await c.get('k', async () => 'v1');
    now = 500;
    const { load, pending } = deferredLoader<string>();
    await expect(c.get('k', load)).resolves.toBe('v1');
    await expect(c.get('k', load)).resolves.toBe('v1');
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    pending[0].resolve('v2');
    await tick();
    await expect(c.get('k', load)).resolves.toBe('v2');
  });

  it('waits for the query once a value is too old', async () => {
    const c = cache();
    await c.get('k', async () => 'v1');
    now = 1000;
    await expect(c.get('k', async () => 'v2')).resolves.toBe('v2');
  });

  it('a failed query caches nothing, and a stale value survives it', async () => {
    const c = cache();
    await expect(c.get('k', async () => { throw new Error('influx down'); })).rejects.toThrow('influx down');
    await expect(c.get('k', async () => 'v1')).resolves.toBe('v1');
    now = 500;
    await expect(c.get('k', async () => { throw new Error('influx down'); })).resolves.toBe('v1');
    await tick();
    now = 600;
    await expect(c.get('k', async () => 'v2')).resolves.toBe('v1');
  });

  it('a loader that throws at once is not left in flight', async () => {
    const c = cache();
    const bad = () => { throw new Error('sync'); };
    await expect(c.get('k', bad as unknown as () => Promise<string>)).rejects.toThrow('sync');
    await expect(c.get('k', async () => 'v1')).resolves.toBe('v1');
  });

  it('keys are separate', async () => {
    const c = cache();
    await c.get('a', async () => 'A');
    await expect(c.get('b', async () => 'B')).resolves.toBe('B');
    await expect(c.get('a', async () => 'x')).resolves.toBe('A');
  });
});

describe('SwrCache.getOr (#368)', () => {
  it('stands in the fallback while the first value loads, then serves it', async () => {
    const c = new SwrCache<string>({ freshMs: 100, staleMs: 1000 }, () => 0);
    const { load, pending } = deferredLoader<string>();
    expect(c.getOr('k', load, 'previous')).toBe('previous');
    expect(c.getOr('k', load, 'previous')).toBe('previous');
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    pending[0].resolve('v1');
    await tick();
    await expect(c.getOr('k', load, 'previous')).resolves.toBe('v1');
    expect(c.peek('k')).toBe('v1');
  });
});
