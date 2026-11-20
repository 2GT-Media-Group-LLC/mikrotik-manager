/**
 * What a saved topology map key refers to. The map's arrangement, link colours,
 * hidden links and neighbour names are stored by the ids the map draws with:
 * "12" (a device), "node-3", "hand-4", "ext-…", "clients-12", "client-<mac>",
 * the edge ids built from those ("cgedge-12", "cedge-<mac>", "cvedge-clients-12:vlan:10")
 * and "cable:<end>@<port>|<end>@<port>[.n]". A site-scoped account may only see
 * and change the entries whose every end is in its own sites (P1-7).
 */

export type KeyEnd =
  | { kind: 'device'; id: number }
  | { kind: 'node'; id: number }
  | { kind: 'hand'; id: number }
  | { kind: 'client'; mac: string }
  | { kind: 'ext'; id: string }
  | { kind: 'unknown' };

function endOf(token: string): KeyEnd {
  let t = token;
  // Edge ids name the node they lead to.
  const edge = /^(cgedge|hostedge|cvedge|cedge)-(.+)$/.exec(t);
  if (edge) {
    if (edge[1] === 'cedge') return { kind: 'client', mac: edge[2].toLowerCase() };
    t = edge[2];
  }
  let m: RegExpExecArray | null;
  if (/^\d{1,9}$/.test(t)) return { kind: 'device', id: Number(t) };
  if ((m = /^clients-(\d{1,9})(?=$|:vlan:)/.exec(t))) return { kind: 'device', id: Number(m[1]) };
  if ((m = /^node-(\d{1,9})$/.exec(t))) return { kind: 'node', id: Number(m[1]) };
  if ((m = /^hand-(\d{1,9})$/.exec(t))) return { kind: 'hand', id: Number(m[1]) };
  if ((m = /^client-(.+)$/.exec(t))) return { kind: 'client', mac: m[1].toLowerCase() };
  if (/^ext-[a-z0-9]{1,150}$/i.test(t)) return { kind: 'ext', id: t };
  return { kind: 'unknown' };
}

/** The ends a key names: two for a discovered cable, one for anything else. */
export function topologyKeyEnds(key: string): KeyEnd[] {
  if (!key.startsWith('cable:')) return [endOf(key)];
  return key.slice('cable:'.length).split('|').map((end) => endOf(end.split('@')[0]));
}

/** What a site-scoped account can reach on the map. */
export interface MapReach {
  devices: Set<number>;
  nodes: Set<number>;
  hands: Set<number>;
  clients: Set<string>;
  /** Neighbour ids on its map; null where they aren't known (writes), when any ext id passes. */
  ext: Set<string> | null;
}

export function keyInReach(key: string, reach: MapReach): boolean {
  return topologyKeyEnds(key).every((e) => {
    switch (e.kind) {
      case 'device': return reach.devices.has(e.id);
      case 'node': return reach.nodes.has(e.id);
      case 'hand': return reach.hands.has(e.id);
      case 'client': return reach.clients.has(e.mac);
      case 'ext': return reach.ext === null || reach.ext.has(e.id);
      default: return false;
    }
  });
}
