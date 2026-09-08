import { mapWithConcurrency, clampConcurrency, MAX_WAVE_CONCURRENCY } from '../concurrency';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    // First item is slowest, so completion order is the reverse of input order.
    const out = await mapWithConcurrency([30, 20, 1], 3, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 20, 1]);
  });

  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  // The behaviour every existing rollout depends on: unchanged unless asked for.
  it('is strictly sequential at a limit of 1', async () => {
    const order: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4], 1, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await tick();
      order.push(n);
      inFlight--;
    });
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async (n) => {
      await tick(1);
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('handles an empty list without starting anything', async () => {
    let started = 0;
    const out = await mapWithConcurrency([], 5, async () => { started++; return 1; });
    expect(out).toEqual([]);
    expect(started).toBe(0);
  });

  it('does not start more runners than there is work', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 10, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  // A rejecting worker would abandon the wave mid-flight; the orchestrator
  // catches per device, but the helper must not be the thing that hides it.
  it('propagates a worker rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
  });
});

describe('clampConcurrency', () => {
  it('defaults to sequential for anything unusable', () => {
    for (const bad of [undefined, null, '', 'abc', NaN, {}, []]) {
      expect(clampConcurrency(bad)).toBe(1);
    }
  });

  it('never returns less than 1', () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-8)).toBe(1);
  });

  // This number decides how many devices may be rebooting at once.
  it('caps the upper end', () => {
    expect(clampConcurrency(1000)).toBe(MAX_WAVE_CONCURRENCY);
    expect(clampConcurrency(Infinity)).toBe(MAX_WAVE_CONCURRENCY);
  });

  it('floors fractional values', () => {
    expect(clampConcurrency(3.9)).toBe(3);
    expect(clampConcurrency('4')).toBe(4);
  });
});
