// Per-source packet rate limiting for the NetFlow UDP collector.
//
// The collector socket is unauthenticated by nature (NetFlow/IPFIX has no auth),
// so anything able to reach the port can push packets as fast as it likes. Each
// packet costs template lookups and record parsing on the single Node event
// loop, so an unthrottled sender can starve the rest of the backend. This caps
// how much work any one source can force per window and drops the excess.
//
// Fixed-window rather than token-bucket: it's cheaper on the hot path, and the
// counters map is cleared every window so it can't grow without bound. A cap on
// distinct sources per window bounds it further against spoofed source IPs.

export interface RateLimiterOptions {
  /** Length of the counting window in ms. */
  windowMs: number;
  /** Packets allowed per source within a window. */
  maxPerSource: number;
  /** Distinct sources tracked per window; beyond this, new sources are dropped. */
  maxSources: number;
}

export class PacketRateLimiter {
  private counts = new Map<string, number>();
  private windowStart: number;
  private droppedCount = 0;

  constructor(private readonly opts: RateLimiterOptions, now: number = Date.now()) {
    this.windowStart = now;
  }

  /**
   * Record a packet from `source`. Returns true if it should be DROPPED.
   */
  shouldDrop(source: string, now: number = Date.now()): boolean {
    if (now - this.windowStart >= this.opts.windowMs) {
      this.counts.clear(); // bounds the map every window
      this.windowStart = now;
    }

    const current = this.counts.get(source);
    if (current === undefined && this.counts.size >= this.opts.maxSources) {
      // Too many distinct sources this window (likely spoofed) — drop rather
      // than track, so the map can't be grown arbitrarily.
      this.droppedCount++;
      return true;
    }

    const next = (current ?? 0) + 1;
    this.counts.set(source, next);
    if (next > this.opts.maxPerSource) {
      this.droppedCount++;
      return true;
    }
    return false;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** Number of distinct sources seen in the current window (for tests/stats). */
  get trackedSources(): number {
    return this.counts.size;
  }
}
