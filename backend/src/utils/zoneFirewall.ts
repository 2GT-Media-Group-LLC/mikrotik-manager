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
export interface CustomService { protocol: 'tcp' | 'udp'; ports: string }
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
        const protocol = r.protocol === 'udp' ? 'udp' : 'tcp';
        const ports = String(r.ports ?? '').replace(/\s+/g, '');
        if (!ports) continue;
        const e = portsError(ports);
        if (e) { errors[`pair:${key}`] = e; continue; }
        custom.push({ protocol, ports });
      }
      if (custom.length > 10) errors[`pair:${key}`] = 'Up to 10 custom ports per pair.';
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

  const config: ZoneConfig = { zones, intra, policies, fasttrack: c.fasttrack !== false, logDrops: c.logDrops !== false };
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
    out.push({
      params: { chain, action: 'accept', protocol: cs.protocol, 'dst-port': cs.ports, comment: COMMENT(`${label}: ${cs.protocol} ${cs.ports}`) },
      hidden: false, description: `${label}: ${cs.protocol.toUpperCase()} ${cs.ports}`,
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
  if (ctx.managerIp) add({ chain: 'input', action: 'accept', 'src-address': ctx.managerIp }, 'accept the manager');
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
const SIGNATURE_FIELDS = ['chain', 'action', 'connection-state', 'protocol', 'dst-port', 'src-address', 'dst-address',
  'in-interface-list', 'out-interface-list', 'jump-target', 'comment', 'log-prefix'];
const FLAG_FIELDS = ['log', 'disabled', 'hw-offload'];

/** A rule's identity for the diff: the same signature means the rule is already right. */
export function signature(r: Ros): string {
  const parts = SIGNATURE_FIELDS.map((f) => {
    let v = (r[f] ?? '').trim();
    if (f === 'log-prefix') v = withoutTag(v);
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
