import { auditConfig } from '../configHealth';
import type { DeviceSnapshot } from '../pathModel';
import type { GuardDevice } from '../ChangeGuard';

const device: GuardDevice = {
  id: 1,
  name: 'test-switch',
  ip_address: '192.168.0.40',
  api_port: 8728,
  api_username: 'admin',
  api_password_encrypted: 'x',
};

/**
 * A healthy VLAN-filtering switch: management untagged on VLAN 1 with the bridge
 * explicitly a member, one tagged trunk, no anti-patterns. Every test starts here
 * and breaks exactly one thing, so a rule that fires on the base snapshot is a
 * false positive by construction.
 */
function healthy(over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' }],
    interfaces: [
      { name: 'bridge', type: 'bridge', disabled: 'false', mtu: '1500', l2mtu: '1596' },
      { name: 'sfp28-1', type: 'ether', disabled: 'false', mtu: '1500', l2mtu: '1596' },
      { name: 'ether1', type: 'ether', disabled: 'false', mtu: '1500', l2mtu: '1596' },
    ],
    vlanInterfaces: [],
    bridges: [{ name: 'bridge', 'vlan-filtering': 'true', pvid: '1' }],
    bridgePorts: [
      { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
      { interface: 'ether1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
    ],
    bridgeVlans: [
      { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,sfp28-1,ether1',
        'current-tagged': '', 'current-untagged': 'bridge,sfp28-1,ether1', dynamic: 'false' },
      { bridge: 'bridge', 'vlan-ids': '10', tagged: 'sfp28-1,bridge', untagged: '',
        'current-tagged': 'sfp28-1,bridge', 'current-untagged': '', dynamic: 'false' },
    ],
    bonds: [],
    routes: [{ '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: '192.168.0.1', active: 'true' }],
    arp: [{ address: '192.168.0.1', 'mac-address': 'AA:BB:CC:00:00:01', interface: 'bridge' }],
    bridgeHosts: [{ 'mac-address': 'AA:BB:CC:00:00:01', 'on-interface': 'sfp28-1', local: 'false' }],
    services: [{ '.id': '*3', name: 'api', port: '8728', disabled: 'false' }],
    firewallFilter: [],
    mgmtConnections: [],
    ...over,
  };
}

const rules = (snap: DeviceSnapshot) => auditConfig(snap, device).map((f) => f.rule);

describe('auditConfig', () => {
  it('reports nothing on a correctly configured switch', () => {
    expect(auditConfig(healthy(), device)).toEqual([]);
  });

  describe('ip-on-bridge-port', () => {
    it('flags an address on a bridge slave port', () => {
      const snap = healthy({
        addresses: [
          { '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' },
          { '.id': '*2', address: '10.0.0.1/24', interface: 'ether1', disabled: 'false' },
        ],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'ip-on-bridge-port');
      expect(found?.severity).toBe('critical');
      expect(found?.objects).toContain('ether1');
    });

    /**
     * Taken verbatim from a CRS running 7.23.3: the stock `defconf` address is
     * configured on a slave port and RouterOS relocates it to the bridge. Calling
     * this critical would fire on a default configuration that works fine.
     */
    it('reports a RouterOS-relocated address as informational, not critical', () => {
      const snap = healthy({
        addresses: [{
          '.id': '*1', address: '192.168.0.51/24', interface: 'ether1',
          'actual-interface': 'bridge', slave: 'true', disabled: 'false', invalid: 'false',
          comment: 'defconf',
        }],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'ip-on-bridge-port');
      expect(found?.severity).toBe('info');
      expect(found?.title).toContain('served by bridge');
    });

    it('does not flag an address configured directly on the bridge', () => {
      expect(rules(healthy())).not.toContain('ip-on-bridge-port');
    });

    it('does not flag an address on an inactive bridge port', () => {
      const snap = healthy({
        addresses: [
          { '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' },
          { '.id': '*2', address: '10.0.0.1/24', interface: 'ether1', disabled: 'false' },
        ],
        bridgePorts: [
          { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'ether1', bridge: 'bridge', pvid: '1', disabled: 'false', inactive: 'true' },
        ],
      });
      expect(rules(snap)).not.toContain('ip-on-bridge-port');
    });

    it('does not flag a disabled address', () => {
      const snap = healthy({
        addresses: [
          { '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' },
          { '.id': '*2', address: '10.0.0.1/24', interface: 'ether1', disabled: 'true' },
        ],
      });
      expect(rules(snap)).not.toContain('ip-on-bridge-port');
    });
  });

  describe('vlan-iface-on-bridge-port', () => {
    it('flags a VLAN interface whose parent is a bridge port', () => {
      const snap = healthy({
        vlanInterfaces: [{ name: 'mgmt-vlan', interface: 'ether1', 'vlan-id': '99', disabled: 'false' }],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'vlan-iface-on-bridge-port');
      expect(found?.severity).toBe('critical');
      expect(found?.objects).toEqual(expect.arrayContaining(['mgmt-vlan', 'ether1']));
    });

    it('does not flag a VLAN interface built on the bridge itself', () => {
      const snap = healthy({
        vlanInterfaces: [{ name: 'vlan10', interface: 'bridge', 'vlan-id': '10', disabled: 'false' }],
      });
      expect(rules(snap)).not.toContain('vlan-iface-on-bridge-port');
    });
  });

  describe('bridged-vlan-interface', () => {
    it('flags a VLAN interface added as a bridge port', () => {
      const snap = healthy({
        vlanInterfaces: [{ name: 'vlan10', interface: 'bridge', 'vlan-id': '10', disabled: 'false' }],
        bridgePorts: [
          { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'vlan10', bridge: 'bridge', pvid: '1', disabled: 'false' },
        ],
      });
      expect(rules(snap)).toContain('bridged-vlan-interface');
    });
  });

  describe('bond-slave-is-bridge-port', () => {
    it('flags a bond slave that is also a bridge port', () => {
      const snap = healthy({
        bonds: [{ name: 'bond1', slaves: 'ether1,ether2', disabled: 'false' }],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'bond-slave-is-bridge-port');
      expect(found?.severity).toBe('critical');
      expect(found?.objects).toEqual(expect.arrayContaining(['ether1', 'bond1']));
    });

    it('does not flag a bond whose slaves are outside the bridge', () => {
      const snap = healthy({
        bonds: [{ name: 'bond1', slaves: 'ether7,ether8', disabled: 'false' }],
      });
      expect(rules(snap)).not.toContain('bond-slave-is-bridge-port');
    });
  });

  describe('mtu-exceeds-l2mtu', () => {
    it('flags an MTU above the L2MTU', () => {
      const snap = healthy({
        interfaces: [
          { name: 'bridge', type: 'bridge', disabled: 'false', mtu: '1500', l2mtu: '1596' },
          { name: 'sfp28-1', type: 'ether', disabled: 'false', mtu: '9000', l2mtu: '1596' },
          { name: 'ether1', type: 'ether', disabled: 'false', mtu: '1500', l2mtu: '1596' },
        ],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'mtu-exceeds-l2mtu');
      expect(found?.severity).toBe('warning');
      expect(found?.objects).toContain('sfp28-1');
    });

    it('does not flag when L2MTU is absent', () => {
      const snap = healthy({
        interfaces: [{ name: 'bridge', type: 'bridge', disabled: 'false', mtu: '9000' }],
      });
      expect(rules(snap)).not.toContain('mtu-exceeds-l2mtu');
    });
  });

  describe('multi-vid-untagged', () => {
    it('flags a multi-VLAN entry that lists untagged ports', () => {
      const snap = healthy({
        bridgeVlans: [
          { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,sfp28-1,ether1',
            'current-tagged': '', 'current-untagged': 'bridge,sfp28-1,ether1', dynamic: 'false' },
          { bridge: 'bridge', 'vlan-ids': '20-25', tagged: 'sfp28-1', untagged: 'ether1',
            'current-tagged': 'sfp28-1', 'current-untagged': 'ether1', dynamic: 'false' },
        ],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'multi-vid-untagged');
      expect(found?.severity).toBe('warning');
      expect(found?.detail).toContain('6 VLANs');
    });

    it('does not flag a multi-VLAN entry that is tagged-only', () => {
      const snap = healthy({
        bridgeVlans: [
          { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,sfp28-1,ether1',
            'current-tagged': '', 'current-untagged': 'bridge,sfp28-1,ether1', dynamic: 'false' },
          { bridge: 'bridge', 'vlan-ids': '20-25', tagged: 'sfp28-1', untagged: '',
            'current-tagged': 'sfp28-1', 'current-untagged': '', dynamic: 'false' },
        ],
      });
      expect(rules(snap)).not.toContain('multi-vid-untagged');
    });
  });

  describe('pvid-with-tagged-only-frame-type', () => {
    it('flags a PVID that the frame-type makes inert', () => {
      const snap = healthy({
        bridgePorts: [
          { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'ether1', bridge: 'bridge', pvid: '20', disabled: 'false',
            'frame-types': 'admit-only-vlan-tagged' },
        ],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'pvid-with-tagged-only-frame-type');
      expect(found?.severity).toBe('warning');
      expect(found?.objects).toContain('ether1');
    });

    it('does not flag a tagged-only port left at the default PVID', () => {
      const snap = healthy({
        bridgePorts: [
          { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'ether1', bridge: 'bridge', pvid: '1', disabled: 'false',
            'frame-types': 'admit-only-vlan-tagged' },
        ],
      });
      expect(rules(snap)).not.toContain('pvid-with-tagged-only-frame-type');
    });
  });

  describe('multiple-hw-bridges', () => {
    it('flags two bridges both requesting hardware offload', () => {
      const snap = healthy({
        bridges: [
          { name: 'bridge', 'vlan-filtering': 'true', pvid: '1' },
          { name: 'bridge2', 'vlan-filtering': 'false', pvid: '1' },
        ],
        bridgePorts: [
          { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'ether1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'ether5', bridge: 'bridge2', pvid: '1', disabled: 'false', hw: 'true' },
        ],
      });
      expect(rules(snap)).toContain('multiple-hw-bridges');
    });
  });

  describe('vlan-iface-not-tagged-on-bridge', () => {
    it('flags a VLAN interface whose VLAN the bridge is not tagged in', () => {
      const snap = healthy({
        vlanInterfaces: [{ name: 'vlan30', interface: 'bridge', 'vlan-id': '30', disabled: 'false' }],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'vlan-iface-not-tagged-on-bridge');
      expect(found?.severity).toBe('critical');
      expect(found?.detail).toContain('no bridge VLAN entry for VLAN 30');
    });

    it('does not flag when the bridge is a tagged member', () => {
      const snap = healthy({
        vlanInterfaces: [{ name: 'vlan10', interface: 'bridge', 'vlan-id': '10', disabled: 'false' }],
      });
      expect(rules(snap)).not.toContain('vlan-iface-not-tagged-on-bridge');
    });

    it('does not flag when the bridge has VLAN filtering off', () => {
      const snap = healthy({
        bridges: [{ name: 'bridge', 'vlan-filtering': 'false', pvid: '1' }],
        vlanInterfaces: [{ name: 'vlan30', interface: 'bridge', 'vlan-id': '30', disabled: 'false' }],
      });
      expect(rules(snap)).not.toContain('vlan-iface-not-tagged-on-bridge');
    });
  });

  describe('mgmt-vlan-dynamic-only', () => {
    it('flags management that survives only on a dynamic entry', () => {
      const snap = healthy({
        bridgeVlans: [
          // The PVID-derived row: RouterOS marks it dynamic, and it is the only
          // thing putting the bridge in VLAN 1.
          { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: '',
            'current-tagged': '', 'current-untagged': 'bridge,sfp28-1,ether1', dynamic: 'true' },
          { bridge: 'bridge', 'vlan-ids': '10', tagged: 'sfp28-1,bridge', untagged: '',
            'current-tagged': 'sfp28-1,bridge', 'current-untagged': '', dynamic: 'false' },
        ],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'mgmt-vlan-dynamic-only');
      expect(found?.severity).toBe('warning');
      expect(found?.objects).toEqual(expect.arrayContaining(['bridge', '1']));
    });

    it('does not flag management backed by a static entry', () => {
      expect(rules(healthy())).not.toContain('mgmt-vlan-dynamic-only');
    });
  });

  describe('port-in-no-vlan', () => {
    it('flags an enabled port that belongs to no VLAN', () => {
      const snap = healthy({
        bridgePorts: [
          { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'ether1', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
          { interface: 'ether9', bridge: 'bridge', pvid: '1', disabled: 'false', hw: 'true' },
        ],
      });
      const found = auditConfig(snap, device).find((f) => f.rule === 'port-in-no-vlan');
      expect(found?.objects).toContain('ether9');
    });

    it('does not flag ports on a bridge without VLAN filtering', () => {
      const snap = healthy({
        bridges: [{ name: 'bridge', 'vlan-filtering': 'false', pvid: '1' }],
        bridgeVlans: [],
      });
      expect(rules(snap)).not.toContain('port-in-no-vlan');
    });
  });

  describe('duplicate-address', () => {
    it('flags the same address on two interfaces', () => {
      // On a routed interface outside the bridge, so only this rule can fire.
      const snap = healthy({
        addresses: [
          { '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' },
          { '.id': '*2', address: '192.168.0.40/24', interface: 'ether9', disabled: 'false' },
        ],
      });
      expect(rules(snap)).toEqual(['duplicate-address']);
    });
  });

  it('orders critical findings before warnings', () => {
    const snap = healthy({
      addresses: [
        { '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' },
        { '.id': '*2', address: '10.0.0.1/24', interface: 'ether1', disabled: 'false' },
      ],
      interfaces: [
        { name: 'bridge', type: 'bridge', disabled: 'false', mtu: '1500', l2mtu: '1596' },
        { name: 'sfp28-1', type: 'ether', disabled: 'false', mtu: '9000', l2mtu: '1596' },
        { name: 'ether1', type: 'ether', disabled: 'false', mtu: '1500', l2mtu: '1596' },
      ],
    });
    const found = auditConfig(snap, device);
    expect(found[0].severity).toBe('critical');
    expect(found[found.length - 1].severity).toBe('warning');
  });
});
