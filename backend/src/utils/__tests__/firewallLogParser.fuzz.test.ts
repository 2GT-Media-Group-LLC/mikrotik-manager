/**
 * Fuzzing the firewall log parser. Log lines come from devices, so any text
 * must parse or be refused without throwing; and every line RouterOS could
 * write must read back the fields it carries, whatever the chain is called.
 * The chain bug in #369 (lines from a jump chain dropped) is the kind this
 * catches.
 */
import fc from 'fast-check';
import { parseFirewallLog } from '../firewallLogParser';
import { fuzz, FUZZ_TIMEOUT_MS } from '../../test/fuzz';
import { firewallLine, type GeneratedLine } from './firewallLineArbitrary';

jest.setTimeout(FUZZ_TIMEOUT_MS);

describe('firewall log parser fuzz', () => {
  it('never throws on any text', () => {
    fc.assert(fc.property(fc.string({ maxLength: 400, unit: 'grapheme-ascii' }), (s) => { parseFirewallLog(s); }), fuzz());
    fc.assert(fc.property(fc.string({ maxLength: 200, unit: 'binary' }), (s) => { parseFirewallLog(s); }), fuzz());
  });

  it('reads back every field of a line RouterOS could write', () => {
    fc.assert(fc.property(firewallLine, (l: GeneratedLine) => {
      const e = parseFirewallLog(l.message);
      expect(e).not.toBeNull();
      expect(e).toEqual(expect.objectContaining({
        prefix: l.prefix, chain: l.baseChain, protocol: l.protocol.toLowerCase(),
        srcIp: l.src.ip, dstIp: l.dst.ip, srcPort: l.src.port, dstPort: l.dst.port,
        inInterface: l.inIf ?? undefined, outInterface: l.outIf ?? undefined,
      }));
      if (l.builtIn) expect(e && 'ruleChain' in e).toBe(false);
      else expect(e?.ruleChain).toBe(l.chain);
    }), fuzz());
  });
});
