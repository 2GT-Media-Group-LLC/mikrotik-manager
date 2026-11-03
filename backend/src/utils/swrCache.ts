/**
 * A cache for values that are slow to fetch and slow to change (#368): the
 * dashboard's 24h CPU trend, the 7-day memory low, the 14-day baselines.
 *
 * - Fresh: the cached value is returned.
 * - Stale but not too old: the cached value is returned at once and refreshed
 *   in the background, so no request waits for the slow query.
 * - Missing or too old: the request waits for the query.
 *
 * Requests that arrive while a query runs wait for that query rather than
 * starting their own. A failed query caches nothing; it rejects only the
 * requests that were waiting for it, and a stale value stays in place.
 */
export interface SwrOptions {
  /** How long a value is served without asking again. */
  freshMs: number;
  /** How long a value may still be served while it is refreshed. */
  staleMs: number;
}

export class SwrCache<T> {
  private entries = new Map<string, { at: number; value: T }>();
  private inFlight = new Map<string, Promise<T>>();

  constructor(private opts: SwrOptions, private now: () => number = Date.now) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    const age = hit ? this.now() - hit.at : Infinity;
    if (hit && age < this.opts.freshMs) return hit.value;
    if (hit && age < this.opts.staleMs) {
      this.refresh(key, load).catch(() => { /* the stale value stays */ });
      return hit.value;
    }
    return this.refresh(key, load);
  }

  /**
   * Whatever is cached under a key, however old, without querying. Lets a
   * caller stand in a neighbouring value while the one it wants loads.
   */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  /**
   * As `get` when anything is cached under the key; otherwise starts the
   * query and returns `fallback` at once.
   */
  getOr<F>(key: string, load: () => Promise<T>, fallback: F): Promise<T> | F {
    if (this.entries.has(key)) return this.get(key, load);
    this.refresh(key, load).catch(() => { /* the next request tries again */ });
    return fallback;
  }

  /** Forget everything (tests). */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private refresh(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key);
    if (running) return running;
    // Started on the next tick, so the promise is recorded before the loader
    // can settle, even one that throws at once.
    const p = Promise.resolve()
      .then(load)
      .then((value) => {
        this.entries.set(key, { at: this.now(), value });
        return value;
      })
      .finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, p);
    return p;
  }
}
