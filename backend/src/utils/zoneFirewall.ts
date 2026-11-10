/**
 * Zone-based firewall (#369 phase 2).
 *
 * A zone is an interface list. The user fills in a matrix: for each pair of
 * zones, and from each zone to the router itself, deny, allow everything, or
 * allow some services. MTM compiles that into the whole IPv4 filter table:
 *
 *   input    established/related, invalid, loopback, the manager, then a jump
 *            per zone to "<zone>-to-router", then drop (logged)
 *   forward  FastTrack, established/related, invalid, same-zone accepts, a jump
 *            per open pair to "<from>-to-<to>", then drop (logged)
 *   chains   each pair's accepts, then a return
 *
 * RouterOS has no notion of zones, so the matrix lives in MTM; the device only
 * has the compiled rules. In zone mode MTM owns the filter table: an apply
 * makes the table match the compiled list, keeping rules that are already
 * right (and their counters) and adding or removing the rest. Anything changed
 * on the device afterwards shows up as drift.
 *
 * Pure, so the compiler, the diff and the validation are tested without a device.
 */
import { withTag, newTag, tagsIn } from './ruleTags';

type Ros = Record<string, string>;

export const ROUTER = '@router';

export type PolicyAction = 'deny' | 'allow' | 'services';
/**
 * A rule of your own inside a pair's "only these": a protocol and ports, and
 * from #369's follow-up, optionally a source and destination address (an
 * address, a subnet or a range). With an address, ports are optional, and the
 * protocol can be any. ICMP takes an optional type (`8`) or type and code
 * (`3:4`) in `icmp`; any other IP protocol is given by number in `number`
 * (89 for OSPF), both from #369's next follow-up.
 */
export interface CustomService {
  protocol: 'tcp' | 'udp' | 'any' | 'icmp' | 'other';
  ports: string;
  icmp?: string;
  number?: string;
  src?: string;
  dst?: string;
}

/**
 * RouterOS's names for IP protocols, by number, as RouterOS 7.25 prints them
 * (checked on a CRS3xx). A rule set with protocol=89 is printed back as "ospf", so the compiler writes the name and the diff
 * reads either as the number, or a rule just applied would show as drifted.
 */
export const PROTOCOL_NAMES: Record<number, string> = {
  1: 'icmp', 2: 'igmp', 3: 'ggp', 4: 'ipencap', 5: 'st', 6: 'tcp', 8: 'egp', 12: 'pup', 17: 'udp',
  20: 'hmp', 22: 'xns-idp', 27: 'rdp', 29: 'iso-tp4', 33: 'dccp', 36: 'xtp', 37: 'ddp', 38: 'idpr-cmtp',
  41: 'ipv6-encap', 43: 'ipv6-route', 44: 'ipv6-frag', 46: 'rsvp', 47: 'gre', 50: 'ipsec-esp', 51: 'ipsec-ah',
  58: 'icmpv6', 59: 'ipv6-nonxt', 60: 'ipv6-opts', 73: 'rspf', 81: 'vmtp', 89: 'ospf', 94: 'ipip', 97: 'etherip',
  98: 'encap', 103: 'pim', 112: 'vrrp', 115: 'l2tp', 132: 'sctp', 136: 'udp-lite',
};
const PROTOCOL_NUMBERS = new Map(Object.entries(PROTOCOL_NAMES).map(([n, name]) => [name, n]));
/** A protocol as a number when RouterOS knows its name, so "ospf" and "89" compare equal. */
const protocolKey = (v: string) => PROTOCOL_NUMBERS.get(v.toLowerCase()) ?? v;
/** What a custom rule writes in protocol=. */
export function customProtocol(cs: CustomService): string | null {
  if (cs.protocol === 'any') return null;
  if (cs.protocol === 'other') return PROTOCOL_NAMES[Number(cs.number)] ?? String(Number(cs.number));
  return cs.protocol;
}
/**
 * icmp-options for the diff. RouterOS prints it as it was set (8 stays 8), but
 * a type alone and the same type with every code match the same packets.
 */
const icmpKey = (v: string) => (v && !v.includes(':') ? `${v}:0-255` : v);
export interface ZonePolicy { action: PolicyAction; services: string[]; custom: CustomService[] }

export interface ZoneConfig {
  /** Interface list names, in the order the matrix shows them. */
  zones: string[];
  /** Same-zone traffic allowed, per zone. Missing means allowed. */
  intra: Record<string, boolean>;
  /** `${from}>${to}`, where `to` is a zone or ROUTER. Missing means deny. */
  policies: Record<string, ZonePolicy>;
  fasttrack: boolean;
  logDrops: boolean;
  /**
   * What the manager's own address may reach on the router (#369): everything
   * (missing, as before), or only the ports the manager uses: the API, API-SSL
   * and SSH, on the ports /ip/service has.
   */
  managerAccess?: 'management';
}

/** What the compiler needs from the device. */
export interface ZoneContext {
  /** /ip/service rows: name, port. */
  services: Ros[];
  rosMajor: number;
  /** The manager's address as the device sees it, when known: always let in. */
  managerIp: string | null;
  /** The device takes hw-offload on a FastTrack rule (some RouterOS 7 builds don't, #369). */
  fasttrackHwOffload?: boolean;
}

// ─── Services ────────────────────────────────────────────────────────────────

interface ServiceDef { label: string; rules: { protocol: string; port?: string; ros?: string[] }[] }

/** Services between zones, on their usual ports. */
export const FORWARD_SERVICES: Record<string, ServiceDef> = {
  ping: { label: 'Ping', rules: [{ protocol: 'icmp' }] },
  web: { label: 'Web (80, 443)', rules: [{ protocol: 'tcp', port: '80,443' }] },
  dns: { label: 'DNS', rules: [{ protocol: 'udp', port: '53' }, { protocol: 'tcp', port: '53' }] },
  ssh: { label: 'SSH', rules: [{ protocol: 'tcp', port: '22' }] },
  rdp: { label: 'Remote Desktop', rules: [{ protocol: 'tcp', port: '3389' }] },
  smb: { label: 'File sharing (SMB)', rules: [{ protocol: 'tcp', port: '445' }] },
  ntp: { label: 'NTP', rules: [{ protocol: 'udp', port: '123' }] },
};

/** Services on the router; the management ones on the ports /ip/service has. */
export const ROUTER_SERVICES: Record<string, ServiceDef> = {
  ping: { label: 'Ping', rules: [{ protocol: 'icmp' }] },
  winbox: { label: 'Winbox', rules: [{ protocol: 'tcp', port: '8291', ros: ['winbox'] }] },
  ssh: { label: 'SSH', rules: [{ protocol: 'tcp', port: '22', ros: ['ssh'] }] },
  web: { label: 'WebFig', rules: [{ protocol: 'tcp', port: '80,443', ros: ['www', 'www-ssl'] }] },
  api: { label: 'API', rules: [{ protocol: 'tcp', port: '8728,8729', ros: ['api', 'api-ssl'] }] },
  dns: { label: 'DNS', rules: [{ protocol: 'udp', port: '53' }, { protocol: 'tcp', port: '53' }] },
  dhcp: { label: 'DHCP', rules: [{ protocol: 'udp', port: '67' }] },
  ntp: { label: 'NTP', rules: [{ protocol: 'udp', port: '123' }] },
  snmp: { label: 'SNMP', rules: [{ protocol: 'udp', port: '161' }] },
};

const SERVICE_PORT = new Map([['winbox', '8291'], ['ssh', '22'], ['www', '80'], ['www-ssl', '443'], ['api', '8728'], ['api-ssl', '8729']]);

/** The port a management service listens on, from /ip/service. */
function servicePorts(names: string[], services: Ros[], fallback: string): string {
  const ports = names.map((n) => services.find((s) => s.name === n)?.port || SERVICE_PORT.get(n) || '').filter(Boolean);
  return ports.length ? [...new Set(ports)].join(',') : fallback;
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** RouterOS's own lists, which can't be zones. */
export const BUILTIN_LISTS = ['all', 'none', 'dynamic', 'static'];
const ZONE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

const chainPart = (zone: string) => zone.replace(/[^A-Za-z0-9_]+/g, '_');
export function pairChain(from: string, to: string): string {
  return to === ROUTER ? `${chainPart(from)}-to-router` : `${chainPart(from)}-to-${chainPart(to)}`;
}
export const pairKey = (from: string, to: string) => `${from}>${to}`;

const COMMENT = (what: string) => `mtm zone: ${what}`;
export const isZoneComment = (c: string | undefined) => (c ?? '').startsWith('mtm zone:');
const toLabel = (to: string) => (to === ROUTER ? 'router' : to);

// ─── Validation ──────────────────────────────────────────────────────────────

const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;
function portsError(ports: string): string | null {
  const p = ports.replace(/\s+/g, '');
  if (!PORTS.test(p)) return `"${ports}" isn't a port list. Use numbers and ranges, such as 8080 or 5000-5010,6000.`;
  for (const part of p.split(',')) {
    const [lo, hi] = part.split('-').map(Number);
    if (lo < 1 || lo > 65535 || (hi !== undefined && (hi < lo || hi > 65535))) return `${part} isn't a valid port or range.`;
  }
  return null;
}

const OCTETS = (a: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m && m.slice(1).every((o) => Number(o) <= 255) ? m.slice(1).map(Number) : null;
};
const ipNum = (o: number[]) => ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];

/** An IPv4 address, subnet (10.0.0.0/24) or range (10.0.0.10-10.0.0.20), as RouterOS takes in src-address. */
export function addressError(value: string): string | null {
  const v = value.trim();
  const range = v.split('-');
  if (range.length === 2) {
    const [a, b] = range.map((x) => OCTETS(x.trim()));
    if (!a || !b) return `"${v}" isn't an address range. Use two addresses, such as 10.0.0.10-10.0.0.20.`;
    return ipNum(a) <= ipNum(b) ? null : `${v} runs backwards.`;
  }
  const [addr, prefix, extra] = v.split('/');
  if (extra !== undefined || !OCTETS(addr)) return `"${v}" isn't an IPv4 address. Use an address, a subnet such as 10.0.0.0/24, or a range.`;
  if (prefix !== undefined && !(/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32)) return `/${prefix} isn't a prefix length (0 to 32).`;
  return null;
}

const BYTE = (v: string) => /^\d{1,3}$/.test(v) && Number(v) <= 255;
/** An ICMP type, or type:code, or type:code-code, as RouterOS takes in icmp-options. */
export function icmpError(value: string): string | null {
  const [type, codes, extra] = value.split(':');
  const range = (codes ?? '').split('-');
  const ok = extra === undefined && BYTE(type) && (codes === undefined
    || (range.length <= 2 && range.every(BYTE) && (range.length === 1 || Number(range[0]) <= Number(range[1]))));
  return ok ? null : `"${value}" isn't an ICMP type. Use a type such as 8, or a type and code such as 3:4.`;
}

// ─── Hostnames (#369) ────────────────────────────────────────────────────────
//
// A rule's source or destination can be a hostname. RouterOS keeps an address
// list from a static entry holding the name: it resolves it with its own DNS
// and adds every A record as a dynamic entry, refreshed as the records change
// (checked on 7.25: one.one.one.one gave 1.1.1.1 and 1.0.0.1, and removing
// the static entry took them away). Zones keep one list per name, and the rule
// matches the list.

/** The comment on every address-list entry zones keep, so they can be found without reading the whole table. */
export const ZONE_HOST_COMMENT = 'mtm zone host';
const LABEL = /^[a-z0-9-]{1,63}$/;
/** Labels of letters, digits and hyphens (not at either end), at least two, the last not all digits. */
function hostShaped(v: string): boolean {
  const labels = v.toLowerCase().split('.');
  return v.length <= 253 && labels.length >= 2
    && labels.every((l) => LABEL.test(l) && !l.startsWith('-') && !l.endsWith('-'))
    && /[a-z]/.test(labels[labels.length - 1]);
}
/** A hostname such as smtp.office365.com, as opposed to an address, subnet or range. */
export const isHostname = (v: string): boolean => !/^[\d./-]+$/.test(v) && hostShaped(v);
/** The address list a hostname's rules match. */
export const hostList = (host: string): string => `mtm-zone-${host.toLowerCase()}`;

/** An address, subnet, range or hostname, as a custom rule takes it. */
export function endpointError(value: string): string | null {
  const v = value.trim();
  if (/^[\d./-]+$/.test(v)) return addressError(v);
  return isHostname(v) ? null
    : `"${v}" isn't an IPv4 address or a hostname. Use an address, a subnet such as 10.0.0.0/24, a range, or a name such as smtp.office365.com.`;
}

/** Every hostname the config's custom rules use, each once. */
export function zoneHosts(config: ZoneConfig): string[] {
  const hosts = new Set<string>();
  for (const p of Object.values(config.policies)) {
    for (const c of p.custom ?? []) for (const v of [c.src, c.dst]) if (v && isHostname(v)) hosts.add(v.toLowerCase());
  }
  return [...hosts].sort();
}

/** The address-list entries to add and remove so the device holds exactly one per hostname in use. */
export function planHostLists(current: Ros[], hosts: string[]): { add: Ros[]; remove: { id: string; list: string }[] } {
  const want = new Map(hosts.map((h) => [hostList(h), h]));
  const have = new Set<string>();
  const remove: { id: string; list: string }[] = [];
  for (const e of current) {
    const key = e.list ?? '';
    if (want.get(key) === (e.address ?? '').toLowerCase() && !have.has(key)) have.add(key);
    else if (e['.id']) remove.push({ id: e['.id'], list: key });
  }
  const add = [...want].filter(([list]) => !have.has(list)).map(([list, address]) => ({ list, address, comment: ZONE_HOST_COMMENT }));
  return { add, remove };
}

/** A custom rule's parts in a few words, for the comment and the plan. */
export function customText(cs: CustomService): string {
  const proto = cs.protocol === 'other' ? (PROTOCOL_NAMES[Number(cs.number)] ?? `protocol ${cs.number}`) : cs.protocol;
  const parts = [proto, cs.protocol === 'icmp' ? (cs.icmp ? `type ${cs.icmp}` : '') : cs.ports || '',
    cs.src ? `from ${cs.src}` : '', cs.dst ? `to ${cs.dst}` : ''];
  return parts.filter(Boolean).join(' ');
}

export interface ZoneInput {
  config: ZoneConfig;
  /** Interfaces in each zone, as they should be. */
  members: Record<string, string[]>;
}

export interface ZoneLive {
  /** Interface list names on the device. */
  lists: string[];
  interfaces: string[];
}

/**
 * Parse and check a request body. Errors are keyed for the form: `zones`,
 * `zone:<name>`, `pair:<from>><to>`, `members`.
 */
export function parseZoneInput(body: unknown, live: ZoneLive): { input: ZoneInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const b = (body ?? {}) as Record<string, unknown>;
  const c = (b.config ?? {}) as Record<string, unknown>;
  const zones = Array.isArray(c.zones) ? c.zones.map((z) => String(z).trim()) : [];

  if (!zones.length) errors.zones = 'Add at least one zone.';
  if (zones.length > 16) errors.zones = 'Up to 16 zones.';
  const seen = new Set<string>();
  const chains = new Map<string, string>();
  for (const z of zones) {
    if (!ZONE_NAME.test(z)) errors[`zone:${z}`] = `"${z}" can't be a zone name: letters, digits, spaces, _ . and -, up to 40.`;
    else if (BUILTIN_LISTS.includes(z.toLowerCase())) errors[`zone:${z}`] = `${z} is one of RouterOS's own lists and can't be a zone.`;
    else if (z.toLowerCase() === 'router') errors[`zone:${z}`] = '"router" is kept for traffic to the router itself.';
    else if (seen.has(z.toLowerCase())) errors[`zone:${z}`] = `${z} is listed twice.`;
    const part = chainPart(z).toLowerCase();
    if (chains.has(part) && chains.get(part) !== z) errors[`zone:${z}`] = `${z} and ${chains.get(part)} are too alike for chain names; rename one.`;
    chains.set(part, z);
    seen.add(z.toLowerCase());
  }

  const intraIn = (c.intra ?? {}) as Record<string, unknown>;
  const intra: Record<string, boolean> = {};
  for (const z of zones) intra[z] = intraIn[z] !== false;

  const policiesIn = (c.policies ?? {}) as Record<string, unknown>;
  const policies: Record<string, ZonePolicy> = {};
  for (const from of zones) {
    for (const to of [...zones.filter((z) => z !== from), ROUTER]) {
      const key = pairKey(from, to);
      const p = policiesIn[key] as Record<string, unknown> | undefined;
      if (!p) continue;
      const action = p.action === 'allow' || p.action === 'services' ? p.action : 'deny';
      if (action === 'deny') continue;
      const catalog = to === ROUTER ? ROUTER_SERVICES : FORWARD_SERVICES;
      const services = Array.isArray(p.services) ? [...new Set(p.services.map(String))].filter((s) => s in catalog) : [];
      const custom: CustomService[] = [];
      for (const raw of Array.isArray(p.custom) ? p.custom : []) {
        const r = raw as Record<string, unknown>;
        const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, '');
        let protocol: CustomService['protocol'] = r.protocol === 'udp' || r.protocol === 'any' || r.protocol === 'icmp'
          || r.protocol === 'other' ? r.protocol : 'tcp';
        let number = protocol === 'other' ? clean(r.number) : '';
        // A number RouterOS has its own choice for is that choice.
        const asNamed = ({ '1': 'icmp', '6': 'tcp', '17': 'udp' } as const)[String(Number(number)) as '1' | '6' | '17'];
        if (number && asNamed) { protocol = asNamed; number = ''; }
        const ports = protocol === 'tcp' || protocol === 'udp' ? clean(r.ports) : '';
        const icmp = protocol === 'icmp' ? clean(r.icmp) : '';
        // A hostname is kept in lower case: the list is named after it.
        const endpoint = (v: unknown) => { const e = clean(v); return isHostname(e) ? e.toLowerCase() : e; };
        const src = endpoint(r.src);
        const dst = endpoint(r.dst);
        // An empty row is left out, as before. ICMP and a protocol number say
        // enough on their own.
        if (!clean(r.ports) && !src && !dst && protocol !== 'icmp' && protocol !== 'other') continue;
        const e = (clean(r.ports) && (protocol === 'any' || (protocol === 'other' && !asNamed)) ? 'Ports need TCP or UDP.' : null)
          ?? (protocol === 'other' && !(/^\d{1,3}$/.test(number) && Number(number) >= 1 && Number(number) <= 255)
            ? `${number ? `"${number}" isn't` : 'Enter'} an IP protocol number, 1 to 255 (89 is OSPF).` : null)
          ?? (ports ? portsError(ports) : null)
          ?? (icmp ? icmpError(icmp) : null)
          ?? (src ? endpointError(src) : null)
          ?? (dst ? endpointError(dst) : null);
        if (e) { errors[`pair:${key}`] = e; continue; }
        custom.push({
          protocol, ports, ...(icmp ? { icmp } : {}), ...(number ? { number: String(Number(number)) } : {}),
          ...(src ? { src } : {}), ...(dst ? { dst } : {}),
        });
      }
      if (custom.length > 10) errors[`pair:${key}`] = 'Up to 10 custom rules per pair.';
      if (action === 'services' && !services.length && !custom.length && !errors[`pair:${key}`]) {
        errors[`pair:${key}`] = `Pick at least one service from ${from} to ${toLabel(to)}, or deny it.`;
      }
      policies[key] = action === 'allow' ? { action, services: [], custom: [] } : { action, services, custom };
    }
  }

  const membersIn = (b.members ?? {}) as Record<string, unknown>;
  const members: Record<string, string[]> = {};
  const owner = new Map<string, string>();
  for (const z of zones) {
    const list = Array.isArray(membersIn[z]) ? [...new Set((membersIn[z] as unknown[]).map(String))] : [];
    for (const i of list) {
      if (!live.interfaces.includes(i)) errors[`zone:${z}`] = `${i} isn't an interface on this device.`;
      else if (owner.has(i)) errors.members = `${i} is in both ${owner.get(i)} and ${z}. An interface can be in one zone.`;
      owner.set(i, z);
    }
    members[z] = list;
  }

  const config: ZoneConfig = {
    zones, intra, policies, fasttrack: c.fasttrack !== false, logDrops: c.logDrops !== false,
    // Only written when chosen, so a setup saved before the choice existed is unchanged.
    ...(c.managerAccess === 'management' ? { managerAccess: 'management' as const } : {}),
  };
  return { input: Object.keys(errors).length ? null : { config, members }, errors };
}

// ─── Compiler ────────────────────────────────────────────────────────────────

export interface CompiledRule {
  params: Ros;
  /** The return at the end of a chain and the final drops: not shown in the matrix. */
  hidden: boolean;
  /** For the plan: what the rule is for. */
  description: string;
}

function serviceRules(key: string, p: ZonePolicy, to: string, ctx: ZoneContext): CompiledRule[] {
  const chain = pairChain(key.split('>')[0], to);
  const label = key.replace('>', ' to ').replace(ROUTER, 'router');
  if (p.action === 'allow') {
    return [{ params: { chain, action: 'accept', comment: COMMENT(`${label}: everything`) }, hidden: false, description: `${label}: everything` }];
  }
  const catalog = to === ROUTER ? ROUTER_SERVICES : FORWARD_SERVICES;
  const out: CompiledRule[] = [];
  for (const s of p.services) {
    const def = catalog[s];
    if (!def) continue;
    for (const r of def.rules) {
      const port = r.ros ? servicePorts(r.ros, ctx.services, r.port ?? '') : r.port;
      const params: Ros = { chain, action: 'accept', protocol: r.protocol, ...(port ? { 'dst-port': port } : {}), comment: COMMENT(`${label}: ${s}`) };
      out.push({ params, hidden: false, description: `${label}: ${def.label}${def.rules.length > 1 ? ` (${r.protocol})` : ''}` });
    }
  }
  for (const cs of p.custom) {
    // A protocol and ports alone write the same rule and comment as before
    // addresses existed, so a saved setup doesn't show as drifted.
    const text = customText(cs);
    const protocol = customProtocol(cs);
    out.push({
      params: {
        chain, action: 'accept',
        ...(protocol ? { protocol } : {}),
        ...(cs.ports ? { 'dst-port': cs.ports } : {}),
        ...(cs.icmp ? { 'icmp-options': cs.icmp } : {}),
        ...(cs.src ? (isHostname(cs.src) ? { 'src-address-list': hostList(cs.src) } : { 'src-address': cs.src }) : {}),
        ...(cs.dst ? (isHostname(cs.dst) ? { 'dst-address-list': hostList(cs.dst) } : { 'dst-address': cs.dst }) : {}),
        comment: COMMENT(`${label}: ${text}`),
      },
      hidden: false, description: `${label}: ${text.replace(/^(tcp|udp|any|icmp|ospf|gre|vrrp)\b/, (m) => m.toUpperCase())}`,
    });
  }
  return out;
}

/** The whole IPv4 filter table for a zone config, in order. */
export function compileZones(config: ZoneConfig, ctx: ZoneContext): CompiledRule[] {
  const rules: CompiledRule[] = [];
  const add = (params: Ros, description: string, hidden = false) => rules.push({ params: { ...params, comment: COMMENT(description) }, hidden, description });
  const open = (from: string, to: string) => {
    const p = config.policies[pairKey(from, to)];
    return p && p.action !== 'deny' ? p : null;
  };
  const dropLog = (where: string): Ros => (config.logDrops ? { log: 'yes', 'log-prefix': `zone drop ${where}` } : {});

  // Input: the router itself.
  add({ chain: 'input', action: 'accept', 'connection-state': 'established,related,untracked' }, 'accept established, related, untracked to the router');
  add({ chain: 'input', action: 'drop', 'connection-state': 'invalid' }, 'drop invalid to the router');
  add({ chain: 'input', action: 'accept', 'dst-address': '127.0.0.1' }, 'accept loopback (CAPsMAN)');
  if (ctx.managerIp && config.managerAccess === 'management') {
    // All the manager connects to: the API (8728 or 8729) and SSH (terminal,
    // SSH-only devices, keys). It doesn't ping or poll SNMP.
    const ports = servicePorts(['api', 'api-ssl', 'ssh'], ctx.services, '8728,8729,22');
    add({ chain: 'input', action: 'accept', protocol: 'tcp', 'src-address': ctx.managerIp, 'dst-port': ports }, `accept the manager on ${ports}`);
  } else if (ctx.managerIp) {
    add({ chain: 'input', action: 'accept', 'src-address': ctx.managerIp }, 'accept the manager');
  }
  for (const z of config.zones) {
    if (open(z, ROUTER)) add({ chain: 'input', action: 'jump', 'jump-target': pairChain(z, ROUTER), 'in-interface-list': z }, `${z} to router`);
  }
  add({ chain: 'input', action: 'drop', ...dropLog('in') }, 'drop everything else to the router', true);

  // Forward: between zones.
  if (config.fasttrack) {
    add({ chain: 'forward', action: 'fasttrack-connection', 'connection-state': 'established,related', ...(ctx.rosMajor >= 7 && ctx.fasttrackHwOffload ? { 'hw-offload': 'yes' } : {}) }, 'fasttrack established, related');
  }
  add({ chain: 'forward', action: 'accept', 'connection-state': 'established,related,untracked' }, 'accept established, related, untracked');
  add({ chain: 'forward', action: 'drop', 'connection-state': 'invalid' }, 'drop invalid');
  for (const z of config.zones) {
    if (config.intra[z] !== false) add({ chain: 'forward', action: 'accept', 'in-interface-list': z, 'out-interface-list': z }, `${z} to ${z}`);
  }
  for (const from of config.zones) {
    for (const to of config.zones) {
      if (from !== to && open(from, to)) {
        add({ chain: 'forward', action: 'jump', 'jump-target': pairChain(from, to), 'in-interface-list': from, 'out-interface-list': to }, `${from} to ${to}`);
      }
    }
  }
  add({ chain: 'forward', action: 'drop', ...dropLog('fwd') }, 'drop everything else between zones', true);

  // Each open pair's chain: its accepts, then back to where it came from.
  for (const from of config.zones) {
    for (const to of [...config.zones.filter((z) => z !== from), ROUTER]) {
      const p = open(from, to);
      if (!p) continue;
      rules.push(...serviceRules(pairKey(from, to), p, to, ctx));
      add({ chain: pairChain(from, to), action: 'return' }, `${from} to ${toLabel(to)}: back`, true);
    }
  }
  return rules;
}

// ─── Comparing with the device ───────────────────────────────────────────────

const yes = (v: string | undefined) => v === 'true' || v === 'yes';
const SET_FIELDS = new Set(['connection-state', 'dst-port']);
/** What decides what a rule matches and does, plus its comment and log prefix (without the tag). */
const SIGNATURE_FIELDS = ['chain', 'action', 'connection-state', 'protocol', 'dst-port', 'icmp-options', 'src-address', 'dst-address',
  'src-address-list', 'dst-address-list',
  'in-interface-list', 'out-interface-list', 'jump-target', 'comment', 'log-prefix'];
const FLAG_FIELDS = ['log', 'disabled', 'hw-offload'];

/** A rule's identity for the diff: the same signature means the rule is already right. */
export function signature(r: Ros): string {
  const parts = SIGNATURE_FIELDS.map((f) => {
    let v = (r[f] ?? '').trim();
    if (f === 'log-prefix') v = withoutTag(v);
    if (f === 'protocol') v = protocolKey(v);
    if (f === 'icmp-options') v = icmpKey(v);
    if (SET_FIELDS.has(f)) v = v.split(',').map((x) => x.trim()).filter(Boolean).sort().join(',');
    return v;
  });
  const flags = FLAG_FIELDS.map((f) => (yes(r[f]) ? '1' : '0'));
  // Any matcher the compiler never writes makes the rule different.
  const extra = Object.keys(r).filter((k) => !k.startsWith('.') && !KNOWN.has(k) && r[k] !== '' && !(yes(r[k]) === false && /^(true|false|yes|no)$/.test(r[k])))
    .sort().map((k) => `${k}=${r[k]}`);
  return [...parts, ...flags, ...extra].join('|');
}
const KNOWN = new Set([...SIGNATURE_FIELDS, ...FLAG_FIELDS, 'bytes', 'packets', 'dynamic', 'invalid', 'place-before', 'passthrough']);
const withoutTag = (prefix: string) => prefix.replace(/(?:^|\s)mtm#[0-9a-z]{4}(?=\s|$)/i, ' ').replace(/\s+/g, ' ').trim();

const configured = (rows: Ros[]) => rows.filter((r) => !yes(r.dynamic) && r['.id']);

export interface ApplyPlan {
  /** New rules in apply order, each before a kept rule or at the end. */
  add: { params: Ros; placeBefore?: string; description: string }[];
  /** Rules to remove: not in the compiled list. */
  remove: { id: string; rule: Ros }[];
  keep: number;
}

/**
 * Make the device's filter table match `desired`. The longest run of rules
 * already right, in order, stays (with its counters); the rest is added in
 * place or removed. New rules that log get a tag (#369 phase 1).
 */
export function planApply(current: Ros[], desired: CompiledRule[]): ApplyPlan {
  const cur = configured(current);
  const a = cur.map(signature);
  const b = desired.map((d) => signature(d.params));
  // Longest common subsequence.
  const n = a.length; const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keptFor = new Array<number>(m).fill(-1);
  const keptCur = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { keptFor[j] = i; keptCur.add(i); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }

  const taken = tagsIn(cur.filter((_, i) => keptCur.has(i)));
  const add: ApplyPlan['add'] = [];
  for (let j = 0; j < m; j++) {
    if (keptFor[j] >= 0) continue;
    const next = keptFor.slice(j + 1).find((i) => i >= 0);
    let params = desired[j].params;
    if (yes(params.log)) {
      const t = newTag(taken); taken.add(t);
      params = { ...params, 'log-prefix': withTag(params['log-prefix'], t) };
    }
    add.push({ params, ...(next !== undefined ? { placeBefore: cur[next]['.id'] } : {}), description: desired[j].description });
  }
  // Drops go first, then the rest from the bottom up, so an accept is never
  // gone while a drop it used to sit above is still there.
  const isDrop = (r: Ros) => ['drop', 'reject', 'tarpit'].includes(r.action);
  const old = cur.filter((_, i) => !keptCur.has(i)).reverse();
  const remove = [...old.filter(isDrop), ...old.filter((r) => !isDrop(r))].map((r) => ({ id: r['.id'], rule: r }));
  return { add, remove, keep: keptCur.size };
}

/**
 * Can zone mode start here? Only on an empty table or MikroTik's defaults
 * (and rules an earlier zone setup wrote), since it replaces the whole table.
 */
export function zoneEligibility(filter: Ros[]): { ok: boolean; foreign: number } {
  const foreign = configured(filter).filter((r) => !(r.comment ?? '').startsWith('defconf') && !isZoneComment(r.comment)).length;
  return { ok: foreign === 0, foreign };
}

// ─── Interface lists ─────────────────────────────────────────────────────────

export interface MemberPlan {
  createLists: string[];
  addMembers: { list: string; interface: string }[];
  removeMembers: { id: string; list: string; interface: string }[];
}

/** The list and member changes that give each zone exactly its interfaces. Dynamic members are left alone. */
export function planMembers(lists: string[], members: Ros[], want: Record<string, string[]>): MemberPlan {
  const plan: MemberPlan = { createLists: [], addMembers: [], removeMembers: [] };
  for (const [zone, ifaces] of Object.entries(want)) {
    if (!lists.includes(zone)) plan.createLists.push(zone);
    const now = members.filter((m) => m.list === zone && !yes(m.dynamic));
    for (const i of ifaces) if (!now.some((m) => m.interface === i)) plan.addMembers.push({ list: zone, interface: i });
    for (const m of now) if (!ifaces.includes(m.interface)) plan.removeMembers.push({ id: m['.id'], list: zone, interface: m.interface });
  }
  return plan;
}

/**
 * Which zone each interface is in (#415), so Firewall Logs can show zones
 * instead of interfaces. Dynamic members count (a PPP profile's list, say);
 * disabled ones don't. An interface in two zones keeps the first.
 */
export function interfaceZones(zones: string[], members: { list?: string; interface?: string; disabled?: string }[]): Record<string, string> {
  const out = new Map<string, string>();
  for (const z of zones) {
    for (const m of members) {
      if (m.list === z && m.interface && !yes(m.disabled) && !out.has(m.interface)) out.set(m.interface, z);
    }
  }
  return Object.fromEntries(out);
}

/** Interfaces with an address that no zone has: nothing reaches the router or another zone through them. */
export function unzoned(addresses: Ros[], members: Record<string, string[]>): string[] {
  const zoned = new Set(Object.values(members).flat());
  const withAddr = addresses.filter((a) => !yes(a.disabled) && !yes(a.invalid)).map((a) => a['actual-interface'] || a.interface).filter(Boolean);
  return [...new Set(withAddr)].filter((i) => !zoned.has(i)).sort();
}

// ─── Drift ───────────────────────────────────────────────────────────────────

export interface ZoneDrift { missing: string[]; extra: string[] }

/** What differs between the device and the last apply. Null when they match. */
export function zoneDrift(current: Ros[], desired: CompiledRule[]): ZoneDrift | null {
  const plan = planApply(current, desired);
  if (!plan.add.length && !plan.remove.length) return null;
  return {
    missing: plan.add.map((a) => a.description),
    extra: plan.remove.map(({ rule: r }) => r.comment || `${r.chain} ${r.action}${r['jump-target'] ? ` ${r['jump-target']}` : ''}`),
  };
}
