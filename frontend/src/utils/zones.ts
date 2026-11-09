/**
 * Zone-based firewall (#369): the editor's draft, its checks and summaries.
 * The server checks the same things; these keep the form honest as you type.
 */
import type { ZoneRequest, ZonePolicy, ZonesData, ZoneCustomService } from '../services/api';

export const ROUTER = '@router';
export const pairKey = (from: string, to: string) => `${from}>${to}`;

const BUILTIN = ['all', 'none', 'dynamic', 'static'];
const ZONE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;

export function portsError(ports: string): string | null {
  const p = ports.replace(/\s+/g, '');
  if (!p) return 'Enter a port.';
  if (!PORTS.test(p)) return 'Numbers and ranges, such as 8080 or 5000-5010,6000.';
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

/** An IPv4 address, subnet or range, as the server checks it. */
export function addressError(value: string): string | null {
  const v = value.trim();
  const range = v.split('-');
  if (range.length === 2) {
    const [a, b] = range.map((x) => OCTETS(x.trim()));
    if (!a || !b) return 'Two addresses for a range, such as 10.0.0.10-10.0.0.20.';
    return ipNum(a) <= ipNum(b) ? null : 'That range runs backwards.';
  }
  const [addr, prefix, extra] = v.split('/');
  if (extra !== undefined || !OCTETS(addr)) return 'An IPv4 address, a subnet such as 10.0.0.0/24, or a range.';
  if (prefix !== undefined && !(/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32)) return 'A prefix length is 0 to 32.';
  return null;
}

/**
 * A custom rule's problem, if any. Ports are needed only without an address;
 * with "any" protocol there are none.
 */
export function customError(c: ZoneCustomService): string | null {
  const ports = c.ports.replace(/\s+/g, '');
  const src = (c.src ?? '').trim();
  const dst = (c.dst ?? '').trim();
  if (c.protocol === 'any' && ports) return 'Ports need TCP or UDP.';
  if (!ports && !src && !dst) return c.protocol === 'any' ? 'Enter a source or destination address.' : 'Enter a port, or an address.';
  return (ports ? portsError(ports) : null) ?? (src ? addressError(src) : null) ?? (dst ? addressError(dst) : null);
}

/** A custom rule in a few words. */
export function customLabel(c: ZoneCustomService): string {
  return [c.protocol.toUpperCase(), c.ports, c.src ? `from ${c.src}` : '', c.dst ? `to ${c.dst}` : ''].filter(Boolean).join(' ');
}

export function zoneNameError(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (!n) return 'Name the zone.';
  if (!ZONE_NAME.test(n)) return 'Letters, digits, spaces, _ . and -, up to 40.';
  if (BUILTIN.includes(n.toLowerCase())) return `${n} is one of RouterOS's own lists.`;
  if (n.toLowerCase() === 'router') return '"router" is kept for traffic to the router itself.';
  if (existing.some((z) => z.toLowerCase() === n.toLowerCase())) return `${n} is already a zone.`;
  return null;
}

/** The form's errors, keyed like the server's: `pair:<key>`, `members`, `zones`. */
export function draftErrors(d: ZoneRequest): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.config.zones.length) errors.zones = 'Add at least one zone.';
  const owner = new Map<string, string>();
  for (const z of d.config.zones) {
    for (const i of d.members[z] ?? []) {
      if (owner.has(i)) errors.members = `${i} is in both ${owner.get(i)} and ${z}. An interface can be in one zone.`;
      owner.set(i, z);
    }
  }
  for (const [key, p] of Object.entries(d.config.policies)) {
    if (p.action !== 'services') continue;
    const bad = p.custom.map(customError).find(Boolean);
    if (bad) errors[`pair:${key}`] = bad;
    else if (!p.services.length && !p.custom.length) errors[`pair:${key}`] = 'Pick at least one service, or deny it.';
  }
  return errors;
}

/** One cell of the matrix, in a few words. */
export function policySummary(p: ZonePolicy | undefined, labels: Record<string, string>): string {
  if (!p || p.action === 'deny') return 'Deny';
  if (p.action === 'allow') return 'Allow all';
  const names = [...p.services.map((s) => labels[s] ?? s), ...p.custom.map(customLabel)];
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

/**
 * Where the editor starts. With zones on, the saved setup and the lists'
 * interfaces as they are now. Otherwise the device's own lists, and, when it
 * has MikroTik's LAN and WAN, the same rules as the defaults: LAN reaches
 * everything, WAN only gets ping to the router.
 */
export function initialDraft(data: ZonesData): ZoneRequest {
  const staticMembers = (name: string) => data.lists.find((l) => l.name === name)?.members.filter((m) => !m.dynamic).map((m) => m.interface) ?? [];
  if (data.config) {
    return { config: data.config, members: Object.fromEntries(data.config.zones.map((z) => [z, staticMembers(z)])) };
  }
  const zones = data.lists.map((l) => l.name);
  const policies: Record<string, ZonePolicy> = {};
  if (zones.includes('LAN') && zones.includes('WAN')) {
    policies[pairKey('LAN', 'WAN')] = { action: 'allow', services: [], custom: [] };
    policies[pairKey('LAN', ROUTER)] = { action: 'allow', services: [], custom: [] };
    policies[pairKey('WAN', ROUTER)] = { action: 'services', services: ['ping'], custom: [] };
  }
  return {
    config: { zones, intra: Object.fromEntries(zones.map((z) => [z, true])), policies, fasttrack: true, logDrops: true },
    members: Object.fromEntries(zones.map((z) => [z, staticMembers(z)])),
  };
}

export function addZone(d: ZoneRequest, name: string, members: string[]): ZoneRequest {
  const n = name.trim();
  return {
    config: { ...d.config, zones: [...d.config.zones, n], intra: { ...d.config.intra, [n]: true } },
    members: { ...d.members, [n]: members.filter((i) => !Object.values(d.members).flat().includes(i)) },
  };
}

export function removeZone(d: ZoneRequest, name: string): ZoneRequest {
  const policies = Object.fromEntries(Object.entries(d.config.policies).filter(([k]) => {
    const [from, to] = k.split('>');
    return from !== name && to !== name;
  }));
  const intra = { ...d.config.intra };
  delete intra[name];
  const members = { ...d.members };
  delete members[name];
  return { config: { ...d.config, zones: d.config.zones.filter((z) => z !== name), intra, policies }, members };
}

export function setPolicy(d: ZoneRequest, key: string, p: ZonePolicy): ZoneRequest {
  const policies = { ...d.config.policies };
  if (p.action === 'deny') delete policies[key]; else policies[key] = p;
  return { ...d, config: { ...d.config, policies } };
}
