import { ipv6RoutesView } from '../ipv6Routes';

describe('ipv6RoutesView', () => {
  it('maps RouterOS 7 rows', () => {
    const rows = ipv6RoutesView([
      { '.id': '*1', 'dst-address': '::/0', gateway: 'fe80::1%ether1', 'immediate-gw': 'fe80::1%ether1', distance: '1', 'routing-table': 'main', active: 'true', static: 'true', disabled: 'false' },
      { '.id': '*2', 'dst-address': '2001:db8:2::/64', gateway: 'vlan2', distance: '0', 'routing-table': 'main', active: 'true', connect: 'true', dynamic: 'true' },
      { '.id': '*3', 'dst-address': '2001:db8:dead::/48', blackhole: '', 'immediate-gw': '', distance: '1', active: 'true', static: 'true' },
      { '.id': '*4', 'dst-address': '2001:db8:9::/48', gateway: '2001:db8::9', 'routing-table': 'cust-a', active: 'false', disabled: 'true', comment: 'old' },
      { '.id': '*5', 'dst-address': '2001:db8:7::/48', type: 'unreachable', bgp: 'true', dynamic: 'true', active: 'true' },
    ]);
    expect(rows[0]).toMatchObject({ dst: '::/0', gateway: 'fe80::1%ether1', table: 'main', active: true, source: 'static', type: '' });
    expect(rows[1]).toMatchObject({ source: 'connected', dynamic: true });
    expect(rows[2]).toMatchObject({ type: 'blackhole', table: 'main', gateway: '' });
    expect(rows[3]).toMatchObject({ table: 'cust-a', active: false, disabled: true, comment: 'old' });
    expect(rows[4]).toMatchObject({ type: 'unreachable', source: 'bgp' });
  });

  it('treats an older blackhole=true as a blackhole too, and an absent one as unicast', () => {
    const rows = ipv6RoutesView([
      { '.id': '*B', 'dst-address': '2001:db8:b::/48', blackhole: 'true' },
      { '.id': '*U', 'dst-address': '2001:db8:c::/48', gateway: '2001:db8::1' },
    ]);
    expect(rows.map((r) => r.type)).toEqual(['blackhole', '']);
  });

  it('handles RouterOS 6 rows without a routing table', () => {
    const [r] = ipv6RoutesView([{ '.id': '*A', 'dst-address': '::/0', gateway: '2001:db8::1', distance: '1', active: 'true', static: 'true' }]);
    expect(r).toMatchObject({ table: 'main', source: 'static' });
  });
});
