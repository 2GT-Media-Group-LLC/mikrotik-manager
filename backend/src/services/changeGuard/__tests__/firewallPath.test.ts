import { evaluateInputChain, addressMatches, portMatches, ruleMatches, referencedAddressLists, type MgmtConnection } from '../firewallPath';
import { analyzeChange } from '../analyzeChange';
import type { DeviceSnapshot, RosRow } from '../pathModel';
import type { GuardDevice } from '../ChangeGuard';

const device: GuardDevice = {
  id: 1, name: 'test-switch', ip_address: '192.168.0.40', api_port: 8728,
  api_username: 'admin', api_password_encrypted: 'x',
};

const conn: MgmtConnection = { srcIp: '10.9.0.5', dstIp: '192.168.0.40', dstPort: 8728, inInterface: 'bridge' };

/** A device reached on its bridge by a manager at 10.9.0.5, per connection tracking. */
function snapshot(filter: RosRow[], over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' }],
    interfaces: [
      { name: 'bridge', type: 'bridge', disabled: 'false' },
      { name: 'ether1', type: 'ether', disabled: 'false' },
      { name: 'ether2', type: 'ether', disabled: 'false' },
    ],
    vlanInterfaces: [],
    bridges: [{ name: 'bridge', 'vlan-filtering': 'false', pvid: '1' }],
    bridgePorts: [{ interface: 'ether2', bridge: 'bridge', pvid: '1', disabled: 'false' }],
    bridgeVlans: [],
    bonds: [],
    routes: [{ '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: '192.168.0.1', active: 'true' }],
    arp: [{ address: '192.168.0.1', 'mac-address': 'AA:BB:CC:00:00:01', interface: 'bridge' }],
    bridgeHosts: [{ 'mac-address': 'AA:BB:CC:00:00:01', 'on-interface': 'ether2', local: 'false' }],
    services: [{ '.id': '*1', name: 'api', port: '8728', disabled: 'false' }],
    firewallFilter: filter,
    mgmtConnections: [{ protocol: 'tcp', 'src-address': '10.9.0.5:51000', 'dst-address': '192.168.0.40:8728' }],
    interfaceLists: [{ name: 'LAN' }, { name: 'WAN' }],
    interfaceListMembers: [
      { list: 'LAN', interface: 'bridge', disabled: 'false' },
      { list: 'WAN', interface: 'ether1', disabled: 'false' },
    ],
    addressLists: [],
    addressListsRead: [],
    ...over,
  };
}

/** RouterOS's default input chain (defconf), trimmed to what matters here. */
const DEFCONF: RosRow[] = [
  { '.id': '*1', chain: 'input', action: 'accept', 'connection-state': 'established,related,untracked', comment: 'defconf: accept established,related,untracked' },
  { '.id': '*2', chain: 'input', action: 'drop', 'connection-state': 'invalid', comment: 'defconf: drop invalid' },
  { '.id': '*3', chain: 'input', action: 'accept', protocol: 'icmp', comment: 'defconf: accept ICMP' },
  { '.id': '*4', chain: 'input', action: 'drop', 'in-interface-list': '!LAN', comment: 'defconf: drop all not coming from LAN' },
  { '.id': '*5', chain: 'forward', action: 'drop', 'connection-state': 'invalid' },
];

describe('address and port matching', () => {
  it('matches single addresses, CIDRs and ranges', () => {
    expect(addressMatches('10.9.0.5', '10.9.0.5')).toBe('yes');
    expect(addressMatches('10.9.0.0/16', '10.9.0.5')).toBe('yes');
    expect(addressMatches('10.8.0.0/16', '10.9.0.5')).toBe('no');
    expect(addressMatches('10.9.0.1-10.9.0.9', '10.9.0.5')).toBe('yes');
    expect(addressMatches('0.0.0.0/0', '10.9.0.5')).toBe('yes');
  });

  it('answers maybe for what it cannot evaluate', () => {
    expect(addressMatches('example.com', '10.9.0.5')).toBe('maybe');
    expect(addressMatches('10.9.0.0/16', null)).toBe('maybe');
    expect(portMatches('ssh', 22)).toBe('maybe');
  });

  it('matches port lists and ranges', () => {
    expect(portMatches('8728', 8728)).toBe('yes');
    expect(portMatches('22,8291', 8728)).toBe('no');
    expect(portMatches('8000-9000', 8728)).toBe('yes');
  });

  it('honours negation', () => {
    const snap = snapshot([]);
    expect(ruleMatches({ chain: 'input', 'src-address': '!10.9.0.0/16' }, conn, snap)).toBe('no');
    expect(ruleMatches({ chain: 'input', 'in-interface-list': '!LAN' }, conn, snap)).toBe('no');
    expect(ruleMatches({ chain: 'input', 'in-interface-list': '!WAN' }, conn, snap)).toBe('yes');
  });
});

describe('evaluateInputChain', () => {
  it('lets the manager in through the default config (the old check flagged it)', () => {
    const v = evaluateInputChain(snapshot(DEFCONF), conn);
    expect(v.outcome).toBe('accepted');
  });

  it('drops a manager arriving on a WAN interface under the default config', () => {
    const v = evaluateInputChain(snapshot(DEFCONF), { ...conn, inInterface: 'ether1' });
    expect(v.outcome).toBe('dropped');
    expect(v.ruleIndex).toBe(3);
  });

  it('respects order: an accept above a drop-all wins', () => {
    const filter: RosRow[] = [
      { '.id': '*a', chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '8728' },
      { '.id': '*d', chain: 'input', action: 'drop' },
    ];
    expect(evaluateInputChain(snapshot(filter), conn).outcome).toBe('accepted');
    expect(evaluateInputChain(snapshot([...filter].reverse()), conn).outcome).toBe('dropped');
  });

  it('ignores disabled rules and other chains', () => {
    const filter: RosRow[] = [
      { '.id': '*d', chain: 'input', action: 'drop', disabled: 'true' },
      { '.id': '*f', chain: 'forward', action: 'drop' },
    ];
    expect(evaluateInputChain(snapshot(filter), conn).outcome).toBe('accepted');
  });

  it('is unknown, not dropped, when an earlier rule might accept', () => {
    const filter: RosRow[] = [
      { '.id': '*a', chain: 'input', action: 'accept', 'tcp-flags': 'syn' },
      { '.id': '*d', chain: 'input', action: 'drop' },
    ];
    expect(evaluateInputChain(snapshot(filter), conn).outcome).toBe('unknown');
  });

  it('follows jumps into custom chains', () => {
    const filter: RosRow[] = [
      { '.id': '*j', chain: 'input', action: 'jump', 'jump-target': 'mgmt' },
      { '.id': '*m', chain: 'mgmt', action: 'accept', 'src-address': '10.9.0.0/16' },
      { '.id': '*d', chain: 'input', action: 'drop' },
    ];
    expect(evaluateInputChain(snapshot(filter), conn).outcome).toBe('accepted');
  });

  it('uses address-list membership when the list was read', () => {
    const filter: RosRow[] = [
      { '.id': '*a', chain: 'input', action: 'accept', 'src-address-list': 'mgmt' },
      { '.id': '*d', chain: 'input', action: 'drop' },
    ];
    const read = { addressLists: [{ '.id': '*L1', list: 'mgmt', address: '10.9.0.0/24' }], addressListsRead: ['mgmt'] };
    expect(evaluateInputChain(snapshot(filter, read), conn).outcome).toBe('accepted');
    // A list that couldn't be read can't say no.
    expect(evaluateInputChain(snapshot(filter), conn).outcome).toBe('unknown');
  });

  it('does not apply the IPv4 filter to a manager on IPv6', () => {
    const v = evaluateInputChain(snapshot([{ '.id': '*d', chain: 'input', action: 'drop' }]), { ...conn, dstIp: '2001:db8::40' });
    expect(v.outcome).toBe('accepted');
  });

  it('reads address lists named by disabled rules too', () => {
    expect(referencedAddressLists([
      { chain: 'input', 'src-address-list': 'a' },
      { chain: 'input', 'src-address-list': '!b', disabled: 'true' },
    ]).sort()).toEqual(['a', 'b']);
  });
});

// The scenarios from outside review P2-8.
describe('analyzeChange for firewall edits', () => {
  const staged: RosRow[] = [
    ...DEFCONF.slice(0, 3),
    { '.id': '*m', chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '8728', comment: 'manager' },
    { '.id': '*x', chain: 'input', action: 'drop', disabled: 'true', comment: 'staged drop-all' },
  ];

  it('catches enabling a staged drop that only sends disabled=no', () => {
    const lockout: RosRow[] = [
      ...DEFCONF.slice(0, 3),
      { '.id': '*x', chain: 'input', action: 'drop', disabled: 'true', comment: 'staged drop-all' },
      { '.id': '*m', chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '8728' },
    ];
    const v = analyzeChange(snapshot(lockout), device, { kind: 'firewall.set', ruleId: '*x', fields: { disabled: 'no' } });
    expect(v.severity).toBe('critical');
    expect(v.violations[0].detail).toMatch(/staged drop-all/);
  });

  it('allows enabling the same drop when the manager is accepted above it', () => {
    const v = analyzeChange(snapshot(staged), device, { kind: 'firewall.set', ruleId: '*x', fields: { disabled: 'no' } });
    expect(v.severity).toBe('safe');
  });

  it('catches moving a drop above the rule that accepts the manager', () => {
    const on = staged.map((r) => (r['.id'] === '*x' ? { ...r, disabled: 'false' } : r));
    const v = analyzeChange(snapshot(on), device, { kind: 'firewall.move', ruleId: '*x', destination: '*m' });
    expect(v.severity).toBe('critical');
  });

  it('catches deleting the rule that accepts the manager', () => {
    const on = staged.map((r) => (r['.id'] === '*x' ? { ...r, disabled: 'false' } : r));
    const v = analyzeChange(snapshot(on), device, { kind: 'firewall.remove', ruleId: '*m' });
    expect(v.severity).toBe('critical');
  });

  it('catches removing the manager from the address list it is accepted by', () => {
    const filter: RosRow[] = [
      { '.id': '*a', chain: 'input', action: 'accept', 'src-address-list': 'mgmt' },
      { '.id': '*d', chain: 'input', action: 'drop' },
    ];
    const snap = snapshot(filter, {
      addressLists: [{ '.id': '*L1', list: 'mgmt', address: '10.9.0.5' }],
      addressListsRead: ['mgmt'],
    });
    const v = analyzeChange(snap, device, { kind: 'address-list.remove', entryId: '*L1' });
    expect(v.severity).toBe('critical');
  });

  it('catches appending a drop-all to the default config, which relies on the default accept for LAN', () => {
    const v = analyzeChange(snapshot(DEFCONF), device, { kind: 'firewall.add', fields: { chain: 'input', action: 'drop' } });
    expect(v.severity).toBe('critical');
  });

  it('allows appending a drop-all below a rule that accepts the manager', () => {
    const v = analyzeChange(snapshot(staged), device, { kind: 'firewall.add', fields: { chain: 'input', action: 'drop' } });
    expect(v.severity).toBe('safe');
  });

  it('warns, and so requires auto-revert, when the result depends on something unmodelled', () => {
    const v = analyzeChange(snapshot(staged), device, {
      kind: 'firewall.add', placeBefore: '*m', fields: { chain: 'input', action: 'drop', 'tcp-flags': 'syn' },
    });
    expect(v.severity).toBe('warning');
  });

  it('warns about unsimulated changes to objects on the management path', () => {
    const v = analyzeChange(snapshot(DEFCONF), device, { kind: 'path-object.change', name: 'ether2', what: 'Changing speed' });
    expect(v.severity).toBe('warning');
    const off = analyzeChange(snapshot(DEFCONF), device, { kind: 'path-object.change', name: 'ether1', what: 'Changing speed' });
    expect(off.severity).toBe('safe');
  });

  it('simulates a batch in order', () => {
    const v = analyzeChange(snapshot(staged), device, {
      kind: 'batch',
      changes: [
        { kind: 'firewall.set', ruleId: '*x', fields: { disabled: 'no' } },
        { kind: 'firewall.move', ruleId: '*x', destination: '*m' },
      ],
    });
    expect(v.severity).toBe('critical');
  });
});
