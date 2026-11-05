/**
 * MLAG health (#376), from what the slow poll stored: each bridge's MLAG state
 * and settings, the MLAG bonds and the peer link, and the log events MLAG
 * writes. Pure, so every check is tested without a device. The checks are the
 * ones Aziz found by reading logs by hand on a pair of CRS317s.
 */

export interface MlagBridge {
  device_id: number;
  device_name: string;
  ros_version: string | null;
  bridge_name: string;
  mlag_peer_port: string;
  mlag_priority: number | null;
  mlag_heartbeat: string | null;
  mlag_init_delay: string | null;
  mlag_lacp_fallback: boolean | null;
  mlag_state: string | null;
  mlag_role: string | null;
  mlag_state_changed_at: string | Date | null;
  mlag_missing_vlans: number[] | null;
}

export interface MlagBond {
  device_id: number;
  bond: string;
  bridge: string | null;
  mlag_id: number | null;
  is_peer_link: boolean;
  slaves: string | null;
  running: boolean | null;
  active_ports: string | null;
  inactive_ports: string | null;
  partner_sys_id: string | null;
  /** The managed device the LACP partner is, when it's one. */
  partner_device_name?: string | null;
}

export interface PeerLink { from_device_id: number; from_interface: string | null; to_device_id: number | null }

export interface MlagEvents { heartbeatHour: number; fdbFailHour: number; peerLinkDownDay: number }

export type MlagSeverity = 'critical' | 'warning';
export interface MlagFinding { severity: MlagSeverity; code: string; text: string }

export interface BondSide { bond: string; running: boolean; active: string[]; inactive: string[]; partner: string | null; partnerName: string | null }
export interface MlagBondRow {
  mlagId: number;
  a: BondSide | null;
  b: BondSide | null;
  status: 'dual-homed' | 'single-homed' | 'mismatch' | 'down';
}

export interface MlagPair {
  a: MlagBridge;
  /** Null when the peer isn't managed, or wasn't found from the peer port. */
  b: MlagBridge | null;
  peerLinkA: MlagBond | null;
  peerLinkB: MlagBond | null;
  bonds: MlagBondRow[];
  findings: MlagFinding[];
  status: 'healthy' | 'degraded' | 'critical';
}

const list = (v: string | null | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Pair each MLAG bridge with the one at the far end of its peer port, from
 * neighbour discovery on the peer port or its members. A bridge whose peer
 * isn't found stands alone.
 */
export function pairMlag(bridges: MlagBridge[], bonds: MlagBond[], links: PeerLink[]): Array<[MlagBridge, MlagBridge | null]> {
  const byDevice = new Map(bridges.map((b) => [b.device_id, b]));
  const peerOf = (br: MlagBridge): MlagBridge | null => {
    const link = bonds.find((x) => x.device_id === br.device_id && x.is_peer_link && x.bond === br.mlag_peer_port);
    const ports = new Set([br.mlag_peer_port, ...list(link?.slaves)]);
    for (const l of links) {
      if (l.from_device_id !== br.device_id || !l.to_device_id || !l.from_interface) continue;
      if (!ports.has(l.from_interface)) continue;
      const other = byDevice.get(l.to_device_id);
      if (other) return other;
    }
    return null;
  };
  const done = new Set<number>();
  const out: Array<[MlagBridge, MlagBridge | null]> = [];
  for (const br of [...bridges].sort((x, y) => x.device_id - y.device_id)) {
    if (done.has(br.device_id)) continue;
    let peer = peerOf(br);
    if (peer && done.has(peer.device_id)) peer = null;
    done.add(br.device_id);
    if (peer) done.add(peer.device_id);
    out.push([br, peer]);
  }
  return out;
}

const side = (b: MlagBond | undefined): BondSide | null => b ? {
  bond: b.bond, running: !!b.running, active: list(b.active_ports), inactive: list(b.inactive_ports),
  partner: b.partner_sys_id, partnerName: b.partner_device_name ?? null,
} : null;

/** The MLAG bonds of a pair, side by side by mlag-id. */
export function bondRows(a: MlagBridge, b: MlagBridge | null, bonds: MlagBond[]): MlagBondRow[] {
  const mine = (d: MlagBridge | null) => (d ? bonds.filter((x) => x.device_id === d.device_id && !x.is_peer_link && x.mlag_id != null) : []);
  const ids = [...new Set([...mine(a), ...mine(b)].map((x) => x.mlag_id!))].sort((x, y) => x - y);
  return ids.map((id) => {
    const sa = side(mine(a).find((x) => x.mlag_id === id));
    const sb = side(mine(b).find((x) => x.mlag_id === id));
    const upA = !!sa?.running;
    const upB = !!sb?.running;
    const status: MlagBondRow['status'] = upA && upB
      ? (sa!.partner && sb!.partner && sa!.partner !== sb!.partner ? 'mismatch' : 'dual-homed')
      : upA || upB ? 'single-homed' : 'down';
    return { mlagId: id, a: sa, b: sb, status };
  });
}

const changedRecently = (t: string | Date | null, now: number) =>
  !!t && now - new Date(t).getTime() < 86_400_000;

/** Every check from #376, worst first. `events` per device id. */
export function mlagFindings(a: MlagBridge, b: MlagBridge | null, bonds: MlagBond[],
  events: Map<number, MlagEvents>, now = Date.now()): MlagFinding[] {
  const f: MlagFinding[] = [];
  const peers = b ? [a, b] : [a];

  // 1. State
  for (const p of peers) {
    if (p.mlag_state !== 'connected') {
      f.push({ severity: 'critical', code: 'state', text: `${p.device_name}: MLAG is ${p.mlag_state ?? 'not reporting a state'}, not connected.` });
    }
  }
  // 2. Roles
  if (b && a.mlag_role && a.mlag_role === b.mlag_role) {
    f.push({ severity: 'critical', code: 'roles', text: `Both peers are ${a.mlag_role}${a.mlag_role === 'primary' ? ' (split brain)' : ''}.` });
  }
  // 3. Recent change
  for (const p of peers) {
    if (changedRecently(p.mlag_state_changed_at, now)) {
      f.push({ severity: 'warning', code: 'changed', text: `${p.device_name}: MLAG state or role changed in the last 24 hours (now ${p.mlag_state ?? '?'}, ${p.mlag_role ?? '?'}).` });
    }
  }
  // 4. Peer link
  for (const p of peers) {
    const link = bonds.find((x) => x.device_id === p.device_id && x.is_peer_link);
    if (!link) continue;
    const active = list(link.active_ports);
    const inactive = list(link.inactive_ports);
    if (!link.running) {
      f.push({ severity: 'critical', code: 'peer-link', text: `${p.device_name}: the peer link ${link.bond} is down.` });
    } else if (inactive.length) {
      f.push({ severity: 'warning', code: 'peer-link', text: `${p.device_name}: the peer link ${link.bond} has ${active.length} of ${active.length + inactive.length} members up (${inactive.join(', ')} not active).` });
    }
  }
  // 5 and 6. Bonds
  for (const row of bondRows(a, b, bonds)) {
    const name = (s: BondSide | null) => s?.partnerName ? ` (${s.partnerName})` : '';
    if (b && row.status === 'single-homed') {
      const up = row.a?.running ? a : b;
      const downSide = row.a?.running ? row.b : row.a;
      f.push({ severity: 'warning', code: 'single-homed', text: `mlag-id ${row.mlagId}${name(row.a ?? row.b)} is up on ${up.device_name} only${downSide ? ` (${downSide.bond} is down on the other)` : ', and isn’t set up on the other'}.` });
    }
    if (row.status === 'mismatch') {
      f.push({ severity: 'critical', code: 'partner', text: `mlag-id ${row.mlagId}: the two peers see different LACP partners (${row.a!.partner} and ${row.b!.partner}), so it's cabled to two devices.` });
    }
  }
  // 7. VLANs missing on the peer link
  for (const p of peers) {
    if (p.mlag_missing_vlans?.length) {
      f.push({ severity: 'warning', code: 'vlans', text: `${p.device_name}: VLAN ${p.mlag_missing_vlans.join(', ')} ${p.mlag_missing_vlans.length > 1 ? 'are' : 'is'} on MLAG bonds but not tagged on the peer link ${p.mlag_peer_port}. Hosts in ${p.mlag_missing_vlans.length > 1 ? 'them' : 'it'} can't be synced between the peers.` });
    }
  }
  // 8. Settings that should match
  if (b) {
    const diffs: [string, unknown, unknown][] = [
      ['mlag-heartbeat', a.mlag_heartbeat, b.mlag_heartbeat],
      ['mlag-init-delay', a.mlag_init_delay, b.mlag_init_delay],
      ['mlag-lacp-fallback', a.mlag_lacp_fallback, b.mlag_lacp_fallback],
      ['RouterOS version', a.ros_version, b.ros_version],
    ];
    for (const [what, x, y] of diffs) {
      if (x != null && y != null && x !== y) f.push({ severity: 'warning', code: 'mismatch', text: `${what} differs between the peers: ${x} on ${a.device_name}, ${y} on ${b.device_name}.` });
    }
  }
  // 9 to 11. Events
  for (const p of peers) {
    const e = events.get(p.device_id);
    if (!e) continue;
    if (e.heartbeatHour > 0) f.push({ severity: e.heartbeatHour > 30 ? 'critical' : 'warning', code: 'heartbeat', text: `${p.device_name}: ${e.heartbeatHour} MLAG heartbeat timeout${e.heartbeatHour > 1 ? 's' : ''} in the last hour.` });
    if (e.fdbFailHour > 0) f.push({ severity: 'warning', code: 'fdb-sync', text: `${p.device_name}: ${e.fdbFailHour} host sync failure${e.fdbFailHour > 1 ? 's' : ''} in the last hour. Check that every VLAN is tagged on the peer link.` });
    if (e.peerLinkDownDay > 0) f.push({ severity: 'warning', code: 'peer-link-flap', text: `${p.device_name}: the peer link went down ${e.peerLinkDownDay} time${e.peerLinkDownDay > 1 ? 's' : ''} in the last 24 hours.` });
  }
  if (!b) f.push({ severity: 'warning', code: 'no-peer', text: `${a.device_name}'s MLAG peer wasn't found: it isn't managed here, or neighbour discovery doesn't see it on ${a.mlag_peer_port}. Checks between the peers are skipped.` });

  const rank = (s: MlagSeverity) => (s === 'critical' ? 0 : 1);
  return f.sort((x, y) => rank(x.severity) - rank(y.severity));
}

export function buildPairs(bridges: MlagBridge[], bonds: MlagBond[], links: PeerLink[], events: Map<number, MlagEvents>, now = Date.now()): MlagPair[] {
  return pairMlag(bridges, bonds, links).map(([a, b]) => {
    const findings = mlagFindings(a, b, bonds, events, now);
    return {
      a, b,
      peerLinkA: bonds.find((x) => x.device_id === a.device_id && x.is_peer_link) ?? null,
      peerLinkB: b ? bonds.find((x) => x.device_id === b.device_id && x.is_peer_link) ?? null : null,
      bonds: bondRows(a, b, bonds),
      findings,
      status: findings.some((x) => x.severity === 'critical') ? 'critical' : findings.length ? 'degraded' : 'healthy',
    };
  });
}
