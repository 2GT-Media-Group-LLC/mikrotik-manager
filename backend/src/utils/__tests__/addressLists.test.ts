import { clientAddressListView } from '../addressLists';

describe('clientAddressListView (#145)', () => {
  const entries: Record<string, string>[] = [
    { '.id': '*1', list: 'wan2', address: '192.168.1.50', comment: 'Office PC' },
    { '.id': '*2', list: 'dmz', address: '192.168.1.60' },
    { '.id': '*3', list: 'port-scanners', address: '192.168.1.50', dynamic: 'true', timeout: '23h59m' },
    { '.id': '*4', list: 'mgmt', address: '192.168.1.10' },
  ];
  const rules: Record<string, string>[] = [
    { chain: 'prerouting', 'src-address-list': 'wan2', action: 'mark-routing' },
    { chain: 'input', 'src-address-list': '!mgmt', action: 'drop' },
    { chain: 'forward', 'dst-address-list': 'dmz', action: 'accept', disabled: 'true' },
  ];
  const leases: Record<string, string>[] = [{ address: '192.168.1.50', dynamic: 'true', 'host-name': 'office-pc' }];

  it('lists every list, the client\'s entries, and which lists rules use', () => {
    const v = clientAddressListView(entries, rules, leases, '192.168.1.50');
    expect(v.lists).toEqual(['dmz', 'mgmt', 'port-scanners', 'wan2']);
    expect(v.member).toEqual([
      { list: 'wan2', id: '*1', dynamic: false, disabled: false, comment: 'Office PC', timeout: null },
      { list: 'port-scanners', id: '*3', dynamic: true, disabled: false, comment: null, timeout: '23h59m' },
    ]);
    // A negated match counts; a disabled rule doesn't.
    expect(v.referenced).toEqual(['mgmt', 'wan2']);
    expect(v.lease).toEqual({ static: false, host: 'office-pc' });
  });

  it('reports a static lease, or none', () => {
    expect(clientAddressListView(entries, rules, [{ address: '192.168.1.60', dynamic: 'false' }], '192.168.1.60').lease).toEqual({ static: true, host: null });
    expect(clientAddressListView(entries, rules, [], '10.0.0.1').lease).toBeNull();
  });
});
