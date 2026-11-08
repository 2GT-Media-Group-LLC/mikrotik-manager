/**
 * Quick firewall rules (#330): a few presets for the rules nearly every
 * router needs, close to MikroTik's own default configuration (defconf).
 * Each preset is planned against the device's rules first: a rule already
 * there (same chain, action and matchers, enabled) is skipped, accepts and the
 * invalid drop go to the top of the table so they work whatever else is
 * there, and the catch-all drops go to the end so existing accepts keep
 * working. Pure, so every preset is tested without a device.
 */
import { isIP } from 'net';

export type QuickFamily = 'ip' | 'ipv6';
export type QuickPreset = 'input-basics' | 'management-access' | 'forward-basics' | 'masquerade' | 'brute-force';
export const QUICK_PRESETS: QuickPreset[] = ['input-basics', 'management-access', 'forward-basics', 'masquerade', 'brute-force'];

/** An interface list or a single interface, as a rule matches it. */
export interface IfaceRef { kind: 'list' | 'interface'; name: string }

export interface QuickOptions {
  wan?: IfaceRef;
  lan?: IfaceRef;
  /** Forward basics: FastTrack established connections. */
  fasttrack?: boolean;
  /** Management access: the address list, and who may manage the router. */
  list?: string;
  addresses?: string[];
  services?: string[];
  /** Brute-force protection (#405): how long a source stays banned. */
  banTime?: BanTime;
}

export type BanTime = '1h' | '1d' | '1w';
export const BAN_TIMES: BanTime[] = ['1h', '1d', '1w'];

type Ros = Record<string, string>;

export interface QuickStep {
  table: 'filter' | 'nat' | 'address-list';
  params: Ros;
  /** top: before the table's first rule; bottom: at the end. Address-list entries have none. */
  placement: 'top' | 'bottom' | null;
  description: string;
  /** Why it isn't added: a rule like it is already there. */
  skip: string | null;
}

export interface QuickContext {
  family: QuickFamily;
  filter: Ros[];
  nat: Ros[];
  addressLists: Ros[];
  interfaceLists: string[];
  interfaces: string[];
  /** /ip/service rows: name, port, disabled. */
  services: Ros[];
  /** The manager's address as the device sees it, when known. */
  managerIp: string | null;
  /** RouterOS major version; 6 has no hw-offload on FastTrack. */
  rosMajor?: number;
  /** The device takes hw-offload on a FastTrack rule (some RouterOS 7 builds don't, #369). */
  fasttrackHwOffload?: boolean;
  /** VPN servers that are enabled, and OpenVPN's port. */
  vpn?: { l2tp: boolean; pptp: boolean; ovpn: boolean; sstp: boolean; ovpnPort: string | null };
}

export interface QuickPlan {
  steps: QuickStep[];
  /** Field → message, for the form. */
  errors: Record<string, string>;
  notes: string[];
}

const COMMENT = (what: string) => `mtm quick: ${what}`;
const yes = (v: string | undefined) => v === 'true' || v === 'yes';

/** Management services the preset can restrict, by RouterOS service name. */
export const MGMT_SERVICES = ['winbox', 'ssh', 'api', 'api-ssl', 'www', 'www-ssl', 'telnet', 'ftp'];
export const DEFAULT_MGMT_SERVICES = ['winbox', 'ssh', 'api', 'api-ssl', 'www', 'www-ssl'];
export const DEFAULT_MGMT_LIST = 'mtm-management';

// ─── Matching ────────────────────────────────────────────────────────────────

/** The fields that decide what a rule matches and does. Comments, counters and logging don't count. */
const KEY_FIELDS = ['chain', 'action', 'connection-state', 'connection-nat-state', 'protocol', 'in-interface', 'in-interface-list',
  'out-interface', 'out-interface-list', 'src-address', 'src-address-list', 'dst-address', 'dst-address-list', 'dst-port',
  'ipsec-policy', 'jump-target', 'address-list'];
const SET_FIELDS = new Set(['connection-state', 'dst-port']);

function norm(field: string, v: string | undefined): string {
  const s = (v ?? '').trim().toLowerCase();
  return SET_FIELDS.has(field) ? s.split(',').map((x) => x.trim()).filter(Boolean).sort().join(',') : s;
}

/**
 * An enabled, configured rule that matches and does the same as `want`.
 * Invalid ones count: RouterOS flags a rule it has only just added as invalid
 * for a moment while it reloads the firewall, and skipping those would add
 * the same rules again on a quick second try.
 */
export function findEquivalent(rows: Ros[], want: Ros): Ros | undefined {
  return rows.find((r) => !yes(r.disabled) && !yes(r.dynamic)
    && KEY_FIELDS.every((f) => norm(f, r[f]) === norm(f, want[f])));
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** in-interface-list=X / in-interface=X (negated with !). */
function match(dir: 'in' | 'out', ref: IfaceRef, negate = false): Ros {
  const key = ref.kind === 'list' ? `${dir}-interface-list` : `${dir}-interface`;
  return { [key]: `${negate ? '!' : ''}${ref.name}` };
}

function refError(ref: IfaceRef | undefined, what: 'WAN' | 'LAN', ctx: QuickContext): string | null {
  if (!ref || !ref.name) return `Choose the ${what}: an interface list or an interface.`;
  if (ref.kind === 'list') return ctx.interfaceLists.includes(ref.name) ? null : `${ref.name} isn't an interface list on this device.`;
  if (ref.kind === 'interface') return ctx.interfaces.includes(ref.name) ? null : `${ref.name} isn't an interface on this device.`;
  return `Choose the ${what}.`;
}

const ADDRESS = (s: string) => {
  const [ip, len] = s.split('/');
  if (isIP(ip) !== 4) return false;
  return len === undefined || (/^\d{1,2}$/.test(len) && Number(len) <= 32);
};
const LIST_NAME = /^[A-Za-z0-9._-]{1,63}$/;

// ─── Presets ─────────────────────────────────────────────────────────────────

interface Draft { table: QuickStep['table']; params: Ros; placement: QuickStep['placement']; description: string }

function inputBasics(o: QuickOptions, v6: boolean): Draft[] {
  const lan = o.lan!;
  const rules: Draft[] = [
    { table: 'filter', placement: 'top', description: 'Accept established, related and untracked connections',
      params: { chain: 'input', action: 'accept', 'connection-state': 'established,related,untracked', comment: COMMENT('accept established, related, untracked') } },
    { table: 'filter', placement: 'top', description: 'Drop invalid packets',
      params: { chain: 'input', action: 'drop', 'connection-state': 'invalid', comment: COMMENT('drop invalid') } },
    { table: 'filter', placement: 'top', description: v6 ? 'Accept ICMPv6' : 'Accept ICMP (ping)',
      params: { chain: 'input', action: 'accept', protocol: v6 ? 'icmpv6' : 'icmp', comment: COMMENT(v6 ? 'accept ICMPv6' : 'accept ICMP') } },
  ];
  if (v6) {
    rules.push(
      { table: 'filter', placement: 'top', description: 'Accept traceroute (UDP 33434–33534)',
        params: { chain: 'input', action: 'accept', protocol: 'udp', 'dst-port': '33434-33534', comment: COMMENT('accept UDP traceroute') } },
      { table: 'filter', placement: 'top', description: 'Accept DHCPv6 prefix delegation replies',
        params: { chain: 'input', action: 'accept', protocol: 'udp', 'dst-port': '546', 'src-address': 'fe80::/10', comment: COMMENT('accept DHCPv6 prefix delegation') } },
    );
  } else {
    rules.push({ table: 'filter', placement: 'top', description: 'Accept to the local loopback (used by CAPsMAN)',
      params: { chain: 'input', action: 'accept', 'dst-address': '127.0.0.1', comment: COMMENT('accept to local loopback') } });
  }
  rules.push({ table: 'filter', placement: 'bottom', description: `Drop everything else not coming from ${lan.name}`,
    params: { chain: 'input', action: 'drop', ...match('in', lan, true), comment: COMMENT(`drop all not from ${lan.name}`) } });
  return rules;
}

function forwardBasics(o: QuickOptions, v6: boolean, rosMajor: number, hwOffload: boolean): Draft[] {
  const rules: Draft[] = [];
  if (!v6 && o.fasttrack) {
    // IPsec traffic is accepted first so it isn't FastTracked past its policy, as defconf does.
    rules.push(
      { table: 'filter', placement: 'top', description: 'Accept traffic that arrived through an IPsec policy',
        params: { chain: 'forward', action: 'accept', 'ipsec-policy': 'in,ipsec', comment: COMMENT('accept in IPsec policy') } },
      { table: 'filter', placement: 'top', description: 'Accept traffic leaving through an IPsec policy',
        params: { chain: 'forward', action: 'accept', 'ipsec-policy': 'out,ipsec', comment: COMMENT('accept out IPsec policy') } },
      { table: 'filter', placement: 'top', description: 'FastTrack established and related connections',
        params: { chain: 'forward', action: 'fasttrack-connection', 'connection-state': 'established,related',
          ...(rosMajor >= 7 && hwOffload ? { 'hw-offload': 'yes' } : {}), comment: COMMENT('fasttrack') } },
    );
  }
  rules.push(
    { table: 'filter', placement: 'top', description: 'Accept established, related and untracked connections',
      params: { chain: 'forward', action: 'accept', 'connection-state': 'established,related,untracked', comment: COMMENT('accept established, related, untracked') } },
    { table: 'filter', placement: 'top', description: 'Drop invalid packets',
      params: { chain: 'forward', action: 'drop', 'connection-state': 'invalid', comment: COMMENT('drop invalid') } },
  );
  if (v6) {
    rules.push(
      { table: 'filter', placement: 'top', description: 'Accept ICMPv6',
        params: { chain: 'forward', action: 'accept', protocol: 'icmpv6', comment: COMMENT('accept ICMPv6') } },
      { table: 'filter', placement: 'bottom', description: `Drop everything else not coming from ${o.lan!.name}`,
        params: { chain: 'forward', action: 'drop', ...match('in', o.lan!, true), comment: COMMENT(`drop all not from ${o.lan!.name}`) } },
    );
  } else {
    rules.push({ table: 'filter', placement: 'bottom', description: `Drop new connections from ${o.wan!.name} that aren't port forwards`,
      params: { chain: 'forward', action: 'drop', 'connection-state': 'new', 'connection-nat-state': '!dstnat', ...match('in', o.wan!),
        comment: COMMENT(`drop new from ${o.wan!.name} not port-forwarded`) } });
  }
  return rules;
}

function managementAccess(o: QuickOptions, ctx: QuickContext): Draft[] {
  const list = o.list || DEFAULT_MGMT_LIST;
  const wanted = (o.services && o.services.length ? o.services : DEFAULT_MGMT_SERVICES);
  const ports = [...new Set(ctx.services
    .filter((s) => wanted.includes(s.name) && !yes(s.disabled) && s.port)
    .map((s) => s.port))].sort((a, b) => Number(a) - Number(b));
  const addrs = [...new Set([...(ctx.managerIp ? [ctx.managerIp] : []), ...(o.addresses ?? [])])];
  const out: Draft[] = addrs.map((a) => ({
    table: 'address-list' as const, placement: null,
    description: a === ctx.managerIp ? `Add ${a} (MikroTik Manager) to ${list}` : `Add ${a} to ${list}`,
    params: { list, address: a, comment: COMMENT(a === ctx.managerIp ? 'MikroTik Manager' : 'management') },
  }));
  const portList = ports.join(',');
  out.push(
    { table: 'filter', placement: 'top', description: `Accept management (TCP ${portList}) from ${list}`,
      params: { chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': portList, 'src-address-list': list, comment: COMMENT(`accept management from ${list}`) } },
    { table: 'filter', placement: 'top', description: `Drop management (TCP ${portList}) from anywhere else`,
      params: { chain: 'input', action: 'drop', protocol: 'tcp', 'dst-port': portList, comment: COMMENT('drop management from elsewhere') } },
  );
  return out;
}

function masquerade(o: QuickOptions): Draft[] {
  return [{ table: 'nat', placement: 'bottom', description: `Masquerade traffic leaving through ${o.wan!.name}`,
    params: { chain: 'srcnat', action: 'masquerade', ...match('out', o.wan!), comment: COMMENT(`masquerade out ${o.wan!.name}`) } }];
}

// ─── Brute-force protection (#405) ──────────────────────────────────────────
//
// RouterOS's firewall can't see a failed login, so this is the usual RouterOS
// way: count new connections per source. Each one to a protected port moves
// the source through three one-minute stages; the fourth within those minutes
// puts it on the banned list, and everything from that list is dropped.

export const BF_CHAIN = 'mtm-bruteforce';
export const BANNED_LIST = 'mtm-banned';
export const BF_EXEMPT = 'mtm-bf-exempt';

/** What can be protected: a service by name (its configured port), or a VPN server's fixed ports. */
export const BF_TARGETS = ['ssh', 'winbox', 'ftp', 'telnet', 'l2tp', 'pptp', 'ovpn', 'sstp'] as const;
export type BfTarget = typeof BF_TARGETS[number];

/** Ports per target: tcp and udp. */
export function bfPorts(target: BfTarget, ctx: QuickContext): { tcp: string[]; udp: string[] } {
  const svc = (name: string) => ctx.services.find((s) => s.name === name && !yes(s.disabled) && s.port)?.port;
  switch (target) {
    case 'ssh': case 'winbox': case 'ftp': case 'telnet': { const p = svc(target); return { tcp: p ? [p] : [], udp: [] }; }
    case 'l2tp': return { tcp: [], udp: ['500', '4500', '1701'] };
    case 'pptp': return { tcp: ['1723'], udp: [] };
    case 'ovpn': { const p = ctx.vpn?.ovpnPort || '1194'; return { tcp: [p], udp: [p] }; }
    case 'sstp': return { tcp: ['443'], udp: [] };
  }
}

/** What's running, so the form starts with it ticked. */
export function bfDefaults(ctx: QuickContext): BfTarget[] {
  const on = (name: string) => ctx.services.some((s) => s.name === name && !yes(s.disabled));
  return BF_TARGETS.filter((t) => (t === 'ssh' || t === 'winbox' || t === 'ftp' || t === 'telnet') ? on(t)
    : t === 'sstp' ? false : !!ctx.vpn?.[t]);
}

function bruteForce(o: QuickOptions, ctx: QuickContext): Draft[] {
  const targets = (o.services && o.services.length ? o.services : bfDefaults(ctx)) as BfTarget[];
  const tcp = new Set<string>();
  const udp = new Set<string>();
  for (const t of targets) { const p = bfPorts(t, ctx); p.tcp.forEach((x) => tcp.add(x)); p.udp.forEach((x) => udp.add(x)); }
  const sort = (v: Set<string>) => [...v].sort((a, b) => Number(a) - Number(b)).join(',');
  const ban = o.banTime && BAN_TIMES.includes(o.banTime) ? o.banTime : '1d';
  const exempt = [...new Set([...(ctx.managerIp ? [ctx.managerIp] : []), ...(o.addresses ?? [])])];
  const out: Draft[] = exempt.map((a) => ({
    table: 'address-list' as const, placement: null,
    description: a === ctx.managerIp ? `Never ban ${a} (MikroTik Manager)` : `Never ban ${a}`,
    params: { list: BF_EXEMPT, address: a, comment: COMMENT(a === ctx.managerIp ? 'MikroTik Manager' : 'never ban') },
  }));
  out.push({ table: 'filter', placement: 'top', description: `Drop everything from ${BANNED_LIST}`,
    params: { chain: 'input', action: 'drop', 'src-address-list': BANNED_LIST, comment: COMMENT('drop banned') } });
  if (tcp.size) out.push({ table: 'filter', placement: 'top', description: `Count new connections to TCP ${sort(tcp)}`,
    params: { chain: 'input', action: 'jump', 'jump-target': BF_CHAIN, 'connection-state': 'new', protocol: 'tcp', 'dst-port': sort(tcp), comment: COMMENT('count new TCP logins') } });
  if (udp.size) out.push({ table: 'filter', placement: 'top', description: `Count new connections to UDP ${sort(udp)}`,
    params: { chain: 'input', action: 'jump', 'jump-target': BF_CHAIN, 'connection-state': 'new', protocol: 'udp', 'dst-port': sort(udp), comment: COMMENT('count new UDP logins') } });
  const stage = (from: string | null, to: string, timeout: string, what: string): Draft => ({
    table: 'filter', placement: 'bottom', description: what,
    params: { chain: BF_CHAIN, action: 'add-src-to-address-list', ...(from ? { 'src-address-list': from } : {}),
      'address-list': to, 'address-list-timeout': timeout, comment: COMMENT(what.toLowerCase()) },
  });
  out.push(
    { table: 'filter', placement: 'bottom', description: `Never count addresses in ${BF_EXEMPT}`,
      params: { chain: BF_CHAIN, action: 'return', 'src-address-list': BF_EXEMPT, comment: COMMENT('skip exempt') } },
    stage('mtm-bf-3', BANNED_LIST, ban, `Fourth new connection: ban for ${ban}`),
    stage('mtm-bf-2', 'mtm-bf-3', '1m', 'Third new connection within a minute'),
    stage('mtm-bf-1', 'mtm-bf-2', '1m', 'Second new connection within a minute'),
    stage(null, 'mtm-bf-1', '1m', 'First new connection'),
  );
  return out;
}

/** What a preset needs, so the form shows only those fields. */
export function presetNeeds(preset: QuickPreset, family: QuickFamily): { wan: boolean; lan: boolean } {
  if (preset === 'input-basics') return { wan: false, lan: true };
  if (preset === 'forward-basics') return family === 'ipv6' ? { wan: false, lan: true } : { wan: true, lan: false };
  if (preset === 'masquerade') return { wan: true, lan: false };
  return { wan: false, lan: false };
}

export function planPreset(preset: QuickPreset, o: QuickOptions, ctx: QuickContext): QuickPlan {
  const errors: Record<string, string> = {};
  const notes: string[] = [];
  const v6 = ctx.family === 'ipv6';
  if (!QUICK_PRESETS.includes(preset)) return { steps: [], errors: { preset: 'Choose a preset.' }, notes };
  if (v6 && (preset === 'management-access' || preset === 'masquerade' || preset === 'brute-force')) {
    return { steps: [], errors: { preset: preset === 'masquerade' ? 'Masquerade is for IPv4.' : 'This preset is for IPv4 for now.' }, notes };
  }
  const needs = presetNeeds(preset, ctx.family);
  if (needs.wan) { const e = refError(o.wan, 'WAN', ctx); if (e) errors.wan = e; }
  if (needs.lan) { const e = refError(o.lan, 'LAN', ctx); if (e) errors.lan = e; }

  if (preset === 'management-access') {
    const list = o.list || DEFAULT_MGMT_LIST;
    if (!LIST_NAME.test(list)) errors.list = 'Use letters, digits, dots, dashes and underscores for the list name.';
    const bad = (o.addresses ?? []).filter((a) => !ADDRESS(a));
    if (bad.length) errors.addresses = `Not an IPv4 address or prefix: ${bad.join(', ')}.`;
    const unknown = (o.services ?? []).filter((s) => !MGMT_SERVICES.includes(s));
    if (unknown.length) errors.services = `Not a management service: ${unknown.join(', ')}.`;
    const wanted = o.services && o.services.length ? o.services : DEFAULT_MGMT_SERVICES;
    const enabled = ctx.services.filter((s) => wanted.includes(s.name) && !yes(s.disabled) && s.port);
    if (!enabled.length && !errors.services) errors.services = 'None of the chosen services is enabled on this device.';
    if (!ctx.managerIp && !(o.addresses ?? []).length && !errors.addresses) {
      errors.addresses = 'The manager couldn\'t see its own address on this device. Add the addresses that manage it, including the manager\'s.';
    }
    if (!ctx.managerIp) notes.push('The manager couldn\'t see its own address as this device sees it, so it isn\'t added for you. Make sure it\'s in the list.');
  }
  if (preset === 'brute-force') {
    const bad = (o.addresses ?? []).filter((a) => !ADDRESS(a));
    if (bad.length) errors.addresses = `Not an IPv4 address or prefix: ${bad.join(', ')}.`;
    const unknown = (o.services ?? []).filter((s) => !(BF_TARGETS as readonly string[]).includes(s));
    if (unknown.length) errors.services = `Can't protect: ${unknown.join(', ')}.`;
    const targets = (o.services && o.services.length ? o.services : bfDefaults(ctx)) as BfTarget[];
    if (!errors.services && !targets.some((t) => { const p = bfPorts(t, ctx); return p.tcp.length + p.udp.length > 0; })) {
      errors.services = 'Choose at least one service that is enabled on this device.';
    }
    if (o.banTime && !BAN_TIMES.includes(o.banTime)) errors.banTime = 'Choose 1h, 1d or 1w.';
    // A ban drops everything from the address, the API included, and the
    // manager opens SSH sessions too: never plan this without exempting it.
    if (!ctx.managerIp && !(o.addresses ?? []).length && !errors.addresses) {
      errors.addresses = 'The manager couldn\'t see its own address on this device. Add it under Never ban, so the manager is never banned.';
    }
    if (!ctx.managerIp) notes.push('The manager couldn\'t see its own address as this device sees it, so it isn\'t exempted for you. Make sure it\'s under Never ban.');
    if (targets.includes('sstp')) notes.push('SSTP shares TCP 443 with WebFig HTTPS and the reverse proxy, so busy web clients could be counted too.');
    notes.push('RouterOS can\'t see failed logins, so this counts new connections: four from one address within a few minutes bans it. Banned addresses show on the Firewall tab, where you can unban them.');
  }
  if (Object.keys(errors).length) return { steps: [], errors, notes };

  const drafts = preset === 'input-basics' ? inputBasics(o, v6)
    : preset === 'forward-basics' ? forwardBasics(o, v6, ctx.rosMajor ?? 7, ctx.fasttrackHwOffload === true)
      : preset === 'management-access' ? managementAccess(o, ctx)
        : preset === 'brute-force' ? bruteForce(o, ctx)
          : masquerade(o);

  const steps: QuickStep[] = drafts.map((d) => {
    let skip: string | null = null;
    if (d.table === 'address-list') {
      const have = ctx.addressLists.find((e) => e.list === d.params.list && (e.address ?? '').split('/')[0] === d.params.address.split('/')[0] && !yes(e.disabled));
      if (have) skip = `${d.params.address} is already in ${d.params.list}`;
    } else {
      const have = findEquivalent(d.table === 'nat' ? ctx.nat : ctx.filter, d.params);
      if (have) skip = `Already there${have.comment ? ` ("${have.comment}")` : ''}`;
    }
    return { ...d, skip };
  });
  // The ban rule is matched without its time, so a different choice would
  // silently change nothing: say what's there.
  if (preset === 'brute-force') {
    const ban = steps.find((st) => st.params['address-list'] === BANNED_LIST && st.skip);
    const have = ban && findEquivalent(ctx.filter, ban.params);
    if (have && have['address-list-timeout'] && have['address-list-timeout'] !== ban.params['address-list-timeout']) {
      notes.push(`The ban rule already there bans for ${have['address-list-timeout']}. To change that, edit its timeout on the Firewall tab.`);
    }
  }
  if (preset === 'forward-basics' && !v6 && o.fasttrack) {
    notes.push('FastTrack speeds up routing, but FastTracked traffic skips queues and some firewall and IPsec processing.');
  }
  if (preset === 'masquerade') notes.push('Masquerade is for a WAN address that changes (PPPoE, DHCP). With a fixed public address, src-nat to it is a little lighter.');
  return { steps, errors, notes };
}

/** The `place-before` for a rule going to the top: the table's first configured rule, if any. */
export function topAnchor(rows: Ros[]): string | null {
  const first = rows.find((r) => !yes(r.dynamic) && r['.id']);
  return first ? first['.id'] : null;
}
