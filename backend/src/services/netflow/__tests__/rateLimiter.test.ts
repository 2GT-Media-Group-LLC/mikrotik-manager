import { PacketRateLimiter } from '../rateLimiter';

const OPTS = { windowMs: 1000, maxPerSource: 3, maxSources: 2 };

describe('PacketRateLimiter', () => {
  it('allows traffic up to the per-source limit and drops the excess', () => {
    const rl = new PacketRateLimiter(OPTS, 0);
    expect(rl.shouldDrop('10.0.0.1', 0)).toBe(false);
    expect(rl.shouldDrop('10.0.0.1', 10)).toBe(false);
    expect(rl.shouldDrop('10.0.0.1', 20)).toBe(false);
    expect(rl.shouldDrop('10.0.0.1', 30)).toBe(true); // 4th in window
    expect(rl.dropped).toBe(1);
  });

  it('resets each window so a well-behaved sender is never permanently blocked', () => {
    const rl = new PacketRateLimiter(OPTS, 0);
    for (let i = 0; i < 5; i++) rl.shouldDrop('10.0.0.1', i);
    expect(rl.shouldDrop('10.0.0.1', 50)).toBe(true);

    // New window
    expect(rl.shouldDrop('10.0.0.1', 1000)).toBe(false);
    expect(rl.trackedSources).toBe(1); // counters cleared, map stays bounded
  });

  it('limits each source independently', () => {
    const rl = new PacketRateLimiter(OPTS, 0);
    for (let i = 0; i < 4; i++) rl.shouldDrop('10.0.0.1', i);
    // A different source still gets its own budget
    expect(rl.shouldDrop('10.0.0.2', 5)).toBe(false);
  });

  it('caps distinct sources per window so spoofed IPs cannot grow the map', () => {
    const rl = new PacketRateLimiter(OPTS, 0);
    expect(rl.shouldDrop('1.1.1.1', 0)).toBe(false);
    expect(rl.shouldDrop('2.2.2.2', 1)).toBe(false);
    // Third distinct source exceeds maxSources
    expect(rl.shouldDrop('3.3.3.3', 2)).toBe(true);
    expect(rl.trackedSources).toBe(2);

    // Thousands of spoofed sources must not grow it past the cap
    for (let i = 0; i < 5000; i++) rl.shouldDrop(`10.1.${i % 255}.${i % 251}`, 3);
    expect(rl.trackedSources).toBe(2);
  });
});
