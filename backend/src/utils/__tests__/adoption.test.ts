import {
  collectCandidates, needsJumpHost, pickTempAddress, validateTargetAddress,
  buildAdoptionOps, fetchAuthHeader, sameSubnet, FACTORY_ADDRESS,
  type NeighborRow,
} from '../adoption';

/**
 * Fixtures are the real neighbour rows recorded when a new CRS310-8G+2S+ was
 * plugged into the reference fleet: one device, reported by four managed
 * neighbours, all agreeing on 192.168.88.1.
 */
const FLEET_ROWS: NeighborRow[] = [
  { neighbor_mac: '38:32:7A:34:E5:1B', neighbor_address: '192.168.88.1', neighbor_identity: 'MikroTik', neighbor_platform: 'MikroTik', from_device_id: 1, from_interface: 'sfp28-1' },
  { neighbor_mac: '38:32:7A:34:E5:1B', neighbor_address: '192.168.88.1', neighbor_identity: 'MikroTik', neighbor_platform: 'MikroTik', from_device_id: 2, from_interface: 'ether2' },
  { neighbor_mac: '38:32:7A:34:E5:1B', neighbor_address: '192.168.88.1', neighbor_identity: 'MikroTik', neighbor_platform: 'MikroTik', from_device_id: 7, from_interface: 'sfp28-2' },
  { neighbor_mac: '38:32:7A:34:E5:1B', neighbor_address: '192.168.88.1', neighbor_identity: 'MikroTik', neighbor_platform: 'MikroTik', from_device_id: 8, from_interface: 'ether1' },
  // Real non-MikroTik neighbours seen on the same fleet.
  { neighbor_mac: '70:A7:41:EF:8F:FC', neighbor_address: null, neighbor_identity: '2GT-NW-CORE', neighbor_platform: 'USW-Pro-Aggregation,', from_device_id: 1, from_interface: 'sfp28-1' },
  { neighbor_mac: '50:6B:4B:25:DA:FA', neighbor_address: '172.16.1.1', neighbor_identity: 'node1', neighbor_platform: 'Debian', from_device_id: 1, from_interface: 'sfp28-4' },
];

describe('collectCandidates', () => {
  it('collapses four sightings of one switch into a single candidate', () => {
    const got = collectCandidates(FLEET_ROWS);
    expect(got).toHaveLength(1);
    expect(got[0].mac).toBe('38:32:7A:34:E5:1B');
    expect(got[0].address).toBe('192.168.88.1');
  });

  it('keeps every reporter, because each one is a possible jump host', () => {
    expect(collectCandidates(FLEET_ROWS)[0].seenBy.sort()).toEqual([1, 2, 7, 8]);
  });

  it('flags the factory address', () => {
    expect(collectCandidates(FLEET_ROWS)[0].factoryDefault).toBe(true);
    expect(FACTORY_ADDRESS).toBe('192.168.88.1');
  });

  it('ignores non-MikroTik neighbours', () => {
    // A Ubiquiti aggregation switch and a Debian host are both genuinely on this
    // fleet and neither can be adopted this way.
    const macs = collectCandidates(FLEET_ROWS).map((c) => c.mac);
    expect(macs).not.toContain('70:A7:41:EF:8F:FC');
    expect(macs).not.toContain('50:6B:4B:25:DA:FA');
  });

  it('ignores a neighbour with no address, which cannot be reached at all', () => {
    expect(collectCandidates([
      { ...FLEET_ROWS[0], neighbor_address: null },
    ])).toHaveLength(0);
  });

  it('normalises MAC case so one device is not reported twice', () => {
    const got = collectCandidates([
      FLEET_ROWS[0],
      { ...FLEET_ROWS[1], neighbor_mac: '38:32:7a:34:e5:1b' },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].seenBy).toEqual([1, 2]);
  });
});

describe('needsJumpHost', () => {
  it('is true for a factory device on the reference fleet', () => {
    expect(needsJumpHost('192.168.88.1', ['192.168.0.40', '192.168.0.51'])).toBe(true);
  });

  it('is false once the device shares a subnet with something we manage', () => {
    expect(needsJumpHost('192.168.0.60', ['192.168.0.40'])).toBe(false);
  });
});

describe('pickTempAddress', () => {
  it('picks an address inside the target subnet', () => {
    expect(pickTempAddress('192.168.88.1', [])).toBe('192.168.88.250/24');
  });

  it('never picks the target itself', () => {
    expect(pickTempAddress('192.168.88.250', [])).toBe('192.168.88.249/24');
  });

  it('skips addresses the jump host already holds, prefix or not', () => {
    expect(pickTempAddress('192.168.88.1', ['192.168.88.250/24', '192.168.88.249'])).toBe('192.168.88.248/24');
  });

  it('gives up rather than colliding when the range is exhausted', () => {
    const taken = Array.from({ length: 51 }, (_, i) => `192.168.88.${200 + i}`);
    expect(pickTempAddress('192.168.88.1', taken)).toBeNull();
  });
});

describe('validateTargetAddress', () => {
  const peer = '192.168.0.51';

  it('accepts a free address on the manager subnet', () => {
    expect(validateTargetAddress('192.168.0.60', peer)).toEqual({ ok: true });
  });

  it('refuses an address on a different subnet, which would strand the device', () => {
    const v = validateTargetAddress('10.0.0.5', peer);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not be able to reach/);
  });

  it('refuses an address already known to be in use', () => {
    // 192.168.0.64 answered ping on the real network while absent from ARP.
    const v = validateTargetAddress('192.168.0.64', peer, 24, ['192.168.0.64']);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/already in use/);
  });

  it('refuses network and broadcast addresses', () => {
    expect(validateTargetAddress('192.168.0.0', peer).ok).toBe(false);
    expect(validateTargetAddress('192.168.0.255', peer).ok).toBe(false);
  });

  it('refuses nonsense', () => {
    expect(validateTargetAddress('not-an-ip', peer).ok).toBe(false);
    expect(validateTargetAddress('192.168.0.999', peer).ok).toBe(false);
  });
});

describe('buildAdoptionOps', () => {
  const ops = buildAdoptionOps({ targetAddress: '192.168.0.60/24', gateway: '192.168.0.1' });

  it('adds the address before the route', () => {
    expect(ops[0].path).toBe('ip/address');
    expect(ops[1].path).toBe('ip/route');
  });

  it('adds rather than replaces, so a half-done adoption is not stranding', () => {
    // PUT is RouterOS REST for "add". Nothing here deletes the factory address;
    // that is a later step taken over the new path once it is proven.
    expect(ops.every((o) => o.method === 'put' || o.method === 'post')).toBe(true);
    expect(ops.some((o) => o.method === 'delete')).toBe(false);
  });

  it('always includes a default route — an address alone cannot reply off-subnet', () => {
    expect(ops[1].body).toMatchObject({ 'dst-address': '0.0.0.0/0', gateway: '192.168.0.1' });
  });

  it('tags everything it creates so it can be recognised later', () => {
    expect(ops[0].body?.comment).toBe('mtm-adopted');
    expect(ops[1].body?.comment).toBe('mtm-adopted');
  });

  it('only sets identity when one was given', () => {
    expect(ops).toHaveLength(2);
    const named = buildAdoptionOps({ targetAddress: '192.168.0.60/24', gateway: '192.168.0.1', identity: 'sw-01' });
    expect(named).toHaveLength(3);
    expect(named[2].body).toEqual({ name: 'sw-01' });
  });
});

describe('fetchAuthHeader', () => {
  it('builds the header that made REST work through /tool/fetch', () => {
    // fetch will not complete RouterOS REST's auth challenge on its own — REST
    // answers 401 without a www-authenticate header — so credentials have to be
    // presented up front.
    expect(fetchAuthHeader('admin', 'secret'))
      .toBe('Authorization: Basic YWRtaW46c2VjcmV0,Content-Type: application/json');
  });

  it('handles a password with characters that matter in base64', () => {
    expect(fetchAuthHeader('admin', 'MKHW7QW9VN')).toContain('Authorization: Basic ');
  });
});

describe('sameSubnet', () => {
  it('separates the factory subnet from the real one', () => {
    expect(sameSubnet('192.168.88.1', '192.168.0.51')).toBe(false);
    expect(sameSubnet('192.168.0.60', '192.168.0.51')).toBe(true);
  });

  it('honours the prefix', () => {
    expect(sameSubnet('192.168.88.1', '192.168.0.51', 16)).toBe(true);
  });
});
