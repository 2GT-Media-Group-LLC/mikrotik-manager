/**
 * A client's way to the top of its site: the device it's on, then that
 * device's way up, and so on until there's no further to go (#365, #363).
 *
 * Each step is spanning tree's answer where it has one, the same answer the
 * topology map and the firmware rollout use (resolveStpUpstreams): the
 * switch on the far end of the root port, managed or not. Spanning tree is
 * the network's own record of which way is up, so it beats anything inferred
 * from neighbour discovery.
 *
 * Where it has none (no spanning tree, or a tree it can't place the device in)
 * the step is the discovery ranking the client page always used
 * (UPSTREAM_LINK_ORDER). A device that is the root bridge is the top of its
 * tree, so from there the path only goes up a tier, to a router above a
 * switch or a switch above an access point: never down into the tree it is
 * the root of.
 */
import { query } from '../../config/database';
import { resolveStpUpstreams, type StpBridge, type StpLink, type UpstreamVerdict } from '../../utils/stpUpstream';
import { UPSTREAM_CANDIDATE, UPSTREAM_IS_TOP, UPSTREAM_LINK_ORDER, deviceTier } from '../../utils/clientPorts';
import { loadBondMembers } from './bondMembers';

export interface PathHop {
  /** The managed device at this step, or null for equipment the manager doesn't manage. */
  device_id: number | null;
  name: string;
  device_type: string | null;
  ip: string | null;
  managed: boolean;
  /** The port on the step below that leads here. */
  from_port: string | null;
  /** The port on this step the link arrives at. */
  port: string | null;
  /** Spanning tree named this step, or neighbour discovery's ranking chose it. */
  how: 'stp' | 'discovery';
}

/** How far a path goes before it's taken as a loop in the data. */
const MAX_HOPS = 12;

interface LinkRow extends StpLink {
  id: number;
  from_device_id: number;
  from_interface: string | null;
  to_interface: string | null;
  to_device_id: number | null;
  neighbor_identity: string | null;
  neighbor_address: string | null;
}

interface DeviceRow { id: number; name: string; device_type: string | null; ip_address: string | null }

/** "bridge/Po1/sfp-sfpplus1" → "sfp-sfpplus1": the port, not the path RouterOS reports it by. */
const portName = (p: string | null | undefined): string | null => {
  const s = (p ?? '').trim();
  return s ? s.split('/').pop() || s : null;
};

/** The discovery ranking's way up for one device: today's rule, or (from a root bridge) a tier up only. */
async function rankedWayUp(deviceId: number, tierUpOnly: boolean) {
  const rows = await query<{ to_device_id: number | null; from_interface: string | null; to_interface: string | null;
    name: string | null; device_type: string | null; ip: string | null }>(
    `SELECT x.to_device_id, x.from_interface, x.to_interface, x.name, x.device_type, x.ip FROM (
       SELECT tl.to_device_id, tl.from_interface, tl.to_interface,
              COALESCE(ud.name, NULLIF(TRIM(tl.neighbor_identity), ''), tl.neighbor_address) AS name,
              ud.device_type, COALESCE(ud.ip_address, tl.neighbor_address) AS ip,
              ${UPSTREAM_IS_TOP} AS is_top
         FROM topology_links tl
         JOIN devices d ON d.id = tl.from_device_id
         LEFT JOIN devices ud ON ud.id = tl.to_device_id
        WHERE tl.from_device_id = $1 AND ${UPSTREAM_CANDIDATE}
          ${tierUpOnly ? `AND tl.to_device_id IS NOT NULL AND ${deviceTier('ud')} < ${deviceTier('d')}` : ''}
        ORDER BY ${UPSTREAM_LINK_ORDER}
        LIMIT 1
     ) x WHERE NOT x.is_top`,
    [deviceId],
  );
  return rows[0] ?? null;
}

/** Spanning tree's verdict for a device: its nearest tree's, where it bridges several. */
function verdictFor(deviceId: number, verdicts: UpstreamVerdict[], bridges: StpBridge[]): UpstreamVerdict | null {
  const mine = verdicts.filter((v) => v.deviceId === deviceId);
  if (mine.length === 0) return null;
  const cost = (v: UpstreamVerdict) => bridges.find((b) => b.device_id === deviceId && b.bridge_name === v.bridgeName)?.root_path_cost ?? Number.MAX_SAFE_INTEGER;
  const pick = (c: UpstreamVerdict['confidence']) => mine.filter((v) => v.confidence === c).sort((a, b) => cost(a) - cost(b))[0];
  return pick('resolved') ?? pick('external-upstream') ?? (mine.every((v) => v.confidence === 'is-root') ? mine[0] : null);
}

/** The path above `startDeviceId`, nearest first. Empty at the top of a site. */
export async function clientPath(startDeviceId: number): Promise<PathHop[]> {
  // Spanning tree for the start device's site: its bridges that run it, and the links between them.
  const site = `(SELECT site_id FROM devices WHERE id = $1)`;
  const [devices, bridges, links, bondMembers] = await Promise.all([
    query<DeviceRow>(`SELECT id, name, device_type, ip_address FROM devices WHERE site_id IS NOT DISTINCT FROM ${site}`, [startDeviceId]),
    query<StpBridge>(
      `SELECT b.device_id, b.bridge_name, b.bridge_id, b.root_bridge, b.root_bridge_id, b.root_port, b.root_path_cost,
              b.designated_bridge_id, b.designated_port_id, d.site_id
         FROM device_bridges b JOIN devices d ON d.id = b.device_id
        WHERE d.site_id IS NOT DISTINCT FROM ${site} AND COALESCE(b.protocol_mode, 'none') <> 'none'`,
      [startDeviceId]).catch(() => [] as StpBridge[]),
    query<LinkRow>(
      `SELECT tl.id, tl.from_device_id, tl.from_interface, tl.to_interface, tl.to_device_id, tl.link_type,
              tl.neighbor_mac, tl.neighbor_identity, tl.neighbor_address
         FROM topology_links tl JOIN devices d ON d.id = tl.from_device_id
        WHERE d.site_id IS NOT DISTINCT FROM ${site}`,
      [startDeviceId]).catch(() => [] as LinkRow[]),
    loadBondMembers(),
  ]);
  const byId = new Map(devices.map((d) => [Number(d.id), d]));
  const verdicts = resolveStpUpstreams(bridges, links, bondMembers);

  const hops: PathHop[] = [];
  const visited = new Set<number>([startDeviceId]);
  let current = startDeviceId;
  for (let i = 0; i < MAX_HOPS; i++) {
    const v = verdictFor(current, verdicts, bridges);
    let hop: PathHop | null = null;

    if (v?.confidence === 'resolved' && v.upstreamDeviceId != null) {
      const up = byId.get(v.upstreamDeviceId);
      const rootPort = bridges.find((b) => b.device_id === current && b.bridge_name === v.bridgeName)?.root_port ?? null;
      // The port on the upstream that faces this device: its own report of the link, else ours of its far end.
      const back = links.find((l) => l.from_device_id === v.upstreamDeviceId && l.to_device_id === current);
      const forward = links.find((l) => l.from_device_id === current && l.to_device_id === v.upstreamDeviceId);
      hop = {
        device_id: v.upstreamDeviceId, name: up?.name ?? `Device ${v.upstreamDeviceId}`, device_type: up?.device_type ?? null,
        ip: up?.ip_address ?? null, managed: true,
        from_port: portName(rootPort), port: portName(back?.from_interface ?? forward?.to_interface), how: 'stp',
      };
    } else if (v?.confidence === 'external-upstream') {
      const via = v.viaLinkId != null ? links.find((l) => l.id === v.viaLinkId) : undefined;
      const rootPort = bridges.find((b) => b.device_id === current && b.bridge_name === v.bridgeName)?.root_port ?? null;
      hop = {
        device_id: null, name: v.upstreamName || 'Switch not managed here', device_type: null,
        ip: via?.neighbor_address ?? null, managed: false,
        from_port: portName(rootPort), port: portName(via?.to_interface), how: 'stp',
      };
    } else {
      // No spanning-tree answer: discovery's ranking, a tier up only from a root bridge.
      const r = await rankedWayUp(current, v?.confidence === 'is-root');
      if (r) {
        hop = {
          device_id: r.to_device_id == null ? null : Number(r.to_device_id), name: r.name ?? 'Unknown', device_type: r.device_type,
          ip: r.ip, managed: r.to_device_id != null,
          from_port: portName(r.from_interface), port: portName(r.to_interface), how: 'discovery',
        };
      }
    }

    if (!hop) break;
    if (hop.device_id != null && visited.has(hop.device_id)) break;
    hops.push(hop);
    if (hop.device_id == null) break;
    visited.add(hop.device_id);
    current = hop.device_id;
  }
  return hops;
}

/** The managed device a MAC belongs to (one of its own interfaces), within the site scope given. */
export async function deviceOwningMac(mac: string, scope: string | null): Promise<DeviceRow | null> {
  const rows = await query<DeviceRow>(
    `SELECT d.id, d.name, d.device_type, d.ip_address FROM devices d
      WHERE d.id IN (SELECT device_id FROM interfaces WHERE LOWER(mac_address) = $1
                     UNION SELECT device_id FROM wireless_interfaces WHERE LOWER(mac_address) = $1)
        ${scope ? `AND ${scope}` : ''}
      ORDER BY d.id LIMIT 1`,
    [mac.toLowerCase()],
  ).catch(() => [] as DeviceRow[]);
  return rows[0] ?? null;
}
