/** Firewall packet log lines as RouterOS writes them, for the fuzz tests. */
import fc from 'fast-check';

export interface GeneratedLine {
  message: string;
  prefix: string;
  chain: string;
  builtIn: boolean;
  baseChain: 'input' | 'forward' | 'output';
  inIf: string | null;
  outIf: string | null;
  protocol: string;
  src: { ip: string; port?: number };
  dst: { ip: string; port?: number };
}

const word = fc.stringMatching(/^[A-Za-z0-9#_.!=-][A-Za-z0-9#_.:!=-]{0,11}$/);
/** A log prefix: words, a tag perhaps, possibly empty. Never "<word>: in:", which would be a chain. */
const prefix = fc.array(word, { maxLength: 4 }).map((w) => w.join(' '))
  .filter((p) => !/: in:/.test(`${p} `));
const customChain = fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,23}$/);
const chain = fc.oneof(fc.constantFrom('input', 'forward', 'output'), customChain);
const iface = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/);
const octet = fc.integer({ min: 0, max: 255 });
const v4 = fc.tuple(octet, octet, octet, octet).map((o) => o.join('.'));
const v6 = fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }).map((g) => g.map((x) => x.toString(16)).join(':'));
const port = fc.integer({ min: 0, max: 65535 });

export const firewallLine: fc.Arbitrary<GeneratedLine> = fc.record({
  prefix, chain, family: fc.constantFrom(4, 6),
  inIf: fc.option(iface, { nil: null }), outIf: fc.option(iface, { nil: null }),
  proto: fc.constantFrom('TCP', 'UDP', 'ICMP', 'GRE'), flags: fc.constantFrom('SYN', 'ACK,FIN', 'SYN,ACK', ''),
  state: fc.constantFrom('new', 'established', 'invalid', ''),
  srcV4: v4, dstV4: v4, srcV6: v6, dstV6: v6, sport: port, dport: port, len: fc.integer({ min: 20, max: 65535 }),
}).filter((r) => r.inIf !== null || r.outIf !== null).map((r) => {
  const builtIn = ['input', 'forward', 'output'].includes(r.chain);
  // Where a custom chain was jumped to from, by the interfaces, as the parser reads it.
  const baseChain = builtIn ? r.chain as GeneratedLine['baseChain'] : r.outIf === null ? 'input' : r.inIf === null ? 'output' : 'forward';
  const withPorts = r.proto === 'TCP' || r.proto === 'UDP';
  const ep = (ip: string, p: number) => (r.family === 6 ? (withPorts ? `[${ip}]:${p}` : ip) : (withPorts ? `${ip}:${p}` : ip));
  const src = r.family === 6 ? r.srcV6 : r.srcV4;
  const dst = r.family === 6 ? r.dstV6 : r.dstV4;
  const protoText = r.proto === 'TCP' && r.flags ? `TCP (${r.flags})` : r.proto === 'ICMP' ? 'ICMP (type 8, code 0)' : r.proto;
  const message = `${r.prefix ? `${r.prefix} ` : ''}${r.chain}: in:${r.inIf ?? '(unknown 0)'} out:${r.outIf ?? '(unknown 0)'}, `
    + `${r.state ? `connection-state:${r.state} ` : ''}proto ${protoText}, ${ep(src, r.sport)}->${ep(dst, r.dport)}, len ${r.len}`;
  return {
    message, prefix: r.prefix, chain: r.chain, builtIn, baseChain, inIf: r.inIf, outIf: r.outIf, protocol: r.proto,
    src: { ip: src, ...(withPorts ? { port: r.sport } : {}) }, dst: { ip: dst, ...(withPorts ? { port: r.dport } : {}) },
  };
});
