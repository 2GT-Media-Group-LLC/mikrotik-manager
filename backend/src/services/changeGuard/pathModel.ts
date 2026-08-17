/**
 * Management-path model — what the manager's reachability to a device actually
 * depends on.
 *
 * RouterOS performs no cross-object validation: it will happily accept a VLAN,
 * bridge or address change that strands its own CPU port, and MikroTik's official
 * advice for the most common case is "configure VLAN filtering while using a serial
 * console". This module derives, from live device state, the chain of objects the
 * management session rides on, so a change can be checked against it beforehand.
 *
 * Two things make the result precise rather than merely conservative:
 *
 *  - The manager's source IP *as the device sees it* is read from the device's own
 *    connection tracking (the live API session shows up there), instead of being
 *    treated as unknowable behind NAT.
 *  - The ingress port is taken from the bridge host (FDB) table — the port where
 *    the relevant MAC is actually learned — rather than guessed from topology.
 *
 * Capture and resolution are deliberately separate so resolution stays a pure
 * function over a snapshot and can be unit-tested against fixtures.
 */
import { RouterOSClient } from '../mikrotik/RouterOSClient';
import { decrypt } from '../../utils/crypto';
import type { GuardDevice } from './ChangeGuard';

export type RosRow = Record<string, string>;

export interface DeviceSnapshot {
  addresses: RosRow[];
  interfaces: RosRow[];
  vlanInterfaces: RosRow[];
  bridges: RosRow[];
  bridgePorts: RosRow[];
  bridgeVlans: RosRow[];
  routes: RosRow[];
  arp: RosRow[];
  bridgeHosts: RosRow[];
  services: RosRow[];
  firewallFilter: RosRow[];
  /** TCP connections to the management port; reveals the manager's apparent IP. */
  mgmtConnections: RosRow[];
}

export type HopKind = 'address' | 'vlan-interface' | 'bridge' | 'bond' | 'port';

export interface PathHop {
  kind: HopKind;
  name: string;
  /** Why this object is on the management path — surfaced verbatim in the UI. */
  reason: string;
}

export interface ManagementPath {
  mgmtIp: string;
  /** Interface that owns the management address. */
  mgmtInterface: string | null;
  /** Bridge in the path, if the management interface is (or sits on) one. */
  bridge: string | null;
  bridgeVlanFiltering: boolean;
  /** VLAN the management traffic rides in, when VLAN-aware. */
  mgmtVlanId: number | null;
  /** True when management arrives tagged (an /interface/vlan), false when untagged. */
  taggedManagement: boolean;
  /** Port the manager's traffic actually enters on. */
  ingressPort: string | null;
  /**
   * How the ingress port was determined:
   *  fdb            — the manager's own next-hop MAC, observed in the forwarding table
   *  fdb-default-gw — the default gateway's MAC in the forwarding table (used when the
   *                   manager's address isn't observable; correct whenever it is off-subnet)
   *  inferred       — from ARP alone, not confirmed by the forwarding table
   *  unknown        — could not be determined; callers must fall back to conservative checks
   */
  ingressPortSource: 'fdb' | 'fdb-default-gw' | 'inferred' | 'unknown';
  /** Manager's source address as the device sees it (may be a NAT gateway). */
  managerIp: string | null;
  /** Bond backing the ingress port, if any. */
  ingressBond: string | null;
  hops: PathHop[];
  /** Things we could not determine; callers should degrade to conservative checks. */
  warnings: string[];
}

const empty = (): RosRow[] => [];

/** Read everything the analysis needs in one pass. All over the API — no SSH. */
export async function captureSnapshot(device: GuardDevice): Promise<DeviceSnapshot> {
  const client = new RouterOSClient(
    device.ip_address,
    device.api_port,
    device.api_username,
    decrypt(device.api_password_encrypted),
    15_000,
    30_000
  );
  try {
    await client.connect();
    const run = (cmd: string, params: Record<string, string> = {}) =>
      client.execute(cmd, params).catch(empty);

    const [
      addresses, interfaces, vlanInterfaces, bridges, bridgePorts,
      bridgeVlans, routes, arp, bridgeHosts, services, firewallFilter, mgmtConnections,
    ] = await Promise.all([
      run('/ip/address/print', { detail: '' }),
      run('/interface/print', { detail: '' }),
      run('/interface/vlan/print', { detail: '' }),
      run('/interface/bridge/print', { detail: '' }),
      run('/interface/bridge/port/print', { detail: '' }),
      run('/interface/bridge/vlan/print', { detail: '' }),
      run('/ip/route/print', { detail: '' }),
      run('/ip/arp/print'),
      run('/interface/bridge/host/print'),
      run('/ip/service/print'),
      run('/ip/firewall/filter/print', { detail: '' }),
      // Connection tracking may be disabled; treated as optional.
      run('/ip/firewall/connection/print', { detail: '' }),
    ]);

    return {
      addresses, interfaces, vlanInterfaces, bridges, bridgePorts,
      bridgeVlans, routes, arp, bridgeHosts, services, firewallFilter, mgmtConnections,
    };
  } finally {
    client.disconnect();
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const stripCidr = (addr: string): string => (addr || '').split('/')[0].trim();
const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';
const csv = (v: string | undefined): string[] =>
  (v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** RouterOS vlan-ids may be a list and/or ranges: "10", "10,20", "10-12". */
export function expandVlanIds(spec: string | undefined): number[] {
  const out: number[] = [];
  for (const part of csv(spec)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      if (!isNaN(from) && !isNaN(to) && to >= from) {
        for (let v = from; v <= to; v++) out.push(v);
      }
      continue;
    }
    const n = parseInt(part, 10);
    if (!isNaN(n)) out.push(n);
  }
  return out;
}

/**
 * Effective membership for a VLAN on a bridge. RouterOS exposes `current-tagged`
 * / `current-untagged`, which include dynamically-added ports (notably the PVID-
 * derived untagged entries); those reflect what the switch is really enforcing, so
 * they win over the statically configured lists when present.
 */
export function vlanMembership(
  snap: DeviceSnapshot,
  bridge: string,
  vlanId: number
): {
  tagged: string[];
  untagged: string[];
  found: boolean;
  /** Membership contributed by operator-configured (static) rows only. */
  untaggedStatic: string[];
  taggedStatic: string[];
} {
  const tagged = new Set<string>();
  const untagged = new Set<string>();
  const taggedStatic = new Set<string>();
  const untaggedStatic = new Set<string>();
  let found = false;

  for (const row of snap.bridgeVlans) {
    if (row['bridge'] !== bridge) continue;
    if (!expandVlanIds(row['vlan-ids']).includes(vlanId)) continue;
    found = true;
    const t = row['current-tagged'] !== undefined ? row['current-tagged'] : row['tagged'];
    const u = row['current-untagged'] !== undefined ? row['current-untagged'] : row['untagged'];
    const isDynamic = isTrue(row['dynamic']);
    for (const p of csv(t)) { tagged.add(p); if (!isDynamic) taggedStatic.add(p); }
    for (const p of csv(u)) { untagged.add(p); if (!isDynamic) untaggedStatic.add(p); }
  }
  return {
    tagged: [...tagged],
    untagged: [...untagged],
    found,
    taggedStatic: [...taggedStatic],
    untaggedStatic: [...untaggedStatic],
  };
}

/** Longest-prefix-ish match: the active route the device would use for `ip`. */
function routeFor(snap: DeviceSnapshot, ip: string): RosRow | null {
  let best: RosRow | null = null;
  let bestLen = -1;
  for (const r of snap.routes) {
    if (isTrue(r['disabled']) || r['active'] === 'false') continue;
    const dst = r['dst-address'] || '';
    const [net, lenStr] = dst.split('/');
    const len = parseInt(lenStr ?? '32', 10);
    if (isNaN(len)) continue;
    if (len === 0 || inNetwork(ip, net, len)) {
      if (len > bestLen) { best = r; bestLen = len; }
    }
  }
  return best;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inNetwork(ip: string, net: string, prefixLen: number): boolean {
  const a = ipToInt(ip);
  const b = ipToInt(net);
  if (a === null || b === null) return false;
  if (prefixLen <= 0) return true;
  const mask = prefixLen >= 32 ? 0xffffffff : ((0xffffffff << (32 - prefixLen)) >>> 0);
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/**
 * The manager's address as the device sees it, taken from connection tracking on
 * the management port. Returns null when conntrack is unavailable.
 */
export function managerIpFromConntrack(snap: DeviceSnapshot, apiPort: number): string | null {
  for (const c of snap.mgmtConnections) {
    if ((c['protocol'] || '').toLowerCase() !== 'tcp') continue;
    const dst = c['dst-address'] || '';
    const port = dst.includes(':') ? parseInt(dst.split(':').pop() || '', 10) : NaN;
    if (port !== apiPort) continue;
    const src = (c['src-address'] || '').split(':')[0];
    if (src) return src;
  }
  return null;
}

// ─── resolution ───────────────────────────────────────────────────────────────

/**
 * Derive the management path. Pure over the snapshot so it can be exercised with
 * fixtures; every hop carries the reason it is load-bearing.
 */
export function resolveManagementPath(snap: DeviceSnapshot, device: GuardDevice): ManagementPath {
  const hops: PathHop[] = [];
  const warnings: string[] = [];
  const mgmtIp = device.ip_address;

  // 1. Which address object, and therefore which interface, serves the manager?
  const addrRow = snap.addresses.find(
    (a) => !isTrue(a['disabled']) && !isTrue(a['invalid']) && stripCidr(a['address']) === mgmtIp
  );
  const mgmtInterface = addrRow
    ? (addrRow['actual-interface'] || addrRow['interface'] || null)
    : null;

  if (!addrRow) {
    warnings.push(
      `No enabled /ip/address on the device matches ${mgmtIp}; the manager may be reaching it via NAT or a dynamic address.`
    );
  } else {
    hops.push({
      kind: 'address',
      name: addrRow['address'],
      reason: `${addrRow['address']} is the address the manager connects to, on interface ${mgmtInterface}.`,
    });
  }

  // 2. Classify that interface and walk down to the bridge, if any.
  let bridge: string | null = null;
  let mgmtVlanId: number | null = null;
  let taggedManagement = false;

  if (mgmtInterface) {
    const vlanIface =
      snap.vlanInterfaces.find((v) => v['name'] === mgmtInterface) ??
      snap.interfaces.find((i) => i['name'] === mgmtInterface && i['type'] === 'vlan');

    if (vlanIface) {
      // Management rides a tagged VLAN sub-interface.
      taggedManagement = true;
      const vid = parseInt(vlanIface['vlan-id'] || '', 10);
      mgmtVlanId = isNaN(vid) ? null : vid;
      const parent = vlanIface['interface'] || null;
      hops.push({
        kind: 'vlan-interface',
        name: mgmtInterface,
        reason: `${mgmtInterface} is a VLAN interface carrying VLAN ${mgmtVlanId ?? '?'} on top of ${parent ?? 'an unknown parent'}.`,
      });
      if (parent && snap.bridges.some((b) => b['name'] === parent)) bridge = parent;
      else if (parent) {
        hops.push({ kind: 'port', name: parent, reason: `${parent} is the physical parent of ${mgmtInterface}.` });
      }
    } else if (snap.bridges.some((b) => b['name'] === mgmtInterface)) {
      bridge = mgmtInterface;
    } else {
      hops.push({
        kind: 'port',
        name: mgmtInterface,
        reason: `${mgmtInterface} directly holds the management address.`,
      });
    }
  }

  const bridgeRow = bridge ? snap.bridges.find((b) => b['name'] === bridge) : undefined;
  const bridgeVlanFiltering = isTrue(bridgeRow?.['vlan-filtering']);
  if (bridge) {
    hops.push({
      kind: 'bridge',
      name: bridge,
      reason: bridgeVlanFiltering
        ? `${bridge} is the bridge (the CPU port) carrying management, with VLAN filtering ON — it must be a member of the management VLAN.`
        : `${bridge} is the bridge (the CPU port) carrying management.`,
    });
  }

  // 3. Where does the manager's traffic physically enter?
  const managerIp = managerIpFromConntrack(snap, device.api_port);

  // Which next-hop MAC carries the management conversation?
  //  - manager observed and on-subnet  → the manager's own address
  //  - manager observed and off-subnet → the gateway of its route
  //  - manager not observable (switches commonly run without connection tracking)
  //    → the default gateway, which is the return path for any off-subnet manager
  let lookupIp: string | null = null;
  let viaDefaultGw = false;

  if (managerIp) {
    const route = routeFor(snap, managerIp);
    const gw = route?.['gateway'] ? route['gateway'].split('%')[0].trim() : null;
    lookupIp = snap.arp.some((a) => a['address'] === managerIp) ? managerIp : gw;
  } else {
    const defaultRoute = snap.routes.find(
      (r) => (r['dst-address'] || '') === '0.0.0.0/0' && r['active'] !== 'false' && !isTrue(r['disabled'])
    );
    const gw = defaultRoute?.['gateway'] ? defaultRoute['gateway'].split('%')[0].trim() : null;
    if (gw && ipToInt(gw) !== null) { lookupIp = gw; viaDefaultGw = true; }
  }

  let ingressPort: string | null = null;
  let ingressPortSource: ManagementPath['ingressPortSource'] = 'unknown';

  if (lookupIp) {
    const arpRow = snap.arp.find((a) => a['address'] === lookupIp);
    const mac = arpRow?.['mac-address'];
    if (mac) {
      const host = snap.bridgeHosts.find(
        (h) => (h['mac-address'] || '').toLowerCase() === mac.toLowerCase() && !isTrue(h['local'])
      );
      const port = host?.['on-interface'] || host?.['interface'] || null;
      if (port) {
        ingressPort = port;
        ingressPortSource = viaDefaultGw ? 'fdb-default-gw' : 'fdb';
      } else if (arpRow?.['interface'] && arpRow['interface'] !== bridge) {
        // ARP resolves to the bridge itself for anything behind it, which is not a
        // port — only useful when the address sits on a real interface.
        ingressPort = arpRow['interface'];
        ingressPortSource = 'inferred';
      }
    }
  }

  if (ingressPort) {
    const why =
      ingressPortSource === 'fdb'
        ? `that is where the manager's next-hop MAC is currently learned`
        : ingressPortSource === 'fdb-default-gw'
          ? `that is where the default gateway (${lookupIp}) is currently learned, and the manager reaches this device through it`
          : `inferred from the ARP entry; not confirmed by the forwarding table`;
    hops.push({
      kind: 'port',
      name: ingressPort,
      reason: `Management traffic arrives on ${ingressPort} — ${why}.`,
    });
  } else if (bridge) {
    warnings.push(`Could not determine which port management arrives on; every port of ${bridge} is treated as potentially load-bearing.`);
  }

  // Untagged management: the VLAN is whatever PVID the ingress port stamps on.
  if (bridge && !taggedManagement) {
    const portRow = ingressPort
      ? snap.bridgePorts.find((p) => p['interface'] === ingressPort && p['bridge'] === bridge)
      : undefined;
    const pvid = parseInt(portRow?.['pvid'] || bridgeRow?.['pvid'] || '', 10);
    mgmtVlanId = isNaN(pvid) ? null : pvid;
  }

  // 4. Is the ingress port actually a bond?
  let ingressBond: string | null = null;
  if (ingressPort) {
    const asBond = snap.interfaces.find((i) => i['name'] === ingressPort && i['type'] === 'bond');
    if (asBond) {
      ingressBond = ingressPort;
      hops.push({
        kind: 'bond',
        name: ingressPort,
        reason: `${ingressPort} is a bond; management depends on it keeping at least one running member.`,
      });
    }
  }

  return {
    mgmtIp,
    mgmtInterface,
    bridge,
    bridgeVlanFiltering,
    mgmtVlanId,
    taggedManagement,
    ingressPort,
    ingressPortSource,
    managerIp,
    ingressBond,
    hops,
    warnings,
  };
}
