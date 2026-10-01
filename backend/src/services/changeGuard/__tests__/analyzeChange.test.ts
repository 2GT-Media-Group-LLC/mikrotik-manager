import { analyzeChange, simulate, type PlannedChange } from '../analyzeChange';
import { resolveManagementPath, vlanMembership, expandVlanIds, type DeviceSnapshot } from '../pathModel';
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
 * Mirrors the real switch this was validated against: management is untagged on
 * VLAN 1, the address sits on the bridge (the CPU port), and the manager is
 * off-subnet so its traffic enters via the default gateway's port.
 */
function baseSnapshot(over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'bridge', disabled: 'false' }],
    interfaces: [
      { name: 'bridge', type: 'bridge', disabled: 'false' },
      { name: 'sfp28-1', type: 'ether', disabled: 'false' },
      { name: 'ether1', type: 'ether', disabled: 'false' },
    ],
    vlanInterfaces: [],
    bridges: [{ name: 'bridge', 'vlan-filtering': 'true', pvid: '1' }],
    bridgePorts: [
      { interface: 'sfp28-1', bridge: 'bridge', pvid: '1', disabled: 'false' },
      { interface: 'ether1', bridge: 'bridge', pvid: '1', disabled: 'false' },
    ],
    bridgeVlans: [
      { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,sfp28-1,ether1',
        'current-tagged': '', 'current-untagged': 'bridge,sfp28-1,ether1' },
      { bridge: 'bridge', 'vlan-ids': '10', tagged: 'sfp28-1', untagged: '',
        'current-tagged': 'sfp28-1', 'current-untagged': '' },
    ],
    bonds: [],
    routes: [
      { '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: '192.168.0.1', active: 'true' },
      { '.id': '*B', 'dst-address': '192.168.0.0/24', gateway: 'bridge', active: 'true' },
    ],
    arp: [{ address: '192.168.0.1', 'mac-address': 'B4:FB:E4:0B:0B:8A', interface: 'bridge' }],
    bridgeHosts: [{ 'mac-address': 'B4:FB:E4:0B:0B:8A', 'on-interface': 'sfp28-1', local: 'false' }],
    services: [{ '.id': '*1', name: 'api', port: '8728', disabled: 'false' }],
    firewallFilter: [],
    mgmtConnections: [],
    ...over,
  };
}

describe('expandVlanIds', () => {
  it('handles single ids, lists and ranges', () => {
    expect(expandVlanIds('10')).toEqual([10]);
    expect(expandVlanIds('10,20')).toEqual([10, 20]);
    expect(expandVlanIds('10-12')).toEqual([10, 11, 12]);
    expect(expandVlanIds('1,5-7')).toEqual([1, 5, 6, 7]);
    expect(expandVlanIds(undefined)).toEqual([]);
  });
});

describe('vlanMembership', () => {
  it('prefers effective current-* membership over the static lists', () => {
    const snap = baseSnapshot({
      bridgeVlans: [{ bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: '',
        'current-tagged': '', 'current-untagged': 'bridge' }],
    });
    const m = vlanMembership(snap, 'bridge', 1);
    expect(m.found).toBe(true);
    expect(m.untagged).toContain('bridge');
  });
});

describe('resolveManagementPath', () => {
  it('resolves the untagged-on-bridge case, finding the ingress port via the default gateway', () => {
    const path = resolveManagementPath(baseSnapshot(), device);
    expect(path.mgmtInterface).toBe('bridge');
    expect(path.bridge).toBe('bridge');
    expect(path.bridgeVlanFiltering).toBe(true);
    expect(path.taggedManagement).toBe(false);
    expect(path.mgmtVlanId).toBe(1);
    expect(path.ingressPort).toBe('sfp28-1');
    expect(path.ingressPortSource).toBe('fdb-default-gw');
  });

  it('resolves a tagged VLAN sub-interface onto its parent bridge', () => {
    const snap = baseSnapshot({
      addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'vlan99', disabled: 'false' }],
      vlanInterfaces: [{ name: 'vlan99', 'vlan-id': '99', interface: 'bridge' }],
      interfaces: [
        { name: 'bridge', type: 'bridge', disabled: 'false' },
        { name: 'vlan99', type: 'vlan', disabled: 'false' },
        { name: 'sfp28-1', type: 'ether', disabled: 'false' },
      ],
    });
    const path = resolveManagementPath(snap, device);
    expect(path.taggedManagement).toBe(true);
    expect(path.mgmtVlanId).toBe(99);
    expect(path.bridge).toBe('bridge');
  });

  it('reports honestly when the ingress port cannot be determined', () => {
    const path = resolveManagementPath(baseSnapshot({ arp: [], bridgeHosts: [] }), device);
    expect(path.ingressPort).toBeNull();
    expect(path.ingressPortSource).toBe('unknown');
    expect(path.warnings.join(' ')).toMatch(/could not determine which port/i);
  });
});

describe('analyzeChange — the VLAN lockout (golden case)', () => {
  it('flags removing the bridge from the management VLAN as critical', () => {
    // Exactly the incident: VLAN 1 membership rewritten without the bridge (CPU port).
    const change: PlannedChange = {
      kind: 'vlan.update', bridge: 'bridge', vlanId: 1,
      tagged: [], untagged: ['sfp28-1', 'ether1'],
    };
    const v = analyzeChange(baseSnapshot(), device, change);
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('bridge-untagged-member');
    expect(v.violations[0].detail).toMatch(/untagged member of VLAN 1/i);
  });

  it('flags moving the ingress port PVID off the management VLAN', () => {
    const change: PlannedChange = {
      kind: 'port.vlan', port: 'sfp28-1', pvid: 99, tagged: [], untagged: [],
    };
    const v = analyzeChange(baseSnapshot(), device, change);
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('ingress-port-pvid');
  });

  it('flags making the management port tagged-only, which the PVID alone does not', () => {
    // Added with #151: frame admission was never written, so the predictor had
    // nothing to model. admit-only-vlan-tagged on the port carrying untagged
    // management traffic strands it even though every VLAN row still lists it.
    const change: PlannedChange = {
      kind: 'port.vlan', port: 'sfp28-1', pvid: 1, tagged: [], untagged: [], mode: 'trunk',
    };
    const v = analyzeChange(baseSnapshot(), device, change);
    expect(v.severity).toBe('critical');
  });

  it('does not flag the same change when frame admission is left alone', () => {
    // No mode means pre-0.24.20 behaviour: PVID and membership only. Inventing a
    // violation here would block edits that were always safe.
    const change: PlannedChange = {
      kind: 'port.vlan', port: 'sfp28-1', pvid: 1, tagged: [], untagged: [],
    };
    expect(analyzeChange(baseSnapshot(), device, change).severity).not.toBe('critical');
  });

  describe('replaceTagged (#165: unticking a VLAN now removes it)', () => {
    const taggedMgmt = () => baseSnapshot({
      addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'vlan99', disabled: 'false' }],
      vlanInterfaces: [{ name: 'vlan99', 'vlan-id': '99', interface: 'bridge' }],
      interfaces: [
        { name: 'bridge', type: 'bridge', disabled: 'false' },
        { name: 'vlan99', type: 'vlan', disabled: 'false' },
        { name: 'sfp28-1', type: 'ether', disabled: 'false' },
        { name: 'ether1', type: 'ether', disabled: 'false' },
      ],
      bridgeVlans: [
        { '.id': '*1', bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,sfp28-1,ether1' },
        { '.id': '*2', bridge: 'bridge', 'vlan-ids': '10', tagged: 'sfp28-1', untagged: '' },
        { '.id': '*3', bridge: 'bridge', 'vlan-ids': '99', tagged: 'bridge,sfp28-1', untagged: '' },
      ],
    });

    it('models the removal, so unticking the management VLAN is caught', () => {
      const change: PlannedChange = {
        kind: 'port.vlan', port: 'sfp28-1', pvid: 1, tagged: [10], untagged: [], mode: 'trunk', replaceTagged: true,
      };
      const after = simulate(taggedMgmt(), change);
      expect(after.bridgeVlans.find((r) => r['vlan-ids'] === '99')?.['tagged']).toBe('bridge');
      expect(analyzeChange(taggedMgmt(), device, change).severity).toBe('critical');
    });

    it('is safe when only an unrelated VLAN is unticked', () => {
      const change: PlannedChange = {
        kind: 'port.vlan', port: 'sfp28-1', pvid: 1, tagged: [99], untagged: [], mode: 'trunk', replaceTagged: true,
      };
      const after = simulate(taggedMgmt(), change);
      expect(after.bridgeVlans.find((r) => r['vlan-ids'] === '10')?.['tagged']).toBe('');
      expect(analyzeChange(taggedMgmt(), device, change).severity).not.toBe('critical');
    });

    it('stays add-only without the flag', () => {
      const change: PlannedChange = {
        kind: 'port.vlan', port: 'sfp28-1', pvid: 1, tagged: [], untagged: [], mode: 'trunk',
      };
      const after = simulate(taggedMgmt(), change);
      expect(after.bridgeVlans.find((r) => r['vlan-ids'] === '99')?.['tagged']).toBe('bridge,sfp28-1');
    });
  });

  it('flags deleting the management VLAN entirely', () => {
    const v = analyzeChange(baseSnapshot(), device, { kind: 'vlan.delete', bridge: 'bridge', vlanId: 1 });
    expect(v.severity).toBe('critical');
  });

  it('allows an unrelated VLAN edit', () => {
    const change: PlannedChange = {
      kind: 'vlan.update', bridge: 'bridge', vlanId: 10, tagged: ['sfp28-1', 'ether1'], untagged: [],
    };
    expect(analyzeChange(baseSnapshot(), device, change).severity).toBe('safe');
  });

  it('allows adding a brand-new unused VLAN', () => {
    const change: PlannedChange = {
      kind: 'vlan.add', bridge: 'bridge', vlanId: 4000, tagged: [], untagged: [],
    };
    expect(analyzeChange(baseSnapshot(), device, change).severity).toBe('safe');
  });
});

describe('analyzeChange — real-hardware shapes', () => {
  /**
   * Taken from the live switch: the ingress port is a TAGGED trunk member of the
   * management VLAN while also accepting untagged frames via its PVID, and the
   * bridge's untagged membership comes from a dynamic "added by pvid" row
   * alongside the static one. An earlier version demanded the ingress port be
   * *untagged*, which flagged this healthy config and — because pre-existing
   * violations are not re-reported — silently suppressed real detections.
   */
  function trunkSnapshot(): DeviceSnapshot {
    return baseSnapshot({
      bridgeVlans: [
        { bridge: 'bridge', 'vlan-ids': '1', tagged: 'all', untagged: 'bridge',
          'current-tagged': 'sfp28-1', 'current-untagged': 'bridge', dynamic: 'false' },
        { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge',
          'current-tagged': '', 'current-untagged': 'bridge', dynamic: 'true', comment: 'added by pvid' },
      ],
    });
  }

  it('treats a tagged trunk ingress port with a matching PVID as healthy', () => {
    const v = analyzeChange(trunkSnapshot(), device, {
      kind: 'vlan.add', bridge: 'bridge', vlanId: 4001, tagged: [], untagged: [],
    });
    expect(v.severity).toBe('safe');
    expect(v.preexisting).toHaveLength(0);
  });

  it('warns when the bridge would keep membership only via the dynamic PVID row', () => {
    // Rewriting VLAN 1 drops the static row; the dynamic "added by pvid" row
    // survives, so management still works — but only by accident.
    const v = analyzeChange(trunkSnapshot(), device, {
      kind: 'vlan.update', bridge: 'bridge', vlanId: 1, tagged: [], untagged: ['sfp28-1'],
    });
    expect(v.severity).toBe('warning');
    expect(v.violations.map((x) => x.id)).toContain('bridge-untagged-member');
    expect(v.violations[0].severity).toBe('warning');
    expect(v.violations[0].detail).toMatch(/dynamic/i);
  });

  it('is critical when no dynamic row would keep the bridge in the VLAN', () => {
    const snap = baseSnapshot({
      bridgeVlans: [
        { bridge: 'bridge', 'vlan-ids': '1', tagged: 'sfp28-1', untagged: 'bridge',
          'current-tagged': 'sfp28-1', 'current-untagged': 'bridge', dynamic: 'false' },
      ],
    });
    const v = analyzeChange(snap, device, {
      kind: 'vlan.update', bridge: 'bridge', vlanId: 1, tagged: ['sfp28-1'], untagged: [],
    });
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('bridge-untagged-member');
  });
});

describe('analyzeChange — enabling vlan-filtering', () => {
  it('is safe when the bridge is already an untagged member of the management VLAN', () => {
    const snap = baseSnapshot({ bridges: [{ name: 'bridge', 'vlan-filtering': 'false', pvid: '1' }] });
    const v = analyzeChange(snap, device, { kind: 'bridge.vlan-filtering', bridge: 'bridge', enabled: true });
    expect(v.severity).toBe('safe');
  });

  it('is critical when the bridge is missing from the management VLAN', () => {
    // vlan-filtering currently off, and VLAN 1's entry omits the bridge — the
    // classic "enable filtering, lose the device" case.
    const snap = baseSnapshot({
      bridges: [{ name: 'bridge', 'vlan-filtering': 'false', pvid: '1' }],
      bridgeVlans: [
        { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'sfp28-1,ether1',
          'current-tagged': '', 'current-untagged': 'sfp28-1,ether1' },
      ],
    });
    const v = analyzeChange(snap, device, { kind: 'bridge.vlan-filtering', bridge: 'bridge', enabled: true });
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('bridge-untagged-member');
  });
});

describe('analyzeChange — other management-path cuts', () => {
  it('flags removing the management IP', () => {
    const v = analyzeChange(baseSnapshot(), device, { kind: 'ip.remove', addressId: '*1' });
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('mgmt-ip-present');
  });

  it('flags disabling the ingress port', () => {
    const v = analyzeChange(baseSnapshot(), device, { kind: 'interface.disable', name: 'sfp28-1', disabled: true });
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('ingress-port-member');
  });

  it('allows disabling an unrelated port', () => {
    const v = analyzeChange(baseSnapshot(), device, { kind: 'interface.disable', name: 'ether1', disabled: true });
    expect(v.severity).toBe('safe');
  });

  it('flags disabling the API service the manager uses', () => {
    const v = analyzeChange(baseSnapshot(), device, { kind: 'service.toggle', serviceId: '*1', disabled: true });
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('mgmt-service-open');
  });

  it('flags removing the default route the manager arrives through', () => {
    const v = analyzeChange(baseSnapshot(), device, { kind: 'route.remove', routeId: '*A' });
    expect(v.severity).toBe('critical');
    expect(v.violations.map((x) => x.id)).toContain('route-to-manager');
  });

  it('flags deleting the bond that carries management', () => {
    const snap = baseSnapshot({
      interfaces: [
        { name: 'bridge', type: 'bridge', disabled: 'false' },
        { name: 'bond1', type: 'bond', slaves: 'sfp28-1,sfp28-2', disabled: 'false' },
      ],
      bridgePorts: [{ interface: 'bond1', bridge: 'bridge', pvid: '1', disabled: 'false' }],
      bridgeVlans: [
        { bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,bond1',
          'current-tagged': '', 'current-untagged': 'bridge,bond1' },
      ],
      bridgeHosts: [{ 'mac-address': 'B4:FB:E4:0B:0B:8A', 'on-interface': 'bond1', local: 'false' }],
    });
    expect(resolveManagementPath(snap, device).ingressBond).toBe('bond1');
    const v = analyzeChange(snap, device, { kind: 'bond.delete', name: 'bond1' });
    expect(v.severity).toBe('critical');
  });

  it('does not fire when nothing on the path changes', () => {
    const snap = baseSnapshot();
    expect(simulate(snap, { kind: 'vlan.add', bridge: 'bridge', vlanId: 4000, tagged: [], untagged: [] }).bridgeVlans)
      .toHaveLength(3);
    expect(analyzeChange(snap, device, { kind: 'interface.disable', name: 'ether1', disabled: false }).severity)
      .toBe('safe');
  });
});

// ── Outside review P2-7: management setups the model used to get wrong ──────

describe('P2-7 management paths', () => {
  it('catches removing a specific route to an off-subnet manager', () => {
    // The manager (10.9.9.5) is reached through 192.168.0.254 on a static
    // route, not the default route. Removing that route used to pass as safe.
    const snap = baseSnapshot({
      routes: [
        { '.id': '*A', 'dst-address': '10.9.0.0/16', gateway: '192.168.0.254', active: 'true' },
        { '.id': '*B', 'dst-address': '192.168.0.0/24', gateway: 'bridge', active: 'true' },
      ],
      arp: [{ address: '192.168.0.254', 'mac-address': 'AA:AA:AA:AA:AA:01', interface: 'bridge' }],
      bridgeHosts: [{ 'mac-address': 'AA:AA:AA:AA:AA:01', 'on-interface': 'sfp28-1', local: 'false' }],
      mgmtConnections: [{ protocol: 'tcp', 'src-address': '10.9.9.5:51000', 'dst-address': '192.168.0.40:8728' }],
    });
    expect(resolveManagementPath(snap, device).managerGateway).toBe('192.168.0.254');
    expect(analyzeChange(snap, device, { kind: 'route.remove', routeId: '*A' }).severity).toBe('critical');
  });

  it("doesn't take a monitoring tool's connection for the manager's", () => {
    const snap = baseSnapshot({
      mgmtConnections: [
        { protocol: 'tcp', 'src-address': '192.168.0.77:40000', 'dst-address': '192.168.0.40:8728' }, // a poller that connected first
        { protocol: 'tcp', 'src-address': '172.24.1.15:51234', 'dst-address': '192.168.0.40:8728' },
      ],
    });
    const path = resolveManagementPath(snap, device);
    expect(path.managerIp).toBeNull();
    expect(path.warnings.join(' ')).toMatch(/Several hosts are connected/);
    // With its own source port known, the manager's session is picked out.
    expect(resolveManagementPath({ ...snap, managerLocalPort: 51234 }, device).managerIp).toBe('172.24.1.15');
  });

  it('catches disabling the port under a management VLAN interface', () => {
    const snap = baseSnapshot({
      addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'vlan50', disabled: 'false' }],
      vlanInterfaces: [{ name: 'vlan50', 'vlan-id': '50', interface: 'ether1' }],
      interfaces: [
        { name: 'bridge', type: 'bridge', disabled: 'false' },
        { name: 'vlan50', type: 'vlan', disabled: 'false' },
        { name: 'ether1', type: 'ether', disabled: 'false' },
      ],
      bridgePorts: [], bridgeVlans: [], bridgeHosts: [],
      arp: [{ address: '192.168.0.1', 'mac-address': 'B4:FB:E4:0B:0B:8A', interface: 'vlan50' }],
    });
    expect(resolveManagementPath(snap, device).mgmtParent).toBe('ether1');
    expect(analyzeChange(snap, device, { kind: 'interface.disable', name: 'ether1', disabled: true }).severity).toBe('critical');
  });

  it('treats a bond holding the management address as carrying management', () => {
    const snap = baseSnapshot({
      addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'bond1', disabled: 'false' }],
      interfaces: [
        { name: 'bond1', type: 'bond', disabled: 'false', slaves: 'ether1,ether2' },
        { name: 'ether1', type: 'ether', disabled: 'false' },
      ],
      bridges: [], bridgePorts: [], bridgeVlans: [], bridgeHosts: [],
      arp: [{ address: '192.168.0.1', 'mac-address': 'B4:FB:E4:0B:0B:8A', interface: 'bond1' }],
    });
    expect(resolveManagementPath(snap, device).ingressBond).toBe('bond1');
  });

  describe('a tagged VLAN interface reached through an access port', () => {
    // vlan99 on the bridge holds the address; the manager arrives on ether1,
    // an access port with PVID 99. Tagged at the CPU, untagged on the wire.
    const accessMgmt = () => baseSnapshot({
      addresses: [{ '.id': '*1', address: '192.168.0.40/24', interface: 'vlan99', disabled: 'false' }],
      vlanInterfaces: [{ name: 'vlan99', 'vlan-id': '99', interface: 'bridge' }],
      interfaces: [
        { name: 'bridge', type: 'bridge', disabled: 'false' },
        { name: 'vlan99', type: 'vlan', disabled: 'false' },
        { name: 'ether1', type: 'ether', disabled: 'false' },
      ],
      bridgePorts: [{ interface: 'ether1', bridge: 'bridge', pvid: '99', disabled: 'false' }],
      bridgeVlans: [{ '.id': '*3', bridge: 'bridge', 'vlan-ids': '99', tagged: 'bridge', untagged: 'ether1' }],
      bridgeHosts: [{ 'mac-address': 'B4:FB:E4:0B:0B:8A', 'on-interface': 'ether1', local: 'false' }],
    });

    it('sees management as untagged on that port', () => {
      const path = resolveManagementPath(accessMgmt(), device);
      expect(path.taggedManagement).toBe(true);
      expect(path.ingressTagged).toBe(false);
    });

    it('is quiet for a harmless change, so real breakage is not masked', () => {
      expect(analyzeChange(accessMgmt(), device, { kind: 'vlan.add', bridge: 'bridge', vlanId: 200, tagged: ['bridge'], untagged: [] }).severity).toBe('safe');
    });

    it('catches moving that port off the management VLAN', () => {
      const change: PlannedChange = { kind: 'port.vlan', port: 'ether1', pvid: 1, tagged: [], untagged: [1], mode: 'access' };
      expect(analyzeChange(accessMgmt(), device, change).severity).toBe('critical');
    });
  });

  describe('port VLAN simulation matches the writer', () => {
    it('leaves a VLAN listed as both tagged and untagged untagged, as the writer does', () => {
      const change: PlannedChange = { kind: 'port.vlan', port: 'ether1', pvid: 10, tagged: [10], untagged: [10] };
      const row = simulate(baseSnapshot(), change).bridgeVlans.find((r) => r['vlan-ids'] === '10')!;
      expect(row['tagged']).toBe('sfp28-1');
      expect(row['untagged']).toBe('ether1');
    });

    it('adds a row for a VLAN that has none, as the writer does', () => {
      const change: PlannedChange = { kind: 'port.vlan', port: 'ether1', pvid: 1, tagged: [30], untagged: [] };
      const row = simulate(baseSnapshot(), change).bridgeVlans.find((r) => r['vlan-ids'] === '30');
      expect(row?.['tagged']).toBe('ether1');
    });
  });
});
