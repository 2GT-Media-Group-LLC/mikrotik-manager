// Firewall Logs the way a zone firewall shows them (#415): the zone a packet
// came from and went to, and, when asked, names instead of addresses.
import { Resolver } from 'dns/promises';
import { query } from '../config/database';

/** The zone column for traffic to or from the router itself. */
export const ROUTER_ZONE = 'Router';

export interface ZoneFields {
  /** The device runs zones, so the line has zone columns. */
  zoned?: boolean;
  fromZone?: string;
  toZone?: string;
}

interface LogLine {
  deviceId: number | null;
  chain: 'input' | 'forward' | 'output';
  inInterface?: string;
  outInterface?: string;
}

/**
 * The zones of a line, from the interface map the device had when last read.
 * An interface that isn't in any zone leaves the field empty, and the page
 * shows the interface instead.
 */
export function zonesOf(line: LogLine, map: Record<string, string> | undefined): ZoneFields {
  if (!map) return {};
  const zoneOf = (i?: string) => (i && Object.prototype.hasOwnProperty.call(map, i) ? map[i] : undefined);
  return {
    zoned: true,
    fromZone: line.chain === 'output' ? ROUTER_ZONE : zoneOf(line.inInterface),
    toZone: line.chain === 'input' ? ROUTER_ZONE : zoneOf(line.outInterface),
  };
}

/** Each zone-managed device's interface map, for the devices in these lines. */
export async function zoneMaps(deviceIds: (number | null)[]): Promise<Map<number, Record<string, string>>> {
  const ids = [...new Set(deviceIds.filter((d): d is number => d != null))];
  if (!ids.length) return new Map();
  const rows = await query<{ device_id: number; interface_zones: Record<string, string> | null }>(
    `SELECT device_id, interface_zones FROM firewall_zone_configs WHERE enabled AND device_id = ANY($1::int[])`, [ids]);
  // A device switched to zones before the map existed gets an empty one until
  // it is next read, so the columns still read as zones.
  return new Map(rows.map((r) => [r.device_id, r.interface_zones ?? {}]));
}

export async function withZones<T extends LogLine>(lines: T[]): Promise<(T & ZoneFields)[]> {
  const maps = await zoneMaps(lines.map((l) => l.deviceId));
  if (!maps.size) return lines;
  return lines.map((l) => ({ ...l, ...zonesOf(l, l.deviceId != null ? maps.get(l.deviceId) : undefined) }));
}

// ─── Names ───────────────────────────────────────────────────────────────────

const CACHE_MAX = 5000;
const HIT_MS = 60 * 60_000;
const MISS_MS = 10 * 60_000;
/** How long a page waits for reverse DNS. Slower answers land in the cache for the next read. */
const BUDGET_MS = 1500;

const ptrCache = new Map<string, { name: string | null; until: number }>();
const pending = new Map<string, Promise<string | null>>();
let resolver: Resolver | null = null;

function remember(ip: string, name: string | null) {
  if (ptrCache.size >= CACHE_MAX) ptrCache.delete(ptrCache.keys().next().value as string);
  ptrCache.set(ip, { name, until: Date.now() + (name ? HIT_MS : MISS_MS) });
}

function ptr(ip: string): Promise<string | null> {
  const hit = ptrCache.get(ip);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.name);
  const inFlight = pending.get(ip);
  if (inFlight) return inFlight;
  resolver ??= new Resolver({ timeout: 1000, tries: 1 });
  const r = resolver;
  // reverse() throws at once on a malformed address; that's a miss too.
  const p = Promise.resolve().then(() => r.reverse(ip))
    .then((names) => (names[0] ? names[0].replace(/\.$/, '') : null), () => null)
    .then((name) => { remember(ip, name); pending.delete(ip); return name; });
  pending.set(ip, p);
  return p;
}

/** Test hook. */
export function clearNameCache() { ptrCache.clear(); pending.clear(); }

interface Endpoints { deviceId: number | null; srcIp: string; dstIp: string }

/**
 * Names for the addresses in these lines: a client's hostname from the same
 * site as the device that logged it, else reverse DNS from the manager's own
 * resolver. Addresses with neither stay as they are.
 */
export async function withNames<T extends Endpoints>(lines: T[], lookup: (ip: string) => Promise<string | null> = ptr):
  Promise<(T & { srcName?: string; dstName?: string })[]> {
  const ips = [...new Set(lines.flatMap((l) => [l.srcIp, l.dstIp]))];
  if (!ips.length) return lines;

  // Clients, by site (two customers can both have 192.168.88.10).
  const deviceIds = [...new Set(lines.map((l) => l.deviceId).filter((d): d is number => d != null))];
  const sites = new Map<number, number | null>();
  const clientNames = new Map<string, string>();
  if (deviceIds.length) {
    const devs = await query<{ id: number; site_id: number | null }>(
      `SELECT id, site_id FROM devices WHERE id = ANY($1::int[])`, [deviceIds]);
    for (const d of devs) sites.set(d.id, d.site_id);
    const rows = await query<{ site_id: number | null; ip_address: string; name: string }>(
      `SELECT DISTINCT ON (d.site_id, c.ip_address) d.site_id, c.ip_address, c.hostname AS name
         FROM clients c JOIN devices d ON d.id = c.device_id
        WHERE c.ip_address = ANY($1::text[]) AND COALESCE(c.hostname, '') <> ''
          AND (d.site_id = ANY($2::int[]) OR (d.site_id IS NULL AND $3::boolean))
        ORDER BY d.site_id, c.ip_address, c.last_seen DESC NULLS LAST`,
      [ips, [...new Set(sites.values())].filter((s) => s != null), [...sites.values()].includes(null)]);
    for (const r of rows) clientNames.set(`${r.site_id ?? ''}|${r.ip_address}`, r.name);
  }
  const clientName = (deviceId: number | null, ip: string) =>
    deviceId != null ? clientNames.get(`${sites.get(deviceId) ?? ''}|${ip}`) : undefined;

  // Reverse DNS for the rest, as far as the budget allows.
  const rest = ips.filter((ip) => lines.some((l) => (l.srcIp === ip || l.dstIp === ip) && !clientName(l.deviceId, ip)));
  const dns = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(rest.map((ip) => lookup(ip).then((n) => { if (n) dns.set(ip, n); }))),
    new Promise<void>((r) => { timer = setTimeout(r, BUDGET_MS); }),
  ]);
  clearTimeout(timer);

  return lines.map((l) => {
    const src = clientName(l.deviceId, l.srcIp) ?? dns.get(l.srcIp);
    const dst = clientName(l.deviceId, l.dstIp) ?? dns.get(l.dstIp);
    return { ...l, ...(src ? { srcName: src } : {}), ...(dst ? { dstName: dst } : {}) };
  });
}
