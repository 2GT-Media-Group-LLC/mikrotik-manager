import { AMBIGUOUS, buildAttributionMaps, isLocalAddress, matchClient, type DeviceRow, type ClientRow } from '../attribution';

// Outside review P2-23 / J4: two customers on the RouterOS default subnet.
const devices: DeviceRow[] = [
  { id: 1, name: 'hq-gw', site_id: 1, ip_address: '192.168.88.1', ip_addresses_jsonb: [{ address: '10.0.0.1/24' }] },
  { id: 2, name: 'hq-sw', site_id: 1, ip_address: '192.168.88.2', ip_addresses_jsonb: null },
  { id: 8, name: 'cust-gw', site_id: 3, ip_address: '192.168.88.1', ip_addresses_jsonb: [{ address: '172.16.5.1/24' }] },
];
const clients: ClientRow[] = [
  // newest first within each (site, address), as the query orders them
  { site_id: 1, ip_address: '192.168.88.10', mac_address: 'AA:AA:AA:00:00:01' },
  { site_id: 1, ip_address: '192.168.88.10', mac_address: 'aa:aa:aa:00:00:99' }, // older holder
  { site_id: 3, ip_address: '192.168.88.10', mac_address: 'bb:bb:bb:00:00:01' },
  { site_id: 1, ip_address: '10.0.0.50', mac_address: 'aa:aa:aa:00:00:02' },
  { site_id: 3, ip_address: '172.16.5.20', mac_address: 'bb:bb:bb:00:00:02' },
  { site_id: 1, ip_address: '192.168.88.2', mac_address: 'aa:aa:aa:00:00:03' }, // a device's own address
];

describe('buildAttributionMaps / matchClient', () => {
  const maps = buildAttributionMaps(devices, clients);
  const hq = maps.exporterByIp.get('10.0.0.1');
  const cust = maps.exporterByIp.get('172.16.5.1');

  it('identifies exporters by any of their addresses, with their site', () => {
    expect(hq).toEqual({ deviceId: 1, deviceName: 'hq-gw', siteId: 1 });
    expect(cust).toEqual({ deviceId: 8, deviceName: 'cust-gw', siteId: 3 });
  });

  it('marks an address used by devices in two sites as ambiguous', () => {
    expect(maps.exporterByIp.get('192.168.88.1')).toBe(AMBIGUOUS);
  });

  it("matches a reused client address in the exporter's own site", () => {
    expect(matchClient(maps, hq as never, '192.168.88.10')).toEqual({ mac: 'aa:aa:aa:00:00:01', siteId: 1 });
    expect(matchClient(maps, cust as never, '192.168.88.10')).toEqual({ mac: 'bb:bb:bb:00:00:01', siteId: 3 });
  });

  it("never matches another site's client", () => {
    expect(matchClient(maps, cust as never, '10.0.0.50')).toEqual({ mac: undefined, siteId: 3 });
  });

  it("doesn't bill a device's own address to a client", () => {
    expect(matchClient(maps, hq as never, '192.168.88.2').mac).toBeUndefined();
  });

  it('for an unidentified exporter, matches only addresses unique to one site', () => {
    expect(matchClient(maps, null, '10.0.0.50')).toEqual({ mac: 'aa:aa:aa:00:00:02', siteId: 1 });
    expect(matchClient(maps, null, '172.16.5.20')).toEqual({ mac: 'bb:bb:bb:00:00:02', siteId: 3 });
    // In both sites: can't say whose it is, so nobody's.
    expect(matchClient(maps, null, '192.168.88.10')).toEqual({ siteId: null });
  });

  it('puts unmatched traffic from an unidentified exporter in the only site, when there is one', () => {
    const single = buildAttributionMaps(devices.filter((d) => d.site_id === 1), clients.filter((c) => c.site_id === 1));
    expect(matchClient(single, null, '8.8.8.8')).toEqual({ siteId: 1 });
    expect(matchClient(single, null, '192.168.88.10')).toEqual({ mac: 'aa:aa:aa:00:00:01', siteId: 1 });
  });
});

describe('isLocalAddress', () => {
  it.each(['10.1.2.3', '172.20.0.1', '192.168.65.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', 'fd00::1', '::1', '::ffff:192.168.1.5'])(
    '%s is local', (ip) => expect(isLocalAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '172.32.0.1', '203.0.113.9', '2001:db8::1', '::ffff:8.8.8.8'])(
    '%s is not', (ip) => expect(isLocalAddress(ip)).toBe(false));
});
