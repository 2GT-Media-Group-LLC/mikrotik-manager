// Names from the routers' own DNS caches (#366). A router that answers DNS for
// its network (allow-remote-requests) holds every name it resolved and the
// addresses that answered, for as long as each record's TTL. Read each fast
// poll, kept per site, they name the addresses traffic, firewall logs and
// sessions show, whatever resolver the clients use in front of the router.
//
// Records come and go by the minute; a pair already written is written again
// only every WRITE_EVERY_MS, so a busy cache costs a write per new name rather
// than a write per name per minute.

import { query } from '../../config/database';

export const WRITE_EVERY_MS = 10 * 60_000;
const CHUNK = 5_000;
const MAX_TRACKED = 200_000;

export interface CachePair { ip: string; name: string }

const cleanDnsName = (v: string | undefined) => (v || '').trim().toLowerCase().replace(/\.$/, '');
const validName = (n: string) => !!n && n.length <= 255 && /^[a-z0-9_.-]+$/.test(n);

/**
 * The (address, name) pairs of a /ip/dns/cache print, named as the client
 * asked. RouterOS keeps a CNAME and its target's addresses as separate records
 * (www.netflix.com CNAME ftl-www.netflix.com, which has the A records), so
 * each address is named by the names whose CNAME chain ends at it, the
 * question at the top of the chain, and by its own name only when nothing
 * points to it.
 */
export function cachePairs(rows: Record<string, string>[]): CachePair[] {
  const pointsTo = new Map<string, string[]>();   // CNAME target → names that point to it
  for (const r of rows) {
    if (r['type'] !== 'CNAME') continue;
    const from = cleanDnsName(r['name']);
    const to = cleanDnsName(r['data']);
    if (!validName(from) || !validName(to)) continue;
    pointsTo.set(to, [...(pointsTo.get(to) ?? []), from]);
  }
  // The names at the top of the chains ending at `name` (a bounded walk, so a loop can't hang).
  const roots = (name: string): string[] => {
    const out = new Set<string>();
    const seen = new Set<string>([name]);
    let level = [name];
    for (let depth = 0; depth < 8 && level.length; depth++) {
      const next: string[] = [];
      for (const n of level) {
        // A name nothing new points to is a top: nothing does, or only names already
        // walked (a loop).
        const up = (pointsTo.get(n) ?? []).filter((u) => !seen.has(u));
        if (up.length === 0) { out.add(n); continue; }
        for (const u of up) { seen.add(u); next.push(u); }
      }
      level = next;
    }
    for (const n of level) out.add(n);
    return out.size ? [...out] : [name];
  };

  const seen = new Set<string>();
  const out: CachePair[] = [];
  for (const r of rows) {
    if (r['type'] !== 'A' && r['type'] !== 'AAAA') continue;
    const ip = (r['data'] || '').trim();
    const name = cleanDnsName(r['name']);
    if (!validName(name) || !/^[0-9a-f.:]+$/i.test(ip)) continue;
    for (const n of roots(name)) {
      const k = `${ip}|${n}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ip, name: n });
    }
  }
  return out;
}

const lastWritten = new Map<string, number>();

/** The pairs not written in the last WRITE_EVERY_MS, marking them written. */
export function due(siteId: number, pairs: CachePair[], now = Date.now()): CachePair[] {
  if (lastWritten.size > MAX_TRACKED) {
    for (const [k, t] of lastWritten) if (now - t >= WRITE_EVERY_MS) lastWritten.delete(k);
  }
  return pairs.filter((p) => {
    const k = `${siteId}|${p.ip}|${p.name}`;
    const t = lastWritten.get(k);
    if (t !== undefined && now - t < WRITE_EVERY_MS) return false;
    lastWritten.set(k, now);
    return true;
  });
}

export async function writeCachePairs(siteId: number, pairs: CachePair[]): Promise<void> {
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const part = pairs.slice(i, i + CHUNK);
    await query(
      `INSERT INTO dns_cache_names (site_id, ip, name, first_seen, last_seen)
       SELECT $1, u.ip, u.name, NOW(), NOW() FROM unnest($2::text[], $3::text[]) AS u(ip, name)
       ON CONFLICT (site_id, ip, name) DO UPDATE SET last_seen = NOW()`,
      [siteId, part.map((p) => p.ip), part.map((p) => p.name)]);
  }
}
