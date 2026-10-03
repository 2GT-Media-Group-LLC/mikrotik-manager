// Which device exported a flow, and which client (and site) an address belongs
// to. Kept pure so it can be tested without a socket or a database.
//
// Outside review P2-23 / J4: clients used to be matched by IP across the whole
// fleet, newest row wins, so with two customers both on 192.168.88.0/24 one
// customer's traffic was booked to the other's client. Now a flow is matched
// within the site of the device that exported it. Only when the exporter can't
// be identified (NAT between the routers and the collector) is the fleet
// searched, and then only an address that exists in exactly one site counts.

import { isIPv6 } from 'net';

export interface ExporterInfo {
  deviceId: number;
  deviceName: string;
  siteId: number | null;
}

export interface DeviceRow {
  id: number;
  name: string;
  site_id: number | null;
  ip_address: string;
  ip_addresses_jsonb: { address: string }[] | null;
}

export interface ClientRow {
  site_id: number | null;
  ip_address: string;
  mac_address: string;
}

export const AMBIGUOUS = 'ambiguous' as const;

export interface AttributionMaps {
  /** Exporter by source address; AMBIGUOUS when devices in different sites share it. */
  exporterByIp: Map<string, ExporterInfo | typeof AMBIGUOUS>;
  /** Per site (key: site id, 0 for none): client address → MAC. */
  clientBySite: Map<number, Map<string, string>>;
  /** Fleet-wide: client address → its one site and MAC, or AMBIGUOUS. */
  clientAnySite: Map<string, { siteId: number | null; mac: string } | typeof AMBIGUOUS>;
  /** The only site with devices, if there is exactly one. */
  soleSite: number | null;
}

const siteKey = (siteId: number | null): number => siteId ?? 0;

/**
 * One spelling per address, so a datagram's source matches the address a
 * device was saved with (#233). On the dual-stack socket an IPv4 sender
 * arrives as ::ffff:a.b.c.d; that becomes a.b.c.d. IPv6 is lowercased and
 * compressed the standard way (RFC 5952, via the URL parser), so a device
 * saved as 2001:DB8:0::1 matches packets from 2001:db8::1. Anything else,
 * including a zoned link-local address, is returned trimmed and lowercased.
 */
export function canonicalIp(raw: string): string {
  const ip = (raw || '').trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  try {
    return new URL(`http://[${ip}]`).hostname.slice(1, -1);
  } catch {
    return ip;
  }
}

function deviceAddresses(d: DeviceRow): string[] {
  const out = [canonicalIp(d.ip_address)];
  for (const entry of d.ip_addresses_jsonb || []) {
    const ip = (entry.address || '').split('/')[0];
    if (ip) out.push(canonicalIp(ip));
  }
  return out;
}

/**
 * Build the lookup maps. `clients` must be ordered newest first within each
 * (site, address), so the first row seen for a pair is the current holder.
 */
export function buildAttributionMaps(devices: DeviceRow[], clients: ClientRow[]): AttributionMaps {
  const exporterByIp = new Map<string, ExporterInfo | typeof AMBIGUOUS>();
  const deviceIpsBySite = new Map<number, Set<string>>();
  const allDeviceIps = new Set<string>();
  const sites = new Set<number | null>();

  for (const d of [...devices].sort((a, b) => a.id - b.id)) {
    sites.add(d.site_id);
    let own = deviceIpsBySite.get(siteKey(d.site_id));
    if (!own) { own = new Set(); deviceIpsBySite.set(siteKey(d.site_id), own); }
    for (const ip of deviceAddresses(d)) {
      own.add(ip);
      allDeviceIps.add(ip);
      const seen = exporterByIp.get(ip);
      if (seen === undefined) {
        exporterByIp.set(ip, { deviceId: d.id, deviceName: d.name, siteId: d.site_id });
      } else if (seen !== AMBIGUOUS && seen.siteId !== d.site_id) {
        // The same address on devices in two sites (192.168.88.1 is the
        // RouterOS default): the source alone can't say which site it is.
        exporterByIp.set(ip, AMBIGUOUS);
      }
      // Same site: the lowest id keeps it. The site, which is what matters
      // for attribution, is the same either way.
    }
  }

  const clientBySite = new Map<number, Map<string, string>>();
  const clientAnySite = new Map<string, { siteId: number | null; mac: string } | typeof AMBIGUOUS>();
  for (const c of clients) {
    if (!c.ip_address) continue;
    const key = siteKey(c.site_id);
    // A device's own addresses are not client endpoints we can bill to a MAC.
    if (deviceIpsBySite.get(key)?.has(c.ip_address)) continue;
    let map = clientBySite.get(key);
    if (!map) { map = new Map(); clientBySite.set(key, map); }
    if (map.has(c.ip_address)) continue; // an older holder of the address in this site
    const mac = c.mac_address.toLowerCase();
    map.set(c.ip_address, mac);

    if (allDeviceIps.has(c.ip_address)) continue;
    const any = clientAnySite.get(c.ip_address);
    if (any === undefined) clientAnySite.set(c.ip_address, { siteId: c.site_id, mac });
    else if (any !== AMBIGUOUS && any.siteId !== c.site_id) clientAnySite.set(c.ip_address, AMBIGUOUS);
  }

  const soleSite = sites.size === 1 ? [...sites][0] : null;
  return { exporterByIp, clientBySite, clientAnySite, soleSite };
}

export interface ClientMatch {
  mac?: string;
  siteId: number | null;
}

/**
 * The client behind `ip` for a flow from `exporter` (null when the exporter
 * couldn't be identified to one site). Unmatched addresses keep the
 * exporter's site, so a site's "unknown" traffic stays in that site.
 */
export function matchClient(maps: AttributionMaps, exporter: ExporterInfo | null, ip: string): ClientMatch {
  if (exporter) {
    const mac = maps.clientBySite.get(siteKey(exporter.siteId))?.get(ip);
    return { mac, siteId: exporter.siteId };
  }
  const any = maps.clientAnySite.get(ip);
  if (any && any !== AMBIGUOUS) return { mac: any.mac, siteId: any.siteId };
  return { siteId: maps.soleSite };
}

/** Private, link-local, CGNAT, loopback or ULA: where a NAT gateway would be. */
export function isLocalAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isLocalAddress(lower.slice(7));
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8');
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
