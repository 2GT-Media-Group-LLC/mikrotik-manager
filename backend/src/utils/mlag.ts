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
  /** When the bond was last seen running; null if never, since the manager started recording it. */
  last_running_at?: string | Date | null;
}

export interface PeerLink { from_device_id: number; from_interface: string | null; to_device_id: number | null }

export interface MlagEvents { heartbeatHour: number; fdbFailHour: number; peerLinkDownDay: number }

export type MlagSeverity = 'critical' | 'warning';
export interface MlagFinding { severity: MlagSeverity; code: string; text: string }

export interface BondSide { bond: string; running: boolean; active: string[]; inactive: string[]; partner: string | null; partnerName: string | null; everUp: boolean }
export interface MlagBondRow {
  mlagId: number;
  a: BondSide | null;
  b: BondSide | null;
  /** unused: down on both peers and never seen up (set up for a switch not cabled yet). */
  status: 'dual-homed' | 'single-homed' | 'mismatch' | 'down' | 'unused';
}

export interface MlagPair {
  a: MlagBridge;
  /** Null when the peer isn't managed, or wasn't found from the peer port. */
  b: MlagBridge | null;
  peerLinkA: MlagBond | null;
  peerLinkB: MlagBond | null;
  bonds: MlagBondRow[];
  findings: MlagFinding[];
  /** critical: a critical finding; warning: only warnings (#376). */
  status: 'healthy' | 'warning' | 'critical';
  /** The peer link in detail; filled in by services/mlag.ts. */
  peerLink?: PeerLinkView;
}

const list = (v: string | null | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Pair each MLAG bridge with the one at the far end of its peer port, from
 * neighbour discovery on the peer port or its members. A bridge whose peer
 * isn't found stands alone.
 */
export function pairMlag(bridges: MlagBridge[], bonds: MlagBond[], links: PeerLink[]): Array<[MlagBridge, MlagBridge | null]> {
  const byDevice = new Map(bridges.map((b) => [b.device_id, b]));
  const peerPorts = (br: MlagBridge) => {
    const link = bonds.find((x) => x.device_id === br.device_id && x.is_peer_link && x.bond === br.mlag_peer_port);
    return new Set([br.mlag_peer_port, ...list(link?.slaves)]);
  };
  const peerOf = (br: MlagBridge): MlagBridge | null => {
    const ports = peerPorts(br);
    for (const l of links) {
      if (l.from_device_id !== br.device_id || !l.to_device_id || !l.from_interface) continue;
      if (!ports.has(l.from_interface)) continue;
      const other = byDevice.get(l.to_device_id);
      if (other) return other;
    }
    // Discovery may only report the link from the other end: an MLAG peer whose
    // peer port reaches this bridge's device.
    for (const l of links) {
      if (l.to_device_id !== br.device_id || !l.from_interface || l.from_device_id === br.device_id) continue;
      const other = byDevice.get(l.from_device_id);
      if (other && peerPorts(other).has(l.from_interface)) return other;
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
    // Every pair reads the same way round: the primary on the left, else by name.
    const swap = !!peer && (
      (peer.mlag_role === 'primary' && br.mlag_role !== 'primary')
      || ((peer.mlag_role === 'primary') === (br.mlag_role === 'primary') && peer.device_name.localeCompare(br.device_name) < 0));
    out.push(swap ? [peer!, br] : [br, peer]);
  }
  return out;
}

const side = (b: MlagBond | undefined): BondSide | null => b ? {
  bond: b.bond, running: !!b.running, active: list(b.active_ports), inactive: list(b.inactive_ports),
  partner: b.partner_sys_id, partnerName: b.partner_device_name ?? null,
  everUp: !!b.running || !!b.last_running_at,
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
      : upA || upB ? 'single-homed' : sa?.everUp || sb?.everUp ? 'down' : 'unused';
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
    if (row.status === 'down') {
      f.push({ severity: 'warning', code: 'bond-down', text: `mlag-id ${row.mlagId}${name(row.a ?? row.b)} is down on ${b ? 'both peers' : a.device_name}.` });
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
      status: findings.some((x) => x.severity === 'critical') ? 'critical' : findings.length ? 'warning' : 'healthy',
    };
  });
}

// ─── The peer link in detail (#376, aziz's item 4) ───────────────────────────

/** One physical member of a peer link on one switch. */
export interface PeerMember {
  name: string;
  /** Link up on the port. */
  running: boolean;
  /** Active in the bond (LACP agreed). */
  active: boolean;
  speed: string | null;
  /** RouterOS's link-downs counter since boot. */
  linkDowns: number | null;
  /** FCS, alignment and other receive errors in the last 24 hours. */
  errors24h: number;
  /** The last time the link went down that the manager saw (7 days kept). */
  lastDownAt: string | null;
}

export interface PeerLinkSide {
  bond: string;
  /** The LACP partner this side sees on the peer link. */
  partner: string | null;
  /** Whether that partner is the other peer: anything else means crossed cabling. */
  partnerOk: boolean | null;
  /** VLANs tagged on the peer link. */
  vlans: number[];
}

export interface PeerLinkView {
  a: PeerLinkSide | null;
  b: PeerLinkSide | null;
  /** Members lined up: the two ends of one cable, as neighbour discovery sees it, else by name. */
  members: { a: PeerMember | null; b: PeerMember | null }[];
  /** reboot: one of the peers booted around then, so it was a restart rather than a cable or optic. */
  lastFlap: { device: string; member: string; at: string; reboot: boolean } | null;
}

/**
 * A link-down this close to a boot is the reboot. The link drops when the
 * reboot starts, but the boot time counts from when RouterOS is back, which
 * can be minutes later (4½ on aziz's CRS326s, with a package upgrade), so the
 * window reaches well before the boot, and a little after for clock and poll slack.
 */
const REBOOT_BEFORE_MS = 10 * 60_000;
const REBOOT_AFTER_MS = 3 * 60_000;

/** What the manager stores about one port, as buildPeerLink takes it. */
export interface PortFacts {
  device_id: number;
  name: string;
  running: boolean | null;
  speed: string | null;
  link_downs: number | null;
  errors_24h: number;
  last_down_at: string | null;
}

export interface PeerLinkInput {
  pair: MlagPair;
  ports: PortFacts[];
  /** device id → its interfaces' MACs, upper case. */
  macs: Map<number, Set<string>>;
  /** device id → VLANs tagged on its peer port. */
  vlans: Map<number, number[]>;
  /** Neighbour discovery between the two peers. */
  links: { from_device_id: number; from_interface: string | null; to_device_id: number | null; to_interface: string | null }[];
  /** device id → recent boot times. */
  boots?: Map<number, (string | Date)[]>;
}

export function buildPeerLink(input: PeerLinkInput): PeerLinkView {
  const { pair, ports, macs, vlans, links, boots } = input;
  const members = (bond: MlagBond | null, d: MlagBridge | null): PeerMember[] => {
    if (!bond || !d) return [];
    const active = new Set(list(bond.active_ports));
    const names = list(bond.slaves).length ? list(bond.slaves) : [bond.bond];
    return names.map((name) => {
      const p = ports.find((x) => x.device_id === d.device_id && x.name === name);
      return {
        name,
        running: !!p?.running,
        active: active.has(name),
        speed: p?.speed ?? null,
        linkDowns: p?.link_downs ?? null,
        errors24h: p?.errors_24h ?? 0,
        lastDownAt: p?.last_down_at ?? null,
      };
    });
  };
  const side = (bond: MlagBond | null, me: MlagBridge | null, other: MlagBridge | null): PeerLinkSide | null => {
    if (!bond || !me) return null;
    const partner = bond.partner_sys_id ? bond.partner_sys_id.toUpperCase() : null;
    return {
      bond: bond.bond,
      partner,
      partnerOk: partner && other ? !!macs.get(other.device_id)?.has(partner) : null,
      vlans: [...(vlans.get(me.device_id) ?? [])].sort((x, y) => x - y),
    };
  };
  const ma = members(pair.peerLinkA, pair.a);
  const mb = members(pair.peerLinkB, pair.b);
  // The two ends of each cable, from neighbour discovery; what's left is paired by name order.
  const rows: { a: PeerMember | null; b: PeerMember | null }[] = [];
  const usedB = new Set<string>();
  const restA: PeerMember[] = [];
  for (const m of ma) {
    const l = pair.b ? links.find((x) => x.from_device_id === pair.a.device_id && x.from_interface === m.name && x.to_device_id === pair.b!.device_id) : undefined;
    const other = l?.to_interface ? mb.find((x) => x.name === l.to_interface && !usedB.has(x.name)) : undefined;
    if (other) { usedB.add(other.name); rows.push({ a: m, b: other }); } else restA.push(m);
  }
  const restB = mb.filter((x) => !usedB.has(x.name));
  const byName = (x: PeerMember, y: PeerMember) => x.name.localeCompare(y.name, undefined, { numeric: true });
  restA.sort(byName); restB.sort(byName);
  for (let i = 0; i < Math.max(restA.length, restB.length); i++) rows.push({ a: restA[i] ?? null, b: restB[i] ?? null });

  let lastFlap: PeerLinkView['lastFlap'] = null;
  for (const [d, list_] of [[pair.a, ma], [pair.b, mb]] as const) {
    if (!d) continue;
    for (const m of list_) {
      if (m.lastDownAt && (!lastFlap || new Date(m.lastDownAt) > new Date(lastFlap.at))) lastFlap = { device: d.device_name, member: m.name, at: m.lastDownAt, reboot: false };
    }
  }
  // Either peer restarting takes the link down at both ends.
  if (lastFlap && boots) {
    const at = new Date(lastFlap.at).getTime();
    lastFlap.reboot = [pair.a, pair.b].some((d) => d && (boots.get(d.device_id) ?? []).some((b) => {
      const t = new Date(b).getTime();
      return at >= t - REBOOT_BEFORE_MS && at <= t + REBOOT_AFTER_MS;
    }));
  }
  return { a: side(pair.peerLinkA, pair.a, pair.b), b: side(pair.peerLinkB, pair.b, pair.a), members: rows, lastFlap };
}

/** Critical: a peer link whose LACP partner isn't the other peer is cabled to something else. */
export function peerLinkFindings(pair: MlagPair, view: PeerLinkView): MlagFinding[] {
  const out: MlagFinding[] = [];
  for (const [s, d, other] of [[view.a, pair.a, pair.b], [view.b, pair.b, pair.a]] as const) {
    if (s && d && other && s.partnerOk === false) {
      out.push({ severity: 'critical', code: 'peer-link-partner',
        text: `${d.device_name}: the LACP partner on the peer link ${s.bond} is ${s.partner}, not ${other.device_name}. The peer link is cabled to another device.` });
    }
  }
  return out;
}
