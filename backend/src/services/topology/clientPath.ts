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
 *
 * Sites. Discovery only matches a neighbour to a device in the same site
 * (outside review P2-19), so a switch cabled to one managed in another site
 * looks unmanaged from here. The path takes that step to the managed device
 * only on proof that it's the same box: the neighbour's MAC is one of that
 * device's own, the only device in the fleet with it, and it calls itself by
 * that device's name. Then the path goes on in the other site, if the viewer
 * can see it; one who can't sees the name discovery heard, marked as in
 * another site, and nothing more.
 */
import { query } from '../../config/database';
import { resolveStpUpstreams, type StpBridge, type StpLink, type UpstreamVerdict } from '../../utils/stpUpstream';
import { UPSTREAM_CANDIDATE, UPSTREAM_IS_TOP, UPSTREAM_LINK_ORDER, deviceTier } from '../../utils/clientPorts';
import { loadBondMembers } from './bondMembers';

export interface PathHop {
  /** The managed device at this step, or null for equipment the manager doesn't manage (or the viewer can't see). */
  device_id: number | null;
  name: string;
  device_type: string | null;
  ip: string | null;
  managed: boolean;
  /** A managed device in a site the viewer can't see: named as discovery heard it, and the path stops. */
  other_site?: boolean;
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
  neighbor_mac: string | null;
}

interface DeviceRow { id: number; name: string; device_type: string | null; ip_address: string | null; site_id: number | null }

interface SiteData { devices: Map<number, DeviceRow>; bridges: StpBridge[]; links: LinkRow[]; verdicts: UpstreamVerdict[] }

/** "bridge/Po1/sfp-sfpplus1" → "sfp-sfpplus1": the port, not the path RouterOS reports it by. */
const portName = (p: string | null | undefined): string | null => {
  const s = (p ?? '').trim();
  return s ? s.split('/').pop() || s : null;
};

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** One site's devices, spanning tree and links, with spanning tree's verdicts worked out. */
async function loadSite(siteId: number | null, bondMembers: Map<string, string[]>): Promise<SiteData> {
  const [devices, bridges, links] = await Promise.all([
    query<DeviceRow>(`SELECT id, name, device_type, ip_address, site_id FROM devices WHERE site_id IS NOT DISTINCT FROM $1`, [siteId]),
    query<StpBridge>(
      `SELECT b.device_id, b.bridge_name, b.bridge_id, b.root_bridge, b.root_bridge_id, b.root_port, b.root_path_cost,
              b.designated_bridge_id, b.designated_port_id, d.site_id
         FROM device_bridges b JOIN devices d ON d.id = b.device_id
        WHERE d.site_id IS NOT DISTINCT FROM $1 AND COALESCE(b.protocol_mode, 'none') <> 'none'`,
      [siteId]).catch(() => [] as StpBridge[]),
    query<LinkRow>(
      `SELECT tl.id, tl.from_device_id, tl.from_interface, tl.to_interface, tl.to_device_id, tl.link_type,
              tl.neighbor_mac, tl.neighbor_identity, tl.neighbor_address
         FROM topology_links tl JOIN devices d ON d.id = tl.from_device_id
        WHERE d.site_id IS NOT DISTINCT FROM $1`,
      [siteId]).catch(() => [] as LinkRow[]),
  ]);
  return {
    devices: new Map(devices.map((d) => [Number(d.id), d])),
    bridges, links, verdicts: resolveStpUpstreams(bridges, links, bondMembers),
  };
}

/**
 * The managed device a neighbour is, wherever it's managed: the only device
 * in the fleet with that MAC on one of its own interfaces, and named as the
 * neighbour calls itself. Null without both.
 */
async function provenDevice(mac: string | null, identity: string | null): Promise<DeviceRow | null> {
  if (!mac || !norm(identity)) return null;
  const rows = await query<DeviceRow & { ros_identity: string | null }>(
    `SELECT d.id, d.name, d.device_type, d.ip_address, d.site_id, d.ros_identity FROM devices d
      WHERE d.id IN (SELECT device_id FROM interfaces WHERE UPPER(mac_address) = UPPER($1)
                     UNION SELECT device_id FROM wireless_interfaces WHERE UPPER(mac_address) = UPPER($1))`,
    [mac]).catch(() => []);
  if (rows.length !== 1) return null;
  const d = rows[0];
  return [d.name, d.ros_identity].some((n) => norm(n) === norm(identity)) ? { ...d, id: Number(d.id) } : null;
}

/** The discovery ranking's way up for one device: today's rule, or (from a root bridge) a tier up only. */
async function rankedWayUp(deviceId: number, tierUpOnly: boolean) {
  const rows = await query<{ to_device_id: number | null; from_interface: string | null; to_interface: string | null;
    name: string | null; device_type: string | null; ip: string | null; neighbor_mac: string | null; neighbor_identity: string | null }>(
    `SELECT x.to_device_id, x.from_interface, x.to_interface, x.name, x.device_type, x.ip, x.neighbor_mac, x.neighbor_identity FROM (
       SELECT tl.to_device_id, tl.from_interface, tl.to_interface, tl.neighbor_mac, tl.neighbor_identity,
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
function verdictFor(deviceId: number, site: SiteData): UpstreamVerdict | null {
  const mine = site.verdicts.filter((v) => v.deviceId === deviceId);
  if (mine.length === 0) return null;
  const cost = (v: UpstreamVerdict) => site.bridges.find((b) => b.device_id === deviceId && b.bridge_name === v.bridgeName)?.root_path_cost ?? Number.MAX_SAFE_INTEGER;
  const pick = (c: UpstreamVerdict['confidence']) => mine.filter((v) => v.confidence === c).sort((a, b) => cost(a) - cost(b))[0];
  return pick('resolved') ?? pick('external-upstream') ?? (mine.every((v) => v.confidence === 'is-root') ? mine[0] : null);
}

/**
 * The path above `startDeviceId`, nearest first. Empty at the top of a site.
 * `canSee` says whether the viewer may see a site: a step into one it can't is
 * named but not identified, and ends the path.
 */
export async function clientPath(startDeviceId: number, canSee: (siteId: number | null) => boolean): Promise<PathHop[]> {
  const bondMembers = await loadBondMembers();
  const sites = new Map<string, SiteData>();
  const site = async (siteId: number | null) => {
    const k = String(siteId);
    if (!sites.has(k)) sites.set(k, await loadSite(siteId, bondMembers));
    return sites.get(k)!;
  };
  const start = (await query<{ site_id: number | null }>(`SELECT site_id FROM devices WHERE id = $1`, [startDeviceId]))[0];
  if (!start) return [];

  /** A managed device in another site, as the next step: identified if the viewer can see it. */
  const crossSite = (d: DeviceRow, heardAs: string | null, ip: string | null, fromPort: string | null, port: string | null,
    how: PathHop['how']): PathHop => canSee(d.site_id)
    ? { device_id: d.id, name: d.name, device_type: d.device_type, ip: d.ip_address, managed: true, from_port: fromPort, port, how }
    : { device_id: null, name: heardAs?.trim() || 'A device in another site', device_type: null, ip, managed: true, other_site: true,
      from_port: fromPort, port, how };

  const hops: PathHop[] = [];
  const visited = new Set<number>([startDeviceId]);
  let current = startDeviceId;
  let currentSite = start.site_id;
  for (let i = 0; i < MAX_HOPS; i++) {
    const here = await site(currentSite);
    const v = verdictFor(current, here);
    const rootPortOf = (bridgeName: string) => here.bridges.find((b) => b.device_id === current && b.bridge_name === bridgeName)?.root_port ?? null;
    let hop: PathHop | null = null;

    if (v?.confidence === 'resolved' && v.upstreamDeviceId != null) {
      const up = here.devices.get(v.upstreamDeviceId);
      // The port on the upstream that faces this device: its own report of the link, else ours of its far end.
      const back = here.links.find((l) => l.from_device_id === v.upstreamDeviceId && l.to_device_id === current);
      const forward = here.links.find((l) => l.from_device_id === current && l.to_device_id === v.upstreamDeviceId);
      hop = {
        device_id: v.upstreamDeviceId, name: up?.name ?? `Device ${v.upstreamDeviceId}`, device_type: up?.device_type ?? null,
        ip: up?.ip_address ?? null, managed: true,
        from_port: portName(rootPortOf(v.bridgeName)), port: portName(back?.from_interface ?? forward?.to_interface), how: 'stp',
      };
    } else if (v?.confidence === 'external-upstream') {
      const via = v.viaLinkId != null ? here.links.find((l) => l.id === v.viaLinkId) : undefined;
      const fromPort = portName(rootPortOf(v.bridgeName));
      // Spanning tree's upstream may be managed in another site: the same box
      // when the link on the root port proves it and that box owns the bridge.
      const proven = via ? await provenDevice(via.neighbor_mac, via.neighbor_identity) : null;
      const owns = proven ? (await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM device_bridges WHERE device_id = $1 AND LOWER(bridge_id) = LOWER($2)`,
        [proven.id, v.designatedBridgeId ?? '']).catch(() => [{ n: 0 }]))[0].n > 0 : false;
      hop = proven && owns
        ? crossSite(proven, via?.neighbor_identity ?? null, via?.neighbor_address ?? null, fromPort, portName(via?.to_interface), 'stp')
        : {
          device_id: null, name: v.upstreamName || 'Switch not managed here', device_type: null,
          ip: via?.neighbor_address ?? null, managed: false, from_port: fromPort, port: portName(via?.to_interface), how: 'stp',
        };
    } else {
      // No spanning-tree answer: discovery's ranking, a tier up only from a root bridge.
      const r = await rankedWayUp(current, v?.confidence === 'is-root');
      if (r) {
        const proven = r.to_device_id == null ? await provenDevice(r.neighbor_mac, r.neighbor_identity) : null;
        hop = proven
          ? crossSite(proven, r.neighbor_identity, r.ip, portName(r.from_interface), portName(r.to_interface), 'discovery')
          : {
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
    // The next step is worked out in the site this device is in.
    if (!here.devices.has(current)) {
      currentSite = (await query<{ site_id: number | null }>(`SELECT site_id FROM devices WHERE id = $1`, [current]))[0]?.site_id ?? null;
    }
  }
  return hops;
}

/** The managed device a MAC belongs to (one of its own interfaces), within the site scope given. */
export async function deviceOwningMac(mac: string, scope: string | null): Promise<Omit<DeviceRow, 'site_id'> | null> {
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
