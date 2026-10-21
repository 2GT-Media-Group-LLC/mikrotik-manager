/**
 * IPv6 routes (#312), read-only. `/ipv6/route/print` rows trimmed to what the
 * Routes tab shows, with the route type spelled out (blackhole, unreachable,
 * prohibit) since those don't forward. Pure, so it can be tested without a
 * device.
 */
type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export interface Ipv6Route {
  id: string;
  dst: string;
  gateway: string;
  immediateGw: string;
  distance: string;
  table: string;
  active: boolean;
  disabled: boolean;
  dynamic: boolean;
  /** How the route was learned: static, connected, ospf, bgp, ... ('' when unknown). */
  source: string;
  /** blackhole / unreachable / prohibit; '' for a normal unicast route. */
  type: string;
  comment: string;
}

function routeSource(r: Row): string {
  if (isTrue(r['connect'])) return 'connected';
  if (isTrue(r['static'])) return 'static';
  for (const p of ['ospf', 'bgp', 'rip', 'dhcp', 'slaac', 'vpn', 'modem']) if (isTrue(r[p])) return p;
  return '';
}

function routeType(r: Row): string {
  // RouterOS 7 sends blackhole="" on a blackhole route and omits it elsewhere.
  const bh = r['blackhole'];
  if (bh !== undefined && bh !== 'false' && bh !== 'no') return 'blackhole';
  const t = r['type'] || '';
  return t && t !== 'unicast' ? t : '';
}

export function ipv6RoutesView(rows: Row[]): Ipv6Route[] {
  return rows.map((r) => ({
    id: r['.id'] || '',
    dst: r['dst-address'] || '',
    gateway: r['gateway'] || '',
    immediateGw: r['immediate-gw'] || '',
    distance: r['distance'] || '',
    table: (r['routing-table'] || '').trim() || 'main',
    active: isTrue(r['active']),
    disabled: isTrue(r['disabled']),
    dynamic: isTrue(r['dynamic']),
    source: routeSource(r),
    type: routeType(r),
    comment: r['comment'] || '',
  }));
}
