/**
 * Fuzzing the NetFlow v9 / IPFIX decoder. It reads UDP packets from the
 * network, unauthenticated, so no packet may throw, hang, or yield a flow
 * with impossible values. Two kinds of input: raw bytes behind a plausible
 * header, and well-formed packets whose templates and data are random, which
 * reach far deeper into the parser than random bytes do.
 */
import fc from 'fast-check';
import { decodePacket, type TemplateCache, type FlowRecord } from '../decoder';
import { fuzz, FUZZ_TIMEOUT_MS } from '../../../test/fuzz';

jest.setTimeout(FUZZ_TIMEOUT_MS);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function sane(f: FlowRecord): void {
  for (const a of [f.srcAddr, f.dstAddr, f.natSrcAddr, f.natDstAddr]) {
    if (a === undefined) continue;
    expect(typeof a).toBe('string');
    const v4 = IPV4.exec(a);
    if (v4) expect(v4.slice(1).every((o) => Number(o) <= 255)).toBe(true);
    else expect(a).toMatch(/^[0-9a-f:]+$/);
  }
  for (const p of [f.srcPort, f.dstPort, f.natSrcPort, f.natDstPort]) {
    if (p !== undefined) expect(Number.isInteger(p) && p >= 0 && p <= 0xffffffffffff).toBe(true);
  }
  for (const n of [f.bytes, f.packets, f.protocol, f.tcpFlags, f.startMs, f.endMs]) {
    if (n !== undefined) expect(Number.isFinite(n) && n >= 0).toBe(true);
  }
  if (f.tcpFlags !== undefined) expect(f.tcpFlags).toBeLessThanOrEqual(0xff);
}

function decodeAll(packets: Buffer[]): void {
  const cache: TemplateCache = new Map();
  for (const p of packets) {
    const started = Date.now();
    const r = decodePacket(p, '192.0.2.1', cache);
    // A packet is at most 64 KiB; anything near a second is a hang.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(Array.isArray(r.flows)).toBe(true);
    expect(r.templatesParsed).toBeGreaterThanOrEqual(0);
    expect(r.recordsWithoutTemplate).toBeGreaterThanOrEqual(0);
    r.flows.forEach(sane);
  }
}

// ─── Building packets ────────────────────────────────────────────────────────

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/** The fields RouterOS exports, plus anything else, at the lengths seen and odd ones. */
const KNOWN_FIELDS = [1, 2, 4, 6, 7, 8, 11, 12, 21, 22, 27, 28, 150, 151, 152, 153, 160, 225, 226, 227, 228, 281, 282];
const field = fc.record({
  id: fc.oneof(fc.constantFrom(...KNOWN_FIELDS), fc.integer({ min: 0, max: 0xffff })),
  length: fc.oneof(fc.constantFrom(1, 2, 4, 8, 16), fc.integer({ min: 0, max: 40 }), fc.constant(0xffff)),
  enterprise: fc.boolean(),
});
const template = fc.record({
  id: fc.oneof(fc.integer({ min: 256, max: 300 }), fc.integer({ min: 0, max: 0xffff })),
  fields: fc.array(field, { maxLength: 30 }),
});
type Tpl = { id: number; fields: { id: number; length: number; enterprise: boolean }[] };

function templateSet(ipfix: boolean, tpls: Tpl[]): Buffer {
  const parts: Buffer[] = [];
  for (const t of tpls) {
    parts.push(u16(t.id), u16(t.fields.length));
    for (const f of t.fields) {
      const id = ipfix && f.enterprise ? f.id | 0x8000 : f.id & 0x7fff;
      parts.push(u16(id), u16(ipfix ? f.length : Math.min(f.length, 0xfffe)));
      if (ipfix && f.enterprise) parts.push(u32(29484));
    }
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([u16(ipfix ? 2 : 0), u16(body.length + 4), body]);
}

function set(id: number, body: Uint8Array): Buffer {
  return Buffer.concat([u16(id), u16(body.length + 4), Buffer.from(body)]);
}

function packet(ipfix: boolean, sets: Buffer[], h: { a: number; b: number; source: number }, lengthFix?: number): Buffer {
  const body = Buffer.concat(sets);
  const header = ipfix
    ? Buffer.concat([u16(10), u16(lengthFix ?? body.length + 16), u32(h.a), u32(h.b), u32(h.source)])
    : Buffer.concat([u16(9), u16(sets.length), u32(h.a), u32(h.b), u32(0), u32(h.source)]);
  return Buffer.concat([header, body]);
}

const header = fc.record({ a: fc.nat(), b: fc.nat(), source: fc.oneof(fc.constant(0), fc.nat()) });

// ─── Properties ──────────────────────────────────────────────────────────────

describe('NetFlow decoder fuzz', () => {
  it('survives any bytes behind a v9 or IPFIX version', () => {
    fc.assert(fc.property(
      fc.constantFrom(5, 9, 10, 0, 0xffff), fc.uint8Array({ maxLength: 1500 }),
      (version, rest) => decodeAll([Buffer.concat([u16(version), Buffer.from(rest)])]),
    ), fuzz());
  });

  it('survives random templates followed by random data, in one packet or two', () => {
    fc.assert(fc.property(
      fc.boolean(), header, fc.array(template, { minLength: 1, maxLength: 4 }),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.uint8Array({ maxLength: 600 })), { maxLength: 6 }),
      fc.boolean(), fc.option(fc.integer({ min: 0, max: 0xffff }), { nil: undefined }),
      (ipfix, h, tpls, data, split, lengthFix) => {
        const tset = templateSet(ipfix, tpls);
        const dsets = data.map(([which, bytes]) => set(tpls[which % tpls.length].id, bytes));
        const packets = split
          ? [packet(ipfix, [tset], h), packet(ipfix, dsets, h, lengthFix)]
          : [packet(ipfix, [tset, ...dsets], h, lengthFix)];
        decodeAll(packets);
      },
    ), fuzz());
  });

  it('survives a well-formed packet cut short or with a byte changed', () => {
    fc.assert(fc.property(
      fc.boolean(), header, template, fc.uint8Array({ minLength: 1, maxLength: 400 }),
      fc.nat(), fc.integer({ min: 0, max: 255 }),
      (ipfix, h, tpl, data, at, byte) => {
        const whole = packet(ipfix, [templateSet(ipfix, [tpl]), set(tpl.id, data)], h);
        const cut = whole.subarray(0, at % (whole.length + 1));
        const flipped = Buffer.from(whole);
        flipped[at % whole.length] = byte;
        decodeAll([cut]);
        decodeAll([flipped]);
      },
    ), fuzz());
  });

  it('decodes the flow it was given, whatever the addresses and counters', () => {
    // Template: src IPv4, dst IPv4, src port, dst port, protocol, bytes (8), packets (4).
    const tpl: Tpl = { id: 300, fields: [
      { id: 8, length: 4, enterprise: false }, { id: 12, length: 4, enterprise: false },
      { id: 7, length: 2, enterprise: false }, { id: 11, length: 2, enterprise: false },
      { id: 4, length: 1, enterprise: false }, { id: 1, length: 8, enterprise: false }, { id: 2, length: 4, enterprise: false },
    ] };
    const octet = fc.integer({ min: 0, max: 255 });
    fc.assert(fc.property(
      fc.boolean(), header, fc.tuple(octet, octet, octet, octet), fc.tuple(octet, octet, octet, octet),
      fc.integer({ min: 0, max: 0xffff }), fc.integer({ min: 0, max: 0xffff }), octet,
      fc.bigInt({ min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER) }), fc.nat(),
      (ipfix, h, src, dst, sport, dport, proto, bytes, pkts) => {
        const b = Buffer.alloc(8); b.writeBigUInt64BE(bytes);
        const record = Buffer.concat([Buffer.from(src), Buffer.from(dst), u16(sport), u16(dport), Buffer.from([proto]), b, u32(pkts)]);
        const r = decodePacket(packet(ipfix, [templateSet(ipfix, [tpl]), set(tpl.id, record)], h), '192.0.2.1', new Map());
        expect(r.flows).toHaveLength(1);
        expect(r.flows[0]).toEqual(expect.objectContaining({
          srcAddr: src.join('.'), dstAddr: dst.join('.'), srcPort: sport, dstPort: dport, protocol: proto,
          bytes: Number(bytes), packets: pkts,
        }));
      },
    ), fuzz());
  });
});
