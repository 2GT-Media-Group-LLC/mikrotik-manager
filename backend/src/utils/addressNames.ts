// The DNS names behind addresses (#366), for the pages that show addresses:
// traffic destinations, firewall logs and sessions.
//
// Two sources, best first:
//   1. AdGuard Home answers (dns_answers): the name a client asked for that
//      answered with the address. Exact, and per client when `clientIps` is given.
//   2. Routers' DNS caches (dns_cache_names): names a resolving router looked
//      up that answered with the address, for the site. Not per client, but
//      covering any resolver in front of the router (Pi-hole, say).
// Up to `perAddress` names each, the most used first.

import { query } from '../config/database';

export async function namesForAddresses(
  ips: string[],
  opts: { sites: number[] | null; since: Date; clientIps?: string[]; perAddress?: number },
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const wanted = [...new Set(ips.filter(Boolean))].slice(0, 2000);
  if (wanted.length === 0) return out;
  const per = opts.perAddress ?? 5;
  const add = (ip: string, name: string) => {
    const list = out.get(ip) ?? [];
    if (list.length < per && !list.includes(name)) list.push(name);
    out.set(ip, list);
  };

  if (!opts.clientIps || opts.clientIps.length > 0) {
    const params: unknown[] = [wanted, opts.since];
    let where = 'ip = ANY($1::text[]) AND last_seen >= $2';
    if (opts.sites) { params.push(opts.sites); where += ` AND site_id = ANY($${params.length}::int[])`; }
    if (opts.clientIps) { params.push(opts.clientIps); where += ` AND client_ip = ANY($${params.length}::text[])`; }
    const rows = await query<{ ip: string; name: string }>(
      `SELECT ip, name FROM dns_answers WHERE ${where} GROUP BY ip, name ORDER BY ip, SUM(count) DESC`, params).catch(() => []);
    for (const r of rows) add(r.ip, r.name);
  }

  // The routers' caches for the rest (and to fill short lists).
  const rest = wanted.filter((ip) => (out.get(ip)?.length ?? 0) < per);
  if (rest.length) {
    const params: unknown[] = [rest, opts.since];
    let where = 'ip = ANY($1::text[]) AND last_seen >= $2';
    if (opts.sites) { params.push(opts.sites); where += ` AND site_id = ANY($${params.length}::int[])`; }
    const rows = await query<{ ip: string; name: string }>(
      `SELECT ip, name FROM dns_cache_names WHERE ${where} ORDER BY ip, last_seen DESC`, params).catch(() => []);
    for (const r of rows) add(r.ip, r.name);
  }
  return out;
}
