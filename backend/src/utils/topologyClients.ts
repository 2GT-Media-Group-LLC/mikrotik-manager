/**
 * Client devices on the topology map (#147): laptops, phones and the like,
 * attached to the switch port or access point they really connect through.
 *
 * One client is usually seen by several devices at once. The router sees it
 * in ARP on a bridge or VLAN interface, every switch between them learns its
 * MAC on whichever port leads towards it, and an AP has it in its registration
 * table. Only one of those is where it's plugged in:
 *
 *   1. an access point's registration table (wireless): it is associated there;
 *   2. a switch port with no neighbour behind it: an access port;
 *   3. a port facing a neighbour the manager doesn't manage (an unmanaged
 *      switch seen over LLDP): the client is behind that neighbour, and the map
 *      draws it there;
 *   4. anything else (ARP on a bridge, a port facing another managed device)
 *      says only that the client is somewhere downstream. Used as a last
 *      resort, marked as an unknown port.
 */

export interface ClientSighting {
  mac_address: string;
  device_id: number;
  interface_name: string | null;
  client_type: string | null;
  last_seen: string | null;
  hostname: string | null;
  custom_name: string | null;
  ip_address: string | null;
  vendor: string | null;
}

export interface TopoClient {
  mac: string;
  name: string;
  ip: string | null;
  deviceId: number;
  interface: string | null;
  wireless: boolean;
  /** False when only ARP or an uplink saw it, so the attachment is a guess. */
  portKnown: boolean;
  /** Seen on a port facing an unmanaged neighbour: it is behind that neighbour. */
  behindNeighbour: boolean;
}

/** A port a client can be plugged into, rather than a bridge, VLAN or tunnel. */
export function isPortLike(name: string | null, type?: string | null): boolean {
  if (type) return ['ether', 'wlan', 'wifi', 'bond', 'cap'].includes(type);
  return !!name && /^(ether|sfp|qsfp|combo|wlan|wifi|bond)/i.test(name);
}

const key = (deviceId: number, iface: string | null) => `${deviceId}:${(iface ?? '').toLowerCase()}`;

/**
 * One attachment per MAC. `uplinks` holds device:port pairs that face another
 * managed device (a client seen there is further along), `neighbourPorts` those
 * facing a neighbour the manager doesn't manage, and `portTypes` the interface
 * type of each device:port, when known.
 */
export function clientAttachments(
  sightings: ClientSighting[],
  uplinks: Set<string>,
  portTypes: Map<string, string>,
  neighbourPorts: Set<string> = new Set(),
): TopoClient[] {
  const byMac = new Map<string, ClientSighting[]>();
  for (const s of sightings) {
    const mac = s.mac_address.toUpperCase();
    if (!byMac.has(mac)) byMac.set(mac, []);
    byMac.get(mac)!.push(s);
  }
  const rank = (s: ClientSighting): number => {
    if (s.client_type === 'wireless') return 0;
    const k = key(s.device_id, s.interface_name);
    if (uplinks.has(k) || !isPortLike(s.interface_name, portTypes.get(k))) return 3;
    return neighbourPorts.has(k) ? 2 : 1;
  };
  const out: TopoClient[] = [];
  for (const [mac, list] of byMac) {
    const best = [...list].sort((a, b) =>
      rank(a) - rank(b) || (Date.parse(b.last_seen ?? '') || 0) - (Date.parse(a.last_seen ?? '') || 0))[0];
    const r = rank(best);
    out.push({
      mac,
      name: (best.custom_name || best.hostname || best.vendor || mac).trim(),
      ip: best.ip_address,
      deviceId: best.device_id,
      interface: best.interface_name,
      wireless: best.client_type === 'wireless',
      portKnown: r < 3,
      behindNeighbour: r === 2,
    });
  }
  return out.sort((a, b) => a.deviceId - b.deviceId || a.name.localeCompare(b.name));
}
