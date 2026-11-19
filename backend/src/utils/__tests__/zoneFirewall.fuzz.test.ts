/**
 * Fuzzing the zone firewall: the request body is user input, and the rules it
 * compiles replace a device's whole filter table. Any body must be answered
 * without throwing; any config accepted must compile, and the rules as
 * RouterOS prints them back must show no drift, or every apply would rewrite
 * the table (and its counters and tags).
 */
import fc from 'fast-check';
import {
  parseZoneInput, compileZones, planApply, zoneDrift, ROUTER, FORWARD_SERVICES, ROUTER_SERVICES,
  addressError, icmpError, endpointError, zoneHosts,
} from '../zoneFirewall';
import { fuzz, FUZZ_TIMEOUT_MS } from '../../test/fuzz';

jest.setTimeout(FUZZ_TIMEOUT_MS);

const INTERFACES = ['bridge', 'ether1', 'ether2', 'ether5', 'wg0', 'vlan10'];
const live = { lists: ['LAN', 'WAN'], interfaces: INTERFACES };
const ctx = (hasLoopback: boolean, managerIp: string | null) => ({
  services: [{ name: 'ssh', port: '2222' }, { name: 'winbox', port: '8291' }, { name: 'api', port: '8728' }],
  rosMajor: 7, fasttrackHwOffload: true, managerIp, hasLoopback,
});

const zoneName = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('LAN', 'WAN', 'DMZ', 'Guest', 'IoT', 'Zone 1', 'mgmt.v2') },
  { weight: 1, arbitrary: fc.constantFrom('LAN', 'WAN', 'DMZ', 'Guest', 'IoT', 'lan', 'Zone 1', 'router', 'all', 'a'.repeat(41), '') },
  { weight: 1, arbitrary: fc.string({ maxLength: 12 }) },
);
const octet = fc.integer({ min: 0, max: 300 });
const address = fc.oneof(
  fc.tuple(octet, octet, octet, octet).map((o) => o.join('.')),
  fc.tuple(octet, octet, octet, octet, fc.integer({ min: 0, max: 40 })).map(([a, b, c, d, l]) => `${a}.${b}.${c}.${d}/${l}`),
  fc.tuple(octet, octet).map(([a, b]) => `10.0.0.${a}-10.0.0.${b}`),
  fc.constantFrom('smtp.office365.com', 'ONE.one.one.one', 'bad_host', 'example', '-a.com', ''),
  fc.string({ maxLength: 20 }),
);
const ports = fc.oneof(
  fc.integer({ min: 0, max: 70000 }).map(String),
  fc.tuple(fc.integer({ min: 0, max: 70000 }), fc.integer({ min: 0, max: 70000 })).map(([a, b]) => `${a}-${b}`),
  fc.array(fc.integer({ min: 1, max: 65535 }), { minLength: 1, maxLength: 5 }).map((p) => p.join(',')),
  fc.constantFrom('', ' 80 ', '80,', ',80', '80--90'),
  fc.string({ maxLength: 10 }),
);
const custom = fc.record({
  protocol: fc.oneof(fc.constantFrom('tcp', 'udp', 'any', 'icmp', 'other'), fc.string({ maxLength: 5 })),
  ports, src: fc.option(address, { nil: undefined }), dst: fc.option(address, { nil: undefined }),
  icmp: fc.option(fc.oneof(fc.constantFrom('8', '3:4', '0:0-255', '256', '3:9-1'), fc.string({ maxLength: 6 })), { nil: undefined }),
  number: fc.option(fc.oneof(fc.integer({ min: -1, max: 300 }).map(String), fc.string({ maxLength: 4 })), { nil: undefined }),
  log: fc.option(fc.oneof(fc.boolean(), fc.constant('yes')), { nil: undefined }),
}, { requiredKeys: ['protocol'] });
// Mostly rules the checks accept, so accepted configs are common and carry
// custom rules, hostnames and logging into the compiler.
const byte = fc.integer({ min: 0, max: 255 });
const goodAddress = fc.oneof(
  fc.tuple(byte, byte, byte, byte).map((o) => o.join('.')),
  fc.tuple(byte, byte, byte, byte, fc.integer({ min: 0, max: 32 })).map(([a, b, c, d, l]) => `${a}.${b}.${c}.${d}/${l}`),
  fc.tuple(byte, byte).map(([a, b]) => `10.0.0.${Math.min(a, b)}-10.0.0.${Math.max(a, b)}`),
  fc.constantFrom('smtp.office365.com', 'One.One.One.One', 'dns.google', 'a-b.example.net'),
);
const goodPorts = fc.oneof(
  fc.integer({ min: 1, max: 65535 }).map(String),
  fc.tuple(fc.integer({ min: 1, max: 65535 }), fc.integer({ min: 1, max: 65535 })).map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
  fc.uniqueArray(fc.integer({ min: 1, max: 65535 }), { minLength: 1, maxLength: 4 }).map((p) => p.join(',')),
);
const goodCustom = fc.oneof(
  fc.record({ protocol: fc.constantFrom('tcp', 'udp'), ports: goodPorts, src: fc.option(goodAddress, { nil: undefined }), dst: fc.option(goodAddress, { nil: undefined }), log: fc.boolean() }),
  fc.record({ protocol: fc.constant('any'), ports: fc.constant(''), src: goodAddress, dst: fc.option(goodAddress, { nil: undefined }), log: fc.boolean() }),
  fc.record({ protocol: fc.constant('icmp'), ports: fc.constant(''), icmp: fc.constantFrom('', '8', '3:4', '3:0-15'), dst: fc.option(goodAddress, { nil: undefined }), log: fc.boolean() }),
  fc.record({ protocol: fc.constant('other'), ports: fc.constant(''), number: fc.integer({ min: 1, max: 255 }).map(String), src: fc.option(goodAddress, { nil: undefined }), log: fc.boolean() }),
);
const serviceKeys = [...new Set([...Object.keys(FORWARD_SERVICES), ...Object.keys(ROUTER_SERVICES), 'nope'])];
const policy = fc.record({
  action: fc.oneof({ weight: 6, arbitrary: fc.constantFrom('deny', 'allow', 'services') }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) }),
  services: fc.array(fc.constantFrom(...serviceKeys), { minLength: 1, maxLength: 5 }),
  custom: fc.array(fc.oneof({ weight: 6, arbitrary: goodCustom }, { weight: 1, arbitrary: custom }), { maxLength: 4 }),
});

const body = fc.uniqueArray(zoneName, { minLength: 1, maxLength: 4 }).chain((zones) => {
  const targets = [...zones, ROUTER];
  return fc.record({
    config: fc.record({
      zones: fc.constant(zones),
      intra: fc.dictionary(fc.constantFrom(...zones), fc.boolean()),
      policies: fc.dictionary(
        fc.tuple(fc.constantFrom(...zones), fc.constantFrom(...targets)).map(([a, b]) => `${a}>${b}`),
        policy, { maxKeys: 6 }),
      fasttrack: fc.boolean(), logDrops: fc.boolean(),
      quietZones: fc.option(fc.subarray(zones), { nil: undefined }),
      managerAccess: fc.option(fc.constantFrom('management', 'all'), { nil: undefined }),
    }),
    // Each interface in at most one zone, mostly; now and then one twice or one that doesn't exist.
    members: fc.oneof(
      { weight: 5, arbitrary: fc.shuffledSubarray(INTERFACES).map((ifs) => Object.fromEntries(zones.map((z, i) => [z, ifs.filter((_, j) => j % zones.length === i)]))) },
      { weight: 1, arbitrary: fc.dictionary(fc.constantFrom(...zones), fc.subarray([...INTERFACES, 'nosuch'], { maxLength: 3 })) },
    ),
  });
});

/** As RouterOS prints an added rule back: an id, its counters and flags. */
const printed = (adds: { params: Record<string, string> }[]) => adds.map((a, i) => ({
  '.id': `*${(i + 1).toString(16).toUpperCase()}`, ...a.params, invalid: 'false', dynamic: 'false', disabled: 'false', bytes: '0', packets: '0',
}));

describe('zone firewall fuzz', () => {
  it('answers any body without throwing', () => {
    fc.assert(fc.property(fc.oneof(fc.anything(), fc.record({ config: fc.anything(), members: fc.anything() })), (b) => {
      const r = parseZoneInput(b, live);
      expect(r.input === null).toBe(Object.keys(r.errors).length > 0);
    }), fuzz());
  });

  it('compiles whatever it accepts, and sees no drift in the rules as RouterOS prints them', () => {
    fc.assert(fc.property(body, fc.boolean(), fc.option(fc.constantFrom('10.9.0.5', '192.0.2.1'), { nil: null }), (b, lo, mgr) => {
      const { input, errors } = parseZoneInput(b, live);
      if (!input) { expect(Object.keys(errors).length).toBeGreaterThan(0); return; }
      const desired = compileZones(input.config, ctx(lo, mgr));
      expect(desired.length).toBeGreaterThan(0);
      // Every rule names a chain and an action, and every jump has a chain to go to.
      const chains = new Set(desired.map((r) => r.params.chain));
      for (const r of desired) {
        expect(r.params.chain && r.params.action).toBeTruthy();
        if (r.params.action === 'jump') expect(chains.has(r.params['jump-target'])).toBe(true);
      }
      // Accepted rules carry only addresses, ports and ICMP the checks accept.
      for (const p of Object.values(input.config.policies)) {
        for (const c of p.custom) {
          for (const v of [c.src, c.dst]) if (v) expect(endpointError(v)).toBeNull();
          if (c.icmp) expect(icmpError(c.icmp)).toBeNull();
          if (c.src && /^[\d./-]+$/.test(c.src)) expect(addressError(c.src)).toBeNull();
        }
      }
      expect(zoneHosts(input.config)).toEqual([...new Set(zoneHosts(input.config))]);
      // Applied to an empty table, then read back: nothing left to do.
      const plan = planApply([], desired);
      expect(plan.remove).toEqual([]);
      expect(plan.add).toHaveLength(desired.length);
      const device = printed(plan.add);
      expect(zoneDrift(device, desired)).toBeNull();
      // And compiling again gives the same rules.
      expect(compileZones(input.config, ctx(lo, mgr))).toEqual(desired);
    }), fuzz());
  });

  it('checks addresses, ICMP and endpoints without throwing', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (s) => {
      addressError(s); icmpError(s); endpointError(s);
    }), fuzz());
  });
});
