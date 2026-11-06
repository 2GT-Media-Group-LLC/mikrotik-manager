/**
 * Device graphs (#402, steps 2–4): connections and NAT, firewall drops,
 * per-core CPU and temperatures, turned from RouterOS readings into what's
 * written to InfluxDB. Pure, so every rule is tested without a device.
 */
type Ros = Record<string, string>;
const yes = (v: string | undefined) => v === 'true' || v === 'yes';
const int = (v: string | undefined) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};

// ─── Connection tracking ─────────────────────────────────────────────────────

/**
 * Whether conntrack is doing anything here. `auto` turns it on only once
 * firewall, NAT or mangle rules exist, so most switches and APs have it off
 * and cost nothing.
 */
export function conntrackActive(t: Ros): boolean {
  if (t.enabled === 'no' || t.enabled === 'false') return false;
  if (yes(t.enabled)) return true;
  // RouterOS 7 says whether `auto` has switched it on; a few entries can be
  // left behind after it switches off, so they don't count when it says so.
  if (t['active-ipv4'] !== undefined || t['active-ipv6'] !== undefined) return yes(t['active-ipv4']) || yes(t['active-ipv6']);
  return int(t['total-entries']) > 0;
}

export interface ConntrackFields { total: number; max: number; ipv4: number; ipv6: number }

export function conntrackFields(t: Ros): ConntrackFields {
  return { total: int(t['total-entries']), max: int(t['max-entries']), ipv4: int(t['total-ip4-entries']), ipv6: int(t['total-ip6-entries']) };
}

/** Above this many entries the protocol and NAT split (which walks the table on the router) is skipped. */
export const CONNTRACK_SPLIT_LIMIT = 200_000;

// ─── Firewall drops ──────────────────────────────────────────────────────────

/** A mangle rule with this comment counts new connections: its packets/s is "new connections per second". */
export const NEW_CONN_COMMENT = 'mtm:new-conn';

export interface DropRule { key: string; chain: string; table: 'filter' | 'raw'; label: string; packets: number }

/** Enabled drop and reject rules from /ip/firewall/filter and raw, with their packet counters. */
export function dropRules(filter: Ros[], raw: Ros[]): DropRule[] {
  const out: DropRule[] = [];
  for (const [table, rows] of [['filter', filter], ['raw', raw]] as const) {
    for (const r of rows) {
      if (yes(r.disabled) || yes(r.dynamic) || !r['.id']) continue;
      if (r.action !== 'drop' && r.action !== 'reject') continue;
      const chain = table === 'raw' ? `raw-${r.chain ?? 'prerouting'}` : (r.chain ?? 'other');
      out.push({
        key: `${table}:${r['.id']}`, chain, table,
        label: (r.comment || `${chain} ${r.action} ${r['.id']}`).slice(0, 60),
        packets: int(r.packets),
      });
    }
  }
  return out;
}

export interface DropSample { at: number; byRule: Map<string, number>; newConn: number | null }

/**
 * Packets/s dropped per chain since the last sample, and each rule's own
 * count for the top-rules list. A rule that's new, or whose counter went
 * down (reset, reboot), is skipped for this interval. The first sample only
 * sets the baseline.
 */
export function dropRates(prev: DropSample | undefined, rules: DropRule[], newConnPackets: number | null, now: number): {
  sample: DropSample;
  perChain: Record<string, number> | null;
  perRule: { rule: DropRule; packets: number }[];
  newConnPerSec: number | null;
} {
  const sample: DropSample = { at: now, byRule: new Map(rules.map((r) => [r.key, r.packets])), newConn: newConnPackets };
  if (!prev) return { sample, perChain: null, perRule: [], newConnPerSec: null };
  const secs = Math.max(1, (now - prev.at) / 1000);
  const perChain: Record<string, number> = {};
  const perRule: { rule: DropRule; packets: number }[] = [];
  for (const r of rules) {
    perChain[r.chain] = perChain[r.chain] ?? 0;
    const before = prev.byRule.get(r.key);
    if (before === undefined || r.packets < before) continue;
    const d = r.packets - before;
    perChain[r.chain] += d / secs;
    if (d > 0) perRule.push({ rule: r, packets: d });
  }
  const newConnPerSec = newConnPackets !== null && prev.newConn !== null && newConnPackets >= prev.newConn
    ? (newConnPackets - prev.newConn) / secs : null;
  return { sample, perChain, perRule, newConnPerSec };
}

/** InfluxDB field names: a chain such as `raw-prerouting` becomes `pps_raw_prerouting`. */
export const chainField = (chain: string) => `pps_${chain.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;

// ─── CPU cores and temperatures ──────────────────────────────────────────────

/** Per-core load from /system/resource/cpu, only on multi-core devices. */
export function coreLoads(rows: Ros[]): Record<string, number> | null {
  if (rows.length < 2) return null;
  const out: Record<string, number> = {};
  rows.forEach((r, i) => {
    const name = (r.cpu || `cpu${i}`).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    out[name] = int(r.load);
  });
  return out;
}

/** Temperatures from /system/health (RouterOS 7 rows: name, value, type C). */
export function temperatures(rows: Ros[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if ((r.type ?? '').toUpperCase() !== 'C' || !r.name) continue;
    const v = parseFloat(r.value ?? '');
    if (!Number.isFinite(v)) continue;
    out[r.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()] = v;
  }
  return Object.keys(out).length ? out : null;
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** "10Gbps", "100Mbps", "2.5Gbps" → bits per second, or null. */
export function linkSpeedBps(rate: string | null | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt])bps$/i.exec((rate ?? '').trim());
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2].toLowerCase() as 'k' | 'm' | 'g' | 't'];
  return Number(m[1]) * mult;
}
