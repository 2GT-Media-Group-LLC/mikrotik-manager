import type { ExternalNode, LinkRow, TopoDevice } from './buildTopology';

/**
 * Links from OSPF adjacencies (#373). Neighbour discovery is layer 2, so it
 * never crosses a WireGuard, GRE or IPsec tunnel; OSPF does, and every
 * neighbour row names the device's interface, the neighbour's router ID, its
 * address and the adjacency state. Each one is a link:
 *
 *  - between two managed devices, one link, both ends' interfaces merged, and
 *    left out when the map already joins them;
 *  - to a router the manager doesn't manage, a node keyed by router ID, so one
 *    router reached over several tunnels is one node.
 *
 * An interface with several OSPF neighbours is a shared segment, not a link,
 * and is left out, as are neighbours discovery already draws on that port.
 * A lost adjacency stays on the map, marked down.
 */

export interface OspfPeerRow {
  device_id: number;
  remote_id: string | null;
  remote_address: string | null;
  local_interface: string | null;
  local_interface_type?: string | null;
  state: string;
  up: boolean;
}

export type OspfLink = LinkRow & { link_state: 'up' | 'down' };

const bare = (a: string | null | undefined) => (a ?? '').split('/')[0].trim().toLowerCase();

/** Every address of each managed device; an address two devices claim names neither. */
function addressIndex(devices: TopoDevice[]): Map<string, number> {
  const seen = new Map<string, number | null>();
  const add = (addr: string, id: number) => {
    const a = bare(addr);
    if (!a) return;
    seen.set(a, seen.has(a) && seen.get(a) !== id ? null : id);
  };
  for (const d of devices) {
    add(d.ip_address, d.id);
    if (Array.isArray(d.ip_addresses_jsonb)) {
      for (const e of d.ip_addresses_jsonb) {
        if (e && typeof e === 'object' && 'address' in e) add(String((e as { address?: string }).address ?? ''), d.id);
      }
    }
  }
  return new Map([...seen].filter((e): e is [string, number] => e[1] !== null));
}

export function ospfTopologyLinks(
  peers: OspfPeerRow[],
  devices: TopoDevice[],
  existing: LinkRow[],
  externals: ExternalNode[],
): { links: OspfLink[]; externalNodes: ExternalNode[] } {
  const inView = new Map(devices.map((d) => [d.id, d]));
  const byAddress = addressIndex(devices);
  const resolve = (p: OspfPeerRow): number | null => {
    for (const a of [p.remote_id, p.remote_address]) {
      const id = byAddress.get(bare(a));
      if (id != null && id !== p.device_id) return id;
    }
    return null;
  };

  // A shared segment: more than one OSPF neighbour on the interface.
  const perPort = new Map<string, number>();
  for (const p of peers) {
    if (!p.local_interface) continue;
    const k = `${p.device_id}::${p.local_interface}`;
    perPort.set(k, (perPort.get(k) ?? 0) + 1);
  }
  const joined = (a: number, b: number) => existing.some((l) =>
    (l.from_device_id === a && l.to_device_id === b) || (l.from_device_id === b && l.to_device_id === a));
  // Discovery already draws this neighbour on this port (MNDP over EoIP, say).
  const discovered = (p: OspfPeerRow) => existing.some((l) => l.from_device_id === p.device_id
    && l.from_interface === p.local_interface && !!p.remote_address && bare(l.neighbor_address) === bare(p.remote_address));

  const links: OspfLink[] = [];
  const nodes = new Map<string, ExternalNode>();
  const pairs = new Map<string, OspfLink>();
  let n = 0;
  const base = (p: OspfPeerRow): Omit<OspfLink, 'id' | 'to_device_id' | 'to_device_name'> => ({
    from_device_id: p.device_id, from_interface: p.local_interface, to_interface: null,
    neighbor_address: p.remote_address, neighbor_identity: p.remote_id, neighbor_platform: 'OSPF',
    neighbor_mac: null, stp_role: null, stp_state: null, bridge_name: null, neighbor_caps: 'router',
    link_type: 'ospf', discovered_by: null, from_device_name: inView.get(p.device_id)?.name ?? null,
    from_interface_type: p.local_interface_type ?? null,
    link_state: p.up ? 'up' : 'down',
  });

  for (const p of peers) {
    if (!inView.has(p.device_id) || !p.local_interface || !p.remote_id) continue;
    if ((perPort.get(`${p.device_id}::${p.local_interface}`) ?? 0) > 1) continue;
    const to = resolve(p);
    if (to != null) {
      if (!inView.has(to) || joined(p.device_id, to)) continue;
      const key = [p.device_id, to].sort((a, b) => a - b).join('-');
      const other = pairs.get(key);
      if (other) {
        // The far end's report: its interface is this link's far port, and
        // the link is down only when both ends say so... or either does.
        other.to_interface = p.local_interface;
        if (!p.up) other.link_state = 'down';
        continue;
      }
      const link: OspfLink = { ...base(p), id: -(2_000_000 + n++), to_device_id: to, to_device_name: inView.get(to)?.name ?? null };
      pairs.set(key, link);
      links.push(link);
      continue;
    }
    if (discovered(p)) continue;
    const extId = `ext-ospf${p.remote_id.replace(/[^a-z0-9]/gi, '')}`;
    if (!externals.some((e) => e.id === extId) && !nodes.has(extId)) {
      nodes.set(extId, {
        id: extId, name: p.remote_id, address: p.remote_address ?? '', platform: 'OSPF router',
        mac: '', caps: 'router', description: `OSPF router ID ${p.remote_id}`, host: false,
      });
    }
    links.push({ ...base(p), id: -(2_000_000 + n++), to_device_id: null, to_device_name: null, external_id: extId });
  }
  return { links, externalNodes: [...nodes.values()] };
}
