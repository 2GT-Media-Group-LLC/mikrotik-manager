/**
 * Run tasks with a ceiling on how many are in flight (issue #135).
 *
 * Firmware upgrades are not like bulk commands. A command is a short round
 * trip, so CommandRunner can fire a whole wave at once with Promise.all. An
 * upgrade holds an API connection for minutes across a download, a reboot and a
 * verification — and connection pressure is precisely where this system has
 * been shown to break. So concurrency is bounded rather than unlimited.
 *
 * Results are returned in input order regardless of completion order, because
 * callers pair them with the devices they came from.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const max = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let next = 0;

  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  // Never start more runners than there is work for them to do.
  await Promise.all(
    Array.from({ length: Math.min(max, items.length) }, () => runner())
  );
  return results;
}

/**
 * Clamp an operator-supplied concurrency to something sane.
 *
 * Rejecting silly values matters more here than elsewhere: this number decides
 * how many devices can be rebooting simultaneously.
 */
export const MAX_WAVE_CONCURRENCY = 20;

export function clampConcurrency(raw: unknown): number {
  const n = Number(raw);
  // NaN means "not a number at all" -> fall back to sequential. Infinity means
  // "as many as possible", so it clamps to the cap: treating it as unusable
  // would quietly do the opposite of what was asked.
  if (Number.isNaN(n)) return 1;
  if (n === Infinity) return MAX_WAVE_CONCURRENCY;
  if (n === -Infinity) return 1;
  return Math.min(MAX_WAVE_CONCURRENCY, Math.max(1, Math.floor(n)));
}
