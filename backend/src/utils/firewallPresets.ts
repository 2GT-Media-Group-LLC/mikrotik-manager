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
export type QuickPreset = 'input-basics' | 'management-access' | 'forward-basics' | 'masquerade';
export const QUICK_PRESETS: QuickPreset[] = ['input-basics', 'management-access', 'forward-basics', 'masquerade'];

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
}

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
  'ipsec-policy', 'jump-target'];
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

function forwardBasics(o: QuickOptions, v6: boolean, rosMajor: number): Draft[] {
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
          ...(rosMajor >= 7 ? { 'hw-offload': 'yes' } : {}), comment: COMMENT('fasttrack') } },
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
  if (v6 && (preset === 'management-access' || preset === 'masquerade')) {
    return { steps: [], errors: { preset: preset === 'masquerade' ? 'Masquerade is for IPv4.' : 'Management access is for IPv4 for now.' }, notes };
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
  if (Object.keys(errors).length) return { steps: [], errors, notes };

  const drafts = preset === 'input-basics' ? inputBasics(o, v6)
    : preset === 'forward-basics' ? forwardBasics(o, v6, ctx.rosMajor ?? 7)
      : preset === 'management-access' ? managementAccess(o, ctx)
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
