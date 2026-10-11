import { clientAttachments, isPortLike, type ClientSighting } from '../topologyClients';

const s = (over: Partial<ClientSighting>): ClientSighting => ({
  mac_address: 'AA:BB:CC:00:00:01', device_id: 1, interface_name: 'bridge', client_type: 'wired',
  last_seen: '2026-10-10T12:00:00Z', hostname: null, custom_name: null, ip_address: '10.0.0.5', vendor: null, ...over,
});

// router 1 sees everyone in ARP on "bridge"; switch 2 uplinks to it on sfp1 and has access ports; AP 3.
const uplinks = new Set(['2:sfp1', '1:ether2']);
const types = new Map([['2:ether5', 'ether'], ['2:sfp1', 'ether'], ['1:bridge', 'bridge'], ['3:wifi1', 'wifi']]);

describe('clientAttachments', () => {
  it('puts a wired client on the switch access port, not the router that also sees it', () => {
    const r = clientAttachments([
      s({ device_id: 1, interface_name: 'bridge' }),
      s({ device_id: 2, interface_name: 'ether5', hostname: 'laptop' }),
    ], uplinks, types);
    expect(r).toEqual([{ mac: 'AA:BB:CC:00:00:01', name: 'laptop', ip: '10.0.0.5', deviceId: 2, interface: 'ether5', wireless: false, portKnown: true, behindNeighbour: false }]);
  });

  it('puts a wireless client on its AP, though the switch learns it on the AP uplink', () => {
    const r = clientAttachments([
      s({ device_id: 2, interface_name: 'ether5' }),
      s({ device_id: 3, interface_name: 'wifi1', client_type: 'wireless', custom_name: "Rich's phone" }),
    ], uplinks, types);
    expect(r[0]).toMatchObject({ deviceId: 3, wireless: true, name: "Rich's phone", portKnown: true });
  });

  it('ignores a sighting on a port facing another managed device', () => {
    const r = clientAttachments([
      s({ device_id: 2, interface_name: 'sfp1', last_seen: '2026-10-10T13:00:00Z' }),
      s({ device_id: 1, interface_name: 'bridge' }),
    ], uplinks, types);
    expect(r[0]).toMatchObject({ portKnown: false });
  });

  it('falls back to the router when nothing better saw it, marked as a guess', () => {
    const r = clientAttachments([s({ device_id: 1, interface_name: 'bridge', vendor: 'Apple' })], uplinks, types);
    expect(r[0]).toMatchObject({ deviceId: 1, portKnown: false, name: 'Apple' });
  });

  it('treats MAC case as the same client', () => {
    const r = clientAttachments([s({ mac_address: 'aa:bb:cc:00:00:01' }), s({ mac_address: 'AA:BB:CC:00:00:01', device_id: 2, interface_name: 'ether5' })], uplinks, types);
    expect(r).toHaveLength(1);
  });
});

describe('clients behind an unmanaged neighbour', () => {
  it('marks a client learned on a port facing an unmanaged switch as behind it, over an ARP sighting', () => {
    const r = clientAttachments([
      s({ device_id: 1, interface_name: 'bridge' }),
      s({ device_id: 8, interface_name: 'ether1' }),
    ], uplinks, new Map([['8:ether1', 'ether']]), new Set(['8:ether1']));
    expect(r[0]).toMatchObject({ deviceId: 8, interface: 'ether1', portKnown: true, behindNeighbour: true });
  });
  it('still prefers a real access port', () => {
    const r = clientAttachments([
      s({ device_id: 8, interface_name: 'ether1' }),
      s({ device_id: 2, interface_name: 'ether5' }),
    ], uplinks, types, new Set(['8:ether1']));
    expect(r[0]).toMatchObject({ deviceId: 2, behindNeighbour: false });
  });
});

describe('isPortLike', () => {
  it('knows ports from bridges and VLANs', () => {
    expect(isPortLike('ether5', 'ether')).toBe(true);
    expect(isPortLike('bridge', 'bridge')).toBe(false);
    expect(isPortLike('vlan10', 'vlan')).toBe(false);
    expect(isPortLike('sfp-sfpplus1')).toBe(true);
    expect(isPortLike('wg0')).toBe(false);
  });
});
