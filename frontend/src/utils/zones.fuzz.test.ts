/**
 * The zone editor checks a custom rule as you type; the server checks it
 * again on save. If they disagree, a rule the form passes is refused on save,
 * or the form refuses one the server would take. Every generated rule must get
 * the same answer from both. The server's checks are loaded from the backend
 * source at run time, so neither side's build reaches into the other's.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { customError, addressError, icmpError, endpointError, isHostname } from './zones';
import type { ZoneCustomService } from '../services/api';
import { fuzz, FUZZ_TIMEOUT_MS } from '../test/fuzz';

interface Backend {
  parseZoneInput(body: unknown, live: { lists: string[]; interfaces: string[] }): { input: { config: { policies: Record<string, { custom: unknown[] }> } } | null };
  addressError(v: string): string | null;
  icmpError(v: string): string | null;
  endpointError(v: string): string | null;
  isHostname(v: string): boolean;
}
let backend: Backend;
beforeAll(async () => {
  const url = new URL('../../../backend/src/utils/zoneFirewall.ts', import.meta.url).href;
  backend = await import(/* @vite-ignore */ url) as Backend;
});

/** Does the server keep this rule in a pair that allows only these? */
function serverKeeps(c: ZoneCustomService): boolean {
  const { input } = backend.parseZoneInput({
    config: { zones: ['LAN', 'WAN'], intra: {}, fasttrack: true, logDrops: true,
      policies: { 'WAN>LAN': { action: 'services', services: ['ping'], custom: [c] } } },
    members: { LAN: [], WAN: [] },
  }, { lists: [], interfaces: [] });
  return !!input && input.config.policies['WAN>LAN'].custom.length === 1;
}

const byte = fc.integer({ min: 0, max: 300 });
const ip = fc.tuple(byte, byte, byte, byte).map((o) => o.join('.'));
const space = fc.constantFrom('', ' ', '  ', '\t');
const endpoint = fc.oneof(
  ip, fc.tuple(ip, fc.integer({ min: 0, max: 40 })).map(([a, l]) => `${a}/${l}`),
  fc.tuple(ip, ip).map(([a, b]) => `${a}-${b}`),
  fc.constantFrom('smtp.office365.com', 'One.One.One.One', 'a.b', 'host', '-a.com', 'a..b', '1.2.3.com', 'x.123'),
  fc.tuple(space, ip, space).map(([a, b, c]) => a + b + c),
  fc.string({ maxLength: 16 }),
);
const ports = fc.oneof(
  fc.integer({ min: 0, max: 70000 }).map(String),
  fc.tuple(fc.integer({ min: 0, max: 70000 }), fc.integer({ min: 0, max: 70000 })).map(([a, b]) => `${a}-${b}`),
  fc.array(fc.integer({ min: 0, max: 70000 }), { minLength: 1, maxLength: 4 }).map((p) => p.join(',')),
  fc.constantFrom('', ' ', ' 80 ', '80, 443', '80,', '0'),
  fc.string({ maxLength: 8 }),
);
const rule: fc.Arbitrary<ZoneCustomService> = fc.record({
  protocol: fc.constantFrom('tcp', 'udp', 'any', 'icmp', 'other'),
  ports,
  src: fc.option(endpoint, { nil: undefined }),
  dst: fc.option(endpoint, { nil: undefined }),
  icmp: fc.option(fc.oneof(fc.constantFrom('8', '3:4', '3:0-15', '3:15-0', '256', ' 8'), fc.string({ maxLength: 5 })), { nil: undefined }),
  number: fc.option(fc.oneof(fc.integer({ min: -1, max: 300 }).map(String), fc.constantFrom('089', ' 89', '6', '17', '1')), { nil: undefined }),
  log: fc.option(fc.boolean(), { nil: undefined }),
}, { requiredKeys: ['protocol', 'ports'] })
  // As the form edits it: choosing anything but TCP or UDP empties the ports.
  .map((c) => (c.protocol === 'tcp' || c.protocol === 'udp' ? c : { ...c, ports: '' }));

describe('zone checks: form and server agree (fuzz)', () => {
  it('on every custom rule', () => {
    fc.assert(fc.property(rule, (c) => {
      expect({ rule: c, formOk: customError(c) === null }).toEqual({ rule: c, formOk: serverKeeps(c) });
    }), fuzz());
  }, FUZZ_TIMEOUT_MS);

  it('on addresses, ICMP types and hostnames', () => {
    fc.assert(fc.property(fc.oneof(endpoint, fc.string({ maxLength: 12 })), (v) => {
      expect({ v, address: addressError(v) === null, icmp: icmpError(v) === null, endpoint: endpointError(v) === null, host: isHostname(v) })
        .toEqual({ v, address: backend.addressError(v) === null, icmp: backend.icmpError(v) === null, endpoint: backend.endpointError(v) === null, host: backend.isHostname(v) });
    }), fuzz());
  }, FUZZ_TIMEOUT_MS);
});
