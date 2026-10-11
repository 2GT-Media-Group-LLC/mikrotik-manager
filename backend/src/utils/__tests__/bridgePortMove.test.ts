import { planBridgePortMove, addressesOnPorts, supportsMultipleOffloadedBridges, bridgeDeleteRefusal, type RosRow } from '../bridgePortMove';

const interfaces: RosRow[] = [
  { name: 'bridge', type: 'bridge' },
  { name: 'guest', type: 'bridge' },
  { name: 'ether1', type: 'ether' },
  { name: 'ether2', type: 'ether' },
  { name: 'ether3', type: 'ether' },
  { name: 'ether4', type: 'ether', slave: 'true' },
  { name: 'wifi1', type: 'wifi' },
];
const bridgePorts: RosRow[] = [
  { '.id': '*1', interface: 'ether2', bridge: 'bridge', dynamic: 'false' },
  { '.id': '*2', interface: 'ether3', bridge: 'bridge', dynamic: 'false' },
  { '.id': '*3', interface: 'wifi1', bridge: 'bridge', dynamic: 'true' },
];
const bridgeVlans: RosRow[] = [
  { '.id': '*V1', bridge: 'bridge', 'vlan-ids': '10', tagged: 'bridge,ether2', untagged: 'ether3', dynamic: 'false' },
  { '.id': '*V2', bridge: 'bridge', 'vlan-ids': '1', tagged: '', untagged: 'bridge,ether2,ether3', dynamic: 'true' },
  { '.id': '*V3', bridge: 'bridge', 'vlan-ids': '20', tagged: 'bridge', untagged: '', dynamic: 'false' },
];
const base = { bridgePorts, interfaces, bridgeVlans };

describe('planBridgePortMove', () => {
  it('moves bridged ports with set, adds unbridged ones, and cleans the old VLAN rows', () => {
    const r = planBridgePortMove({ ...base, ports: ['ether2', 'ether1'], target: 'guest' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.ops).toEqual([
      { action: 'set', port: 'ether2', id: '*1' },
      { action: 'add', port: 'ether1' },
    ]);
    // Static row only; the dynamic VLAN 1 row is RouterOS's own.
    expect(r.plan.vlanEdits).toEqual([{ id: '*V1', bridge: 'bridge', vlanIds: '10', tagged: ['bridge'], untagged: ['ether3'] }]);
  });

  it('removes for "no bridge" and creates a new bridge when asked', () => {
    const out = planBridgePortMove({ ...base, ports: ['ether3'], target: null });
    expect(out.ok && out.plan.ops).toEqual([{ action: 'remove', port: 'ether3', id: '*2' }]);
    const created = planBridgePortMove({ ...base, ports: ['ether1'], target: 'iot', createTarget: true });
    expect(created.ok && created.plan.createBridge).toBe('iot');
  });

  it('refuses what RouterOS would refuse or what would surprise', () => {
    const err = (over: Partial<Parameters<typeof planBridgePortMove>[0]>) => {
      const r = planBridgePortMove({ ...base, ports: ['ether1'], target: 'guest', ...over });
      return r.ok ? null : r.error;
    };
    expect(err({ ports: [] })).toMatch(/at least one/);
    expect(err({ target: 'nope' })).toMatch(/no bridge called nope/);
    expect(err({ target: 'ether2' })).toMatch(/no bridge called ether2/);
    expect(err({ ports: ['guest'] })).toMatch(/is a bridge/);
    expect(err({ ports: ['ether9'] })).toMatch(/no interface called ether9/);
    expect(err({ ports: ['ether4'] })).toMatch(/member of a bond/);
    expect(err({ ports: ['wifi1'] })).toMatch(/automatically/);
    expect(err({ target: 'guest', createTarget: true })).toMatch(/already an interface/);
    expect(err({ target: 'bad name!', createTarget: true })).toMatch(/Bridge names/);
    expect(err({ ports: ['ether2'], target: 'bridge' })).toMatch(/Already in bridge/);
  });

  it('skips ports already there when others move', () => {
    const r = planBridgePortMove({ ...base, ports: ['ether2', 'ether1'], target: 'bridge' });
    expect(r.ok && r.plan.unchanged).toEqual(['ether2']);
    expect(r.ok && r.plan.ops).toEqual([{ action: 'add', port: 'ether1' }]);
  });
});

describe('addressesOnPorts', () => {
  it('finds static addresses and DHCP clients on the moving ports', () => {
    const found = addressesOnPorts(['ether1'],
      [{ interface: 'ether1', address: '203.0.113.2/30' }, { interface: 'bridge', address: '192.168.88.1/24' }],
      [{ interface: 'ether1' }]);
    expect(found).toEqual(['ether1 has address 203.0.113.2/30', 'ether1 gets its address over DHCP']);
  });
});

describe('supportsMultipleOffloadedBridges', () => {
  it('is only CRS1xx and CRS2xx', () => {
    expect(supportsMultipleOffloadedBridges('CRS125-24G-1S-2HnD')).toBe(true);
    expect(supportsMultipleOffloadedBridges('CRS226-24G-2S+')).toBe(true);
    expect(supportsMultipleOffloadedBridges('CRS309-1G-8S+')).toBe(false);
    expect(supportsMultipleOffloadedBridges('RB5009UG+S+')).toBe(false);
    expect(supportsMultipleOffloadedBridges(null)).toBe(false);
  });
});

describe('bridgeDeleteRefusal', () => {
  const empty = { bridgePorts: [], addresses: [], vlanInterfaces: [], dhcpServers: [] };
  it('allows an empty, unused bridge', () => {
    expect(bridgeDeleteRefusal('guest', { ...empty, bridgePorts })).toBeNull();
  });
  it('refuses a bridge with ports, an address, a VLAN or a DHCP server', () => {
    expect(bridgeDeleteRefusal('bridge', { ...empty, bridgePorts })).toMatch(/still has ports/);
    expect(bridgeDeleteRefusal('guest', { ...empty, addresses: [{ interface: 'guest', address: '10.9.0.1/24' }] })).toMatch(/address/);
    expect(bridgeDeleteRefusal('guest', { ...empty, vlanInterfaces: [{ interface: 'guest', name: 'vlan9' }] })).toMatch(/vlan9/);
    expect(bridgeDeleteRefusal('guest', { ...empty, dhcpServers: [{ interface: 'guest', name: 'dhcp9' }] })).toMatch(/dhcp9/);
  });
});
