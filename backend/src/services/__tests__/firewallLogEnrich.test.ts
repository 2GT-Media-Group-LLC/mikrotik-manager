jest.mock('../../config/database');

import { query } from '../../config/database';
import { ROUTER_ZONE, clearNameCache, withNames, withZones, zoneFilterSql, zoneNames, zonesOf } from '../firewallLogEnrich';
import { interfaceZones } from '../../utils/zoneFirewall';

const mockQuery = query as jest.MockedFunction<typeof query>;

beforeEach(() => { mockQuery.mockReset(); clearNameCache(); });

describe('zone filters (#415)', () => {
  const maps = new Map<number, Record<string, string>>([
    [1, { bridge: 'LAN', ether1: 'WAN' }],
    [2, { ether2: 'LAN', ether5: 'GUEST' }],
  ]);
  const placeholders = () => {
    const params: unknown[] = [];
    return { params, p: (v: unknown) => { params.push(v); return `$${params.length}`; } };
  };

  it('offers Router first, then each zone once, A to Z', () => {
    expect(zoneNames(maps)).toEqual([ROUTER_ZONE, 'GUEST', 'LAN', 'WAN']);
    expect(zoneNames(new Map())).toEqual([]);
  });

  it('turns a zone into its interfaces on each device', () => {
    const { params, p } = placeholders();
    const sql = zoneFilterSql('from', 'LAN', maps, p);
    expect(params).toEqual([['1|bridge', '2|ether2']]);
    expect(sql).toContain('in:([^[:space:],]+)');
    expect(sql).toContain("IS DISTINCT FROM 'output'");
  });

  it("reads Router as the router's own traffic on a zone-managed device", () => {
    const { params, p } = placeholders();
    const sql = zoneFilterSql('to', ROUTER_ZONE, maps, p);
    expect(sql).toContain("= 'input'");
    expect(params).toEqual([[1, 2]]);
  });

  it('matches nothing for a zone no interface is in', () => {
    const { params, p } = placeholders();
    expect(zoneFilterSql('to', 'DMZ', maps, p)).toBe('FALSE');
    expect(params).toEqual([]);
  });
});

describe('interfaceZones (#415)', () => {
  it('maps each member to its zone, skipping disabled members and non-zone lists', () => {
    expect(interfaceZones(['LAN', 'WAN'], [
      { list: 'LAN', interface: 'bridge' },
      { list: 'WAN', interface: 'ether1' },
      { list: 'WAN', interface: 'ether2', disabled: 'true' },
      { list: 'mgmt', interface: 'ether5' },
      { list: 'LAN', interface: '<pppoe-bob>', dynamic: 'true' } as never,
    ])).toEqual({ bridge: 'LAN', ether1: 'WAN', '<pppoe-bob>': 'LAN' });
  });

  it('keeps the first zone for an interface in two', () => {
    expect(interfaceZones(['A', 'B'], [{ list: 'B', interface: 'x' }, { list: 'A', interface: 'x' }])).toEqual({ x: 'A' });
  });
});

describe('zonesOf', () => {
  const map = { bridge: 'LAN', ether1: 'WAN' };

  it('names the router as the zone for input and output', () => {
    expect(zonesOf({ deviceId: 1, chain: 'input', inInterface: 'bridge' }, map))
      .toEqual({ zoned: true, fromZone: 'LAN', toZone: ROUTER_ZONE });
    expect(zonesOf({ deviceId: 1, chain: 'output', outInterface: 'ether1' }, map))
      .toEqual({ zoned: true, fromZone: ROUTER_ZONE, toZone: 'WAN' });
  });

  it('maps both sides of forwarded traffic, leaving unknown interfaces empty', () => {
    expect(zonesOf({ deviceId: 1, chain: 'forward', inInterface: 'bridge', outInterface: 'ether1' }, map))
      .toEqual({ zoned: true, fromZone: 'LAN', toZone: 'WAN' });
    expect(zonesOf({ deviceId: 1, chain: 'forward', inInterface: 'wg0', outInterface: 'toString' }, map))
      .toEqual({ zoned: true, fromZone: undefined, toZone: undefined });
  });

  it('adds nothing for a device without zones', () => {
    expect(zonesOf({ deviceId: 1, chain: 'forward' }, undefined)).toEqual({});
  });
});

describe('withZones', () => {
  it('reads the maps of the devices in the lines and leaves other devices alone', async () => {
    mockQuery.mockResolvedValueOnce([{ device_id: 1, interface_zones: { bridge: 'LAN' } }] as never);
    const out = await withZones([
      { deviceId: 1, chain: 'input' as const, inInterface: 'bridge' },
      { deviceId: 2, chain: 'input' as const, inInterface: 'bridge' },
    ]);
    expect(mockQuery.mock.calls[0][1]).toEqual([[1, 2]]);
    expect(out[0]).toMatchObject({ zoned: true, fromZone: 'LAN', toZone: ROUTER_ZONE });
    expect(out[1]).not.toHaveProperty('zoned');
  });

  it("doesn't query without devices", async () => {
    const lines = [{ deviceId: null, chain: 'input' as const }];
    expect(await withZones(lines)).toBe(lines);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('withNames', () => {
  it('prefers a client hostname from the same site, then reverse DNS', async () => {
    mockQuery
      .mockResolvedValueOnce([{ id: 1, site_id: 10 }] as never)
      .mockResolvedValueOnce([
        { site_id: 10, ip_address: '192.168.62.15', name: 'laptop' },
        { site_id: 20, ip_address: '192.168.62.1', name: 'other-site-router' },
      ] as never);
    const lookup = jest.fn(async (ip: string) => (ip === '57.145.12.8' ? 'edge.example.net' : null));
    const out = await withNames([
      { deviceId: 1, srcIp: '192.168.62.15', dstIp: '57.145.12.8' },
      { deviceId: 1, srcIp: '192.168.62.15', dstIp: '192.168.62.1' },
    ], lookup, async () => new Map());
    expect(out[0]).toMatchObject({ srcName: 'laptop', dstName: 'edge.example.net' });
    expect(out[1]).toMatchObject({ srcName: 'laptop' });
    expect(out[1]).not.toHaveProperty('dstName');
    // The client's address isn't sent to DNS.
    expect(lookup.mock.calls.map((c) => c[0]).sort()).toEqual(['192.168.62.1', '57.145.12.8']);
  });

  it('prefers the name a lookup in the same site answered with over reverse DNS (#366)', async () => {
    mockQuery
      .mockResolvedValueOnce([{ id: 1, site_id: 10 }, { id: 2, site_id: 20 }] as never)
      .mockResolvedValueOnce([] as never);
    const lookup = jest.fn(async () => 'arn11s10-in-f14.1e100.net');
    const forward = jest.fn(async (bySite: Map<number, string[]>) => {
      expect([...bySite.keys()].sort()).toEqual([10, 20]);
      return new Map([['10|142.250.74.110', 'www.youtube.com']]);
    });
    const out = await withNames([
      { deviceId: 1, srcIp: '192.168.1.5', dstIp: '142.250.74.110' },
      { deviceId: 2, srcIp: '10.0.0.5', dstIp: '142.250.74.110' },
    ], lookup, forward);
    expect(out[0].dstName).toBe('www.youtube.com');
    // Site 20's lookups didn't name it, so reverse DNS does.
    expect(out[1].dstName).toBe('arn11s10-in-f14.1e100.net');
  });

  it("doesn't wait past its budget for slow DNS", async () => {
    jest.useFakeTimers();
    try {
      mockQuery.mockResolvedValue([] as never);
      const lookup = () => new Promise<string | null>(() => {});
      const p = withNames([{ deviceId: null, srcIp: '10.0.0.1', dstIp: '10.0.0.2' }], lookup, async () => new Map());
      await jest.advanceTimersByTimeAsync(1600);
      expect(await p).toEqual([{ deviceId: null, srcIp: '10.0.0.1', dstIp: '10.0.0.2' }]);
    } finally {
      jest.useRealTimers();
    }
  });
});
