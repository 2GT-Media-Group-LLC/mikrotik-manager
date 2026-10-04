/**
 * Which WireGuard interface and peer carry the manager's own connection to a
 * device (#205), so the changes that would cut it can be refused rather than
 * merely warned about.
 *
 * A device is managed through WireGuard when either:
 *   - the address the manager connects to is on a WireGuard interface (the
 *     device's address is in the tunnel's subnet), or
 *   - the device's route back to the manager leaves through one.
 *
 * Within that interface the peer that matters is the one whose allowed
 * addresses cover the manager's address as the device sees it. WireGuard
 * routes by those addresses, so that peer is the manager's path. Where the
 * manager's address can't be seen (no connection tracking), every enabled peer
 * on the interface is treated as possibly carrying it.
 */
import net from 'net';
import { DeviceCollector, type DeviceRow } from '../mikrotik/DeviceCollector';
import { managerIpFromConntrack, type DeviceSnapshot, type RosRow } from './pathModel';

export interface TunnelState {
  addresses: RosRow[];
  routes: RosRow[];
  wgInterfaces: RosRow[];
  peers: RosRow[];
  /** The address the manager connects to. */
  deviceIp: string;
  /** The manager's address as the device sees it; null when it can't be seen. */
  managerIp: string | null;
}

export interface ManagementTunnel {
  /** The WireGuard interface carrying management, or null when none does. */
  interface: string | null;
  interfaceId: string | null;
  via: 'address' | 'route' | null;
  /** Peers that carry (or, when uncertain, may carry) the manager's traffic. */
  peerIds: string[];
  /** True when the peers were picked by the manager's own address. */
  peerCertain: boolean;
  /** Every enabled peer on the interface, carrying the manager or not. */
  interfacePeerIds: string[];
  managerIp: string | null;
  /** One sentence for the UI and refusals. */
  reason: string;
}

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';
const stripCidr = (a: string | undefined): string => (a || '').split('/')[0].trim();
const csv = (v: string | undefined): string[] => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Does an address or prefix (10.6.0.0/24, 10.6.0.2, fd00::/64) contain this IP? */
export function prefixContains(prefix: string, ip: string): boolean {
  const family = net.isIP(ip);
  if (!family) return false;
  const [base, lenRaw] = prefix.trim().split('/');
  if (net.isIP(base) !== family) return false;
  const max = family === 4 ? 32 : 128;
  const len = lenRaw === undefined ? max : Number(lenRaw);
  if (!Number.isInteger(len) || len < 0 || len > max) return false;
  const list = new net.BlockList();
  list.addSubnet(base, len, family === 4 ? 'ipv4' : 'ipv6');
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Do any of these allowed addresses cover the IP? */
export function allowedCovers(allowed: string | undefined, ip: string): boolean {
  return csv(allowed).some((p) => prefixContains(p, ip));
}

/** The interface a route sends traffic out of: "10.6.0.1%wg0" or "wg0". */
function routeInterface(route: RosRow, interfaceNames: Set<string>, addresses: RosRow[]): string | null {
  for (const field of ['immediate-gw', 'gateway']) {
    const v = (route[field] || '').trim();
    if (!v) continue;
    const pct = v.lastIndexOf('%');
    if (pct >= 0) return v.slice(pct + 1);
    if (interfaceNames.has(v)) return v;
    // A bare gateway IP: the interface whose address subnet holds it.
    if (net.isIP(v)) {
      const hit = addresses.find((a) => !isTrue(a['disabled']) && a['address'] && prefixContains(a['address'], v)
        && prefixLength(a['address']) < (net.isIP(v) === 4 ? 32 : 128));
      if (hit) return hit['actual-interface'] || hit['interface'] || null;
    }
  }
  return null;
}

function prefixLength(prefix: string): number {
  const len = prefix.split('/')[1];
  return len === undefined ? (net.isIP(stripCidr(prefix)) === 6 ? 128 : 32) : Number(len);
}

/** The active route with the longest prefix covering the IP. */
function bestRoute(routes: RosRow[], ip: string): RosRow | null {
  let best: RosRow | null = null;
  let bestLen = -1;
  for (const r of routes) {
    if (isTrue(r['disabled']) || r['active'] === 'false' || isTrue(r['inactive'])) continue;
    const dst = r['dst-address'];
    if (!dst || !prefixContains(dst, ip)) continue;
    const len = prefixLength(dst);
    if (len > bestLen) { best = r; bestLen = len; }
  }
  return best;
}

export function managementTunnel(s: TunnelState): ManagementTunnel {
  const none = (reason: string): ManagementTunnel => ({
    interface: null, interfaceId: null, via: null, peerIds: [], peerCertain: false, interfacePeerIds: [], managerIp: s.managerIp, reason,
  });
  if (s.wgInterfaces.length === 0) return none('No WireGuard interfaces.');
  const wgNames = new Set(s.wgInterfaces.map((i) => i['name']).filter(Boolean));

  let name: string | null = null;
  let via: ManagementTunnel['via'] = null;
  const addr = s.addresses.find((a) => !isTrue(a['disabled']) && stripCidr(a['address']) === s.deviceIp);
  const addrIface = addr ? (addr['actual-interface'] || addr['interface'] || '') : '';
  if (addrIface && wgNames.has(addrIface)) {
    name = addrIface;
    via = 'address';
  } else if (s.managerIp) {
    const route = bestRoute(s.routes, s.managerIp);
    const out = route ? routeInterface(route, wgNames, s.addresses) : null;
    if (out && wgNames.has(out)) { name = out; via = 'route'; }
  }
  if (!name) return none('The manager doesn’t reach this device through WireGuard.');

  const iface = s.wgInterfaces.find((i) => i['name'] === name);
  const onIface = s.peers.filter((p) => p['interface'] === name && !isTrue(p['disabled']));
  const certain = !!s.managerIp;
  const peers = certain ? onIface.filter((p) => allowedCovers(p['allowed-address'], s.managerIp!)) : onIface;
  const how = via === 'address'
    ? `the address the manager connects to (${s.deviceIp}) is on ${name}`
    : `the device's route back to the manager (${s.managerIp}) goes out through ${name}`;
  return {
    interface: name,
    interfaceId: iface?.['.id'] ?? null,
    via,
    peerIds: peers.map((p) => p['.id']).filter(Boolean),
    peerCertain: certain,
    interfacePeerIds: onIface.map((p) => p['.id']).filter(Boolean),
    managerIp: s.managerIp,
    reason: `The manager reaches this device through WireGuard: ${how}.`,
  };
}

const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 'yes';
const ELSEWHERE = 'Make this change on the device itself, or move management off this tunnel first.';

export type TunnelVerdict = { refuse: string } | { protect: true } | null;

/**
 * What a peer change does to the management tunnel: refused when it would take
 * the manager's traffic away, guarded (auto-revert) when it touches the tunnel
 * otherwise, nothing when it doesn't touch it. `peerId` is null for a new peer.
 */
export function peerRule(
  t: ManagementTunnel, peerId: string | null, body: Record<string, unknown> | undefined, action: 'add' | 'set' | 'remove',
): TunnelVerdict {
  if (!t.interface) return null;
  const ip = t.managerIp;
  const carries = peerId !== null && t.peerIds.includes(peerId);
  const covers = (v: unknown) => !!ip && v !== undefined && allowedCovers(String(v), ip);

  if (action === 'remove') {
    if (!carries) return null;
    return t.peerCertain
      ? { refuse: `This peer carries the manager's connection (its allowed addresses include ${ip}); deleting it would cut the manager off. ${ELSEWHERE}` }
      : { protect: true };
  }

  if (!carries) {
    // A peer that doesn't carry the manager, new or existing, ending up on the
    // tunnel. WireGuard routes by allowed address, so one claiming the
    // manager's address takes its traffic away from the peer carrying it now.
    const onTunnelNow = peerId !== null && t.interfacePeerIds.includes(peerId);
    const target = body?.interface !== undefined ? String(body.interface) : (onTunnelNow ? t.interface : null);
    if (target !== t.interface) return null;
    if (covers(body?.['allowed-address'])) {
      return { refuse: `A peer whose allowed addresses include ${ip} would take the manager's traffic away from the peer that carries it now. ${ELSEWHERE}` };
    }
    return { protect: true };
  }

  if (t.peerCertain) {
    if (truthy(body?.disabled)) {
      return { refuse: `This peer carries the manager's connection; turning it off would cut the manager off. ${ELSEWHERE}` };
    }
    if (body?.['allowed-address'] !== undefined && !covers(body['allowed-address'])) {
      return { refuse: `This peer carries the manager's connection; without ${ip} in its allowed addresses the manager's traffic would no longer reach it. ${ELSEWHERE}` };
    }
    if (body?.interface !== undefined && String(body.interface) !== t.interface) {
      return { refuse: `This peer carries the manager's connection; moving it to another interface would cut the manager off. ${ELSEWHERE}` };
    }
  }
  return { protect: true };
}

/**
 * Read what managementTunnel needs from the device. Null when the device can't
 * be read, so callers fall back to the ordinary Change Guard checks.
 */
export async function readManagementTunnel(device: DeviceRow): Promise<ManagementTunnel | null> {
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    const run = c.commandRunner();
    const [addresses, routes, wgInterfaces, peers, conns] = await Promise.all([
      run.execute('/ip/address/print', { detail: '' }),
      run.execute('/ip/route/print', { detail: '' }).catch(() => [] as RosRow[]),
      c.getWireGuardInterfaces(),
      c.getWireGuardPeers(),
      run.execute('/ip/firewall/connection/print', { detail: '' }).catch(() => [] as RosRow[]),
    ]);
    const snap = { mgmtConnections: conns, managerLocalPort: c.apiLocalPort() ?? null } as unknown as DeviceSnapshot;
    return managementTunnel({
      addresses, routes, wgInterfaces, peers,
      deviceIp: device.ip_address,
      managerIp: managerIpFromConntrack(snap, device.api_port),
    });
  } catch {
    return null;
  } finally {
    c.disconnect();
  }
}
