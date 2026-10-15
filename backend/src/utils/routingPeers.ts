/**
 * BGP peers and OSPF neighbours across the fleet (#279): what one device's
 * RouterOS output says about each, in one shape. Pure, so the real output
 * captured from a lab pair is the test fixture.
 *
 * BGP: one row per configured connection (RouterOS 7) or peer (6), up when a
 * session for it is established. OSPF: neighbours exist only while RouterOS
 * hears them, so one that drops simply vanishes; the store keeps the last row
 * and marks it down (see DeviceCollector.collectRoutingPeers).
 */
type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export interface RoutingPeer {
  protocol: 'bgp' | 'ospf';
  /** Stable per device: the connection name, or instance + neighbour router id. */
  key: string;
  name: string;
  remoteAddress: string | null;
  remoteAs: string | null;
  remoteId: string | null;
  instance: string | null;
  /** OSPF area and interface; for BGP, the local role (ibgp, ebgp…). */
  detail: string | null;
  state: string;
  up: boolean;
  disabled: boolean;
  /** RouterOS duration: session uptime or OSPF adjacency time. */
  uptime: string | null;
  prefixCount: number | null;
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

export function routingPeersFrom(input: {
  bgpConnections: Row[]; bgpSessions: Row[]; ospfNeighbors: Row[];
}): RoutingPeer[] {
  const out: RoutingPeer[] = [];

  for (const c of input.bgpConnections) {
    const name = c['name'] || c['remote.address'] || c['remote-address'] || '';
    if (!name) continue;
    const disabled = isTrue(c['disabled']);
    const remoteAddress = c['remote.address'] || c['remote-address'] || null;
    // RouterOS 6: the peer row carries its own state.
    if (c['state'] !== undefined && c['remote-address'] !== undefined) {
      const state = c['state'] || 'idle';
      out.push({
        protocol: 'bgp', key: name, name, remoteAddress, remoteAs: c['remote-as'] || null, remoteId: c['remote-id'] || null,
        instance: c['instance'] || null, detail: null, state: disabled ? 'disabled' : state,
        up: !disabled && state === 'established', disabled, uptime: c['uptime'] || null, prefixCount: num(c['prefix-count']),
      });
      continue;
    }
    // RouterOS 7: sessions are named after their connection, "name-1".
    const own = (s: Row) => {
      const n = s['name'] || '';
      return n.startsWith(`${name}-`) && /^\d+$/.test(n.slice(name.length + 1));
    };
    const session = input.bgpSessions.find(own)
      ?? input.bgpSessions.find((s) => remoteAddress && s['remote.address'] === remoteAddress && (!c['instance'] || s['instance'] === c['instance']));
    const established = !!session && isTrue(session['established']);
    out.push({
      protocol: 'bgp', key: name, name, remoteAddress,
      remoteAs: c['remote.as'] || session?.['remote.as'] || null,
      remoteId: session?.['remote.id'] || null,
      instance: c['instance'] || null,
      detail: c['local.role'] || null,
      state: disabled ? 'disabled' : established ? 'established' : session ? 'connecting' : 'idle',
      up: !disabled && established, disabled,
      uptime: established ? session?.['uptime'] || null : null,
      prefixCount: established ? num(session?.['prefix-count']) : null,
    });
  }

  for (const n of input.ospfNeighbors) {
    const id = n['router-id'] || n['address'];
    if (!id) continue;
    const instance = n['instance'] || null;
    const state = n['state'] || 'unknown';
    out.push({
      protocol: 'ospf', key: `${instance ?? ''}|${id}`, name: id, remoteAddress: n['address'] || null, remoteAs: null,
      remoteId: n['router-id'] || null, instance,
      detail: [n['area'], n['interface']].filter(Boolean).join(' · ') || null,
      // Full is a complete adjacency; 2-Way is normal between two non-DR routers on a LAN.
      state, up: /^full$/i.test(state) || /^2-?way$/i.test(state), disabled: false,
      uptime: n['adjacency'] || null, prefixCount: null,
    });
  }
  return out;
}
