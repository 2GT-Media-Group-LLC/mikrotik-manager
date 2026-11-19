/**
 * Fuzzing smaller checks on user input: the DoH server URL (#468) and the
 * bridge port move planner (#258, #466). Neither may throw, and what they
 * accept must be what RouterOS can take.
 */
import fc from 'fast-check';
import { dohServerError } from '../dnsDoh';
import { planBridgePortMove, type RosRow } from '../bridgePortMove';
import { fuzz, FUZZ_TIMEOUT_MS } from '../../test/fuzz';

jest.setTimeout(FUZZ_TIMEOUT_MS);

describe('input check fuzz', () => {
  it('takes only https URLs with a host and nothing RouterOS would split or quote', () => {
    const url = fc.oneof(
      fc.webUrl({ validSchemes: ['https', 'http'], withQueryParameters: true, withFragments: true }),
      fc.string({ maxLength: 60 }).map((s) => `https://${s}`),
      fc.string({ maxLength: 60 }),
      fc.anything(),
    );
    fc.assert(fc.property(url, (v) => {
      const err = dohServerError(v);
      if (err !== null) { expect(typeof err).toBe('string'); return; }
      if (v === '') return;
      expect(typeof v).toBe('string');
      const s = v as string;
      expect(s.length).toBeLessThanOrEqual(255);
      expect(s).not.toMatch(/[\s,;"'\\]/);
      const u = new URL(s);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).not.toBe('');
    }), fuzz());
  });

  it('plans bridge moves without throwing, touching only interfaces that exist', () => {
    const name = fc.constantFrom('bridge', 'guest', 'ether1', 'ether2', 'ether3', 'wifi1', 'eoip1', 'wg0', 'gre1', 'nope', '');
    const type = fc.constantFrom('bridge', 'ether', 'wifi', 'eoip', 'wg', 'gre-tunnel', 'vlan', 'pppoe-out', 'vxlan', '');
    const yes = fc.constantFrom('true', 'false', 'yes', 'no', undefined);
    const iface = fc.record({ name, type, slave: yes }) as fc.Arbitrary<RosRow>;
    const port = fc.record({ '.id': fc.constantFrom('*1', '*2', '*3'), interface: name, bridge: name, dynamic: yes }) as fc.Arbitrary<RosRow>;
    const vlan = fc.record({ '.id': fc.constantFrom('*V1', '*V2'), bridge: name, 'vlan-ids': fc.constantFrom('1', '10', '10,20'),
      tagged: fc.constantFrom('', 'bridge,ether2', 'ether1'), untagged: fc.constantFrom('', 'ether3'), dynamic: yes }) as fc.Arbitrary<RosRow>;
    fc.assert(fc.property(
      fc.array(fc.oneof(name, fc.string({ maxLength: 6 })), { maxLength: 4 }), fc.option(name, { nil: null }), fc.boolean(),
      fc.uniqueArray(iface, { maxLength: 8, selector: (i) => i.name }), fc.array(port, { maxLength: 5 }), fc.array(vlan, { maxLength: 3 }),
      (ports, target, createTarget, interfaces, bridgePorts, bridgeVlans) => {
        const r = planBridgePortMove({ ports, target, createTarget, interfaces, bridgePorts, bridgeVlans });
        if (!r.ok) { expect(r.error).toEqual(expect.any(String)); return; }
        const names = new Set(interfaces.map((i) => i.name));
        for (const op of r.plan.ops) {
          expect(names.has(op.port)).toBe(true);
          expect(interfaces.find((i) => i.name === op.port)?.type).not.toMatch(/^(bridge|wg|gre-tunnel|pppoe-out)$/);
          if (op.action !== 'add') expect(op.id).toBeTruthy();
        }
      },
    ), fuzz());
  });
});
