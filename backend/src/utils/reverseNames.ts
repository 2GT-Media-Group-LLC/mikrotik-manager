/**
 * Reverse DNS names for addresses shown in traffic views (#366), through the
 * manager's own resolver. Unreliable for CDNs, which is why the organisation
 * name comes first, but cheap: answers (and failures) are cached for a day,
 * and a lookup that takes longer than the timeout is shown without a name.
 */
import { reverse } from 'dns/promises';

const TTL_MS = 86_400_000;
const MAX_ENTRIES = 20_000;
const cache = new Map<string, { name: string | null; at: number }>();

function remember(ip: string, name: string | null): void {
  if (cache.size >= MAX_ENTRIES) {
    // The oldest entries go first: Map keeps insertion order.
    for (const k of [...cache.keys()].slice(0, MAX_ENTRIES / 10)) cache.delete(k);
  }
  cache.set(ip, { name, at: Date.now() });
}

async function one(ip: string, timeoutMs: number): Promise<string | null> {
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
  const lookup = reverse(ip).then((names) => names[0] ?? null).catch(() => null);
  const result = await Promise.race([lookup, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') {
    // Still finishing in the background: cache it when it does, for next time.
    void lookup.then((name) => remember(ip, name));
    return null;
  }
  remember(ip, result);
  return result;
}

/** Names for the given addresses, looked up together; missing ones are null. */
export async function reverseNames(ips: string[], timeoutMs = 800): Promise<Map<string, string | null>> {
  const unique = [...new Set(ips.filter(Boolean))].slice(0, 200);
  const names = await Promise.all(unique.map((ip) => one(ip, timeoutMs)));
  return new Map(unique.map((ip, i) => [ip, names[i]]));
}
