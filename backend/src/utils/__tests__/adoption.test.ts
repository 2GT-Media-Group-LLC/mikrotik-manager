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

/**
 * Telling the two scenarios apart.
 *
 * Scenario 1 is the manager arriving in an environment full of working
 * switches; scenario 2 is one new device arriving in a working environment.
 * Only the second should ever be written to.
 */
import { recommendMode, assessFactoryState, FACTORY_IDENTITY } from '../adoption';

describe('recommendMode', () => {
  it('adopts a device showing both factory markers', () => {
    // The real CRS310, exactly as it arrived.
    const r = recommendMode({ address: '192.168.88.1', identity: 'MikroTik' });
    expect(r.mode).toBe('adopt');
    expect(r.confidence).toBe('high');
  });

  it('adds an established device, even when unreachable from here', () => {
    // The dangerous case: a configured switch in a VLAN we do not route to.
    // Unreachable is not the same as unconfigured, and adopting it would
    // rewrite the addressing of a working device.
    const r = recommendMode({
      address: '10.20.30.40', identity: 'core-sw-02', reachableDirectly: false,
    });
    expect(r.mode).toBe('add');
    expect(r.confidence).toBe('high');
    expect(r.reasons.join(' ')).toMatch(/already configured/);
    expect(r.reasons.join(' ')).toMatch(/needs a route or a credential/);
  });

  it('adds an established device that is reachable', () => {
    expect(recommendMode({
      address: '192.168.0.39', identity: '2GT-NW-BigSwitch', reachableDirectly: true,
    }).mode).toBe('add');
  });

  it('is unsure when only one factory marker is present', () => {
    // Factory address but renamed: possibly half-configured by someone.
    const renamed = recommendMode({ address: '192.168.88.1', identity: 'sw-spare' });
    expect(renamed.mode).toBe('adopt');
    expect(renamed.confidence).toBe('low');

    // Default identity but moved off the factory address.
    const moved = recommendMode({ address: '10.0.0.9', identity: 'MikroTik' });
    expect(moved.confidence).toBe('low');
  });

  it('explains itself, so the operator can overrule it', () => {
    expect(recommendMode({ address: '192.168.88.1', identity: 'MikroTik' }).reasons)
      .toEqual(expect.arrayContaining([
        expect.stringContaining('192.168.88.1'),
        expect.stringContaining('MikroTik'),
      ]));
  });
});

describe('assessFactoryState', () => {
  /** The reference CRS310 as delivered. */
  const FRESH = {
    identity: FACTORY_IDENTITY,
    addresses: [{ address: '192.168.88.1/24', comment: 'defconf' }],
    users: [{ name: 'admin' }],
  };

  it('accepts a genuinely factory-default device', () => {
    const a = assessFactoryState(FRESH);
    expect(a.isFactory).toBe(true);
    expect(a.warnings).toEqual([]);
  });

  it('refuses a device that has been renamed', () => {
    const a = assessFactoryState({ ...FRESH, identity: 'core-sw-01' });
    expect(a.isFactory).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/core-sw-01/);
  });

  it('refuses a device carrying addresses of its own', () => {
    const a = assessFactoryState({
      ...FRESH,
      addresses: [
        { address: '192.168.88.1/24', comment: 'defconf' },
        { address: '10.20.30.40/24', comment: 'uplink' },
      ],
    });
    expect(a.isFactory).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/10\.20\.30\.40/);
  });

  it('refuses a device with extra user accounts', () => {
    const a = assessFactoryState({ ...FRESH, users: [{ name: 'admin' }, { name: 'netops' }] });
    expect(a.isFactory).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/2 user accounts/);
  });

  it('is strict: one warning is enough to decline', () => {
    // Refusing a new device costs one override. Adopting a live one rewrites
    // its addressing, so the asymmetry is deliberate.
    const a = assessFactoryState({ ...FRESH, identity: 'named-but-otherwise-fresh' });
    expect(a.signals.length).toBeGreaterThan(0);
    expect(a.isFactory).toBe(false);
  });

  it('declines when it can see nothing at all rather than assuming', () => {
    expect(assessFactoryState({}).isFactory).toBe(false);
  });
});

/**
 * Addressing the device.
 *
 * The first version asked only for an IPv4 address and inferred a /24, a
 * gateway at .1, and the untagged bridge. These cover the cases that inference
 * got wrong.
 */
import {
  validatePlan, buildPlanOps, planInterface, leasedAddress, judgeConflict, arpRowResolved,
  type AddressPlan,
} from '../adoption';

describe('validatePlan', () => {
  it('accepts a well-formed static plan', () => {
    expect(validatePlan({
      mode: 'static', address: '192.168.0.60', prefix: 24, gateway: '192.168.0.1',
    })).toEqual({ ok: true });
  });

  it('accepts a gateway that is not .1, because plenty are not', () => {
    expect(validatePlan({
      mode: 'static', address: '10.20.30.40', prefix: 24, gateway: '10.20.30.254',
    }).ok).toBe(true);
  });

  it('rejects a gateway outside the address prefix', () => {
    // Exactly what assuming ".1" produces on a /26.
    const v = validatePlan({
      mode: 'static', address: '192.168.0.70', prefix: 26, gateway: '192.168.0.1',
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not reachable from/);
  });

  it('honours non-/24 prefixes', () => {
    expect(validatePlan({
      mode: 'static', address: '10.0.4.10', prefix: 22, gateway: '10.0.4.1',
    }).ok).toBe(true);
  });

  it('requires a gateway rather than inventing one', () => {
    expect(validatePlan({
      mode: 'static', address: '192.168.0.60', prefix: 24, gateway: '',
    }).ok).toBe(false);
  });

  it('validates the VLAN range', () => {
    expect(validatePlan({ mode: 'dhcp', vlanId: 100 }).ok).toBe(true);
    expect(validatePlan({ mode: 'dhcp', vlanId: 0 }).ok).toBe(false);
    expect(validatePlan({ mode: 'dhcp', vlanId: 4095 }).ok).toBe(false);
  });

  it('needs nothing at all for plain DHCP', () => {
    expect(validatePlan({ mode: 'dhcp' })).toEqual({ ok: true });
  });
});

describe('planInterface', () => {
  it('uses the bridge when there is no VLAN', () => {
    expect(planInterface({ mode: 'dhcp' })).toBe('bridge');
  });

  it('uses a sub-interface for a tagged management VLAN', () => {
    expect(planInterface({ mode: 'dhcp', vlanId: 100 })).toBe('bridge-vlan100');
  });
});

describe('buildPlanOps', () => {
  it('creates the VLAN interface before addressing it', () => {
    const ops = buildPlanOps({ plan: { mode: 'dhcp', vlanId: 100 } });
    expect(ops[0].path).toBe('interface/vlan');
    expect(ops[0].body).toMatchObject({ 'vlan-id': '100', interface: 'bridge' });
    expect(ops[1].body?.interface).toBe('bridge-vlan100');
  });

  it('asks for a lease rather than an address in DHCP mode', () => {
    const ops = buildPlanOps({ plan: { mode: 'dhcp' } });
    expect(ops.map((o) => o.path)).toEqual(['ip/dhcp-client']);
    expect(ops[0].body).toMatchObject({ 'add-default-route': 'yes' });
  });

  it('writes the real prefix, not an assumed /24', () => {
    const ops = buildPlanOps({
      plan: { mode: 'static', address: '10.0.4.10', prefix: 22, gateway: '10.0.4.1' },
    });
    expect(ops[0].body?.address).toBe('10.0.4.10/22');
  });

  it('still never deletes anything', () => {
    const plans: AddressPlan[] = [
      { mode: 'dhcp' },
      { mode: 'dhcp', vlanId: 7 },
      { mode: 'static', address: '192.168.0.60', prefix: 24, gateway: '192.168.0.1' },
    ];
    for (const plan of plans) {
      expect(buildPlanOps({ plan }).some((o) => o.method === 'delete')).toBe(false);
    }
  });
});

describe('leasedAddress', () => {
  it('reads the address DHCP handed out', () => {
    expect(leasedAddress([{ address: '192.168.0.77/24', status: 'bound' }])).toBe('192.168.0.77');
  });

  it('ignores a client that has not bound yet', () => {
    expect(leasedAddress([{ address: '', status: 'searching...' }])).toBeNull();
  });
});

describe('judgeConflict', () => {
  it('accepts an address nothing answers for', () => {
    expect(judgeConflict({ arpResolved: false, pingReplies: 0 }).free).toBe(true);
  });

  it('rejects one with a resolved ARP entry', () => {
    expect(judgeConflict({ arpResolved: true, pingReplies: 0 }).free).toBe(false);
  });

  it('rejects one that only answers ping — the 192.168.0.64 case', () => {
    // Observed on the real network: replied to ping, absent from ARP. ARP alone
    // would have assigned a duplicate address to a switch.
    const v = judgeConflict({ arpResolved: false, pingReplies: 2 });
    expect(v.free).toBe(false);
    expect(v.reason).toMatch(/not in ARP/);
  });
});

/**
 * Real rows captured from 2GT-NW-MIKROTIK10G-TEST while probing for a free
 * address. The failed entries exist *because* this feature pinged those
 * addresses and nothing answered.
 */
describe('arpRowResolved', () => {
  it('counts a live host', () => {
    expect(arpRowResolved({
      'mac-address': 'D8:9E:F3:90:41:F1', status: 'stale', complete: 'true',
    })).toBe(true);
  });

  it('counts a reachable host', () => {
    expect(arpRowResolved({
      'mac-address': 'B4:FB:E4:0B:0B:8A', status: 'reachable', complete: 'true',
    })).toBe(true);
  });

  it('does not count a failed lookup, which means the address is free', () => {
    // The self-inflicted bug: our own ping created this entry, and reading it
    // as occupancy meant a free address could never be used twice.
    expect(arpRowResolved({ status: 'failed', complete: 'false' })).toBe(false);
  });

  it('does not count an entry with no MAC at all', () => {
    expect(arpRowResolved({ status: 'incomplete' })).toBe(false);
  });
});
