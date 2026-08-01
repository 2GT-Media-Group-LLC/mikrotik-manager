import { decodePacket, pruneTemplateCache, TemplateCache } from '../decoder';

// ─── Fixture builders ─────────────────────────────────────────────────────────

interface FieldSpec { id: number; length: number }

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function ipv4(addr: string): Buffer {
  return Buffer.from(addr.split('.').map(Number));
}

function templateBody(templateId: number, fields: FieldSpec[]): Buffer {
  return Buffer.concat([
    u16(templateId),
    u16(fields.length),
    ...fields.flatMap((f) => [u16(f.id), u16(f.length)]),
  ]);
}

function flowset(setId: number, body: Buffer, padTo4 = true): Buffer {
  let length = 4 + body.length;
  let padding = Buffer.alloc(0);
  if (padTo4 && length % 4 !== 0) {
    padding = Buffer.alloc(4 - (length % 4));
    length += padding.length;
  }
  return Buffer.concat([u16(setId), u16(length), body, padding]);
}

function v9Packet(sourceId: number, flowsets: Buffer[]): Buffer {
  const body = Buffer.concat(flowsets);
  return Buffer.concat([
    u16(9), // version
    u16(flowsets.length), // record count (not used by decoder)
    u32(12345), // sysUptime
    u32(1700000000), // unix secs
    u32(1), // sequence
    u32(sourceId),
    body,
  ]);
}

function ipfixPacket(domainId: number, sets: Buffer[]): Buffer {
  const body = Buffer.concat(sets);
  return Buffer.concat([
    u16(10), // version
    u16(16 + body.length), // total length
    u32(1700000000), // export time
    u32(1), // sequence
    u32(domainId),
    body,
  ]);
}

// Standard 7-field record layout used in most tests:
// srcIPv4(8), dstIPv4(12), srcPort(7), dstPort(11), protocol(4), bytes(1, 4B), packets(2, 4B)
const V9_FIELDS: FieldSpec[] = [
  { id: 8, length: 4 },
  { id: 12, length: 4 },
  { id: 7, length: 2 },
  { id: 11, length: 2 },
  { id: 4, length: 1 },
  { id: 1, length: 4 },
  { id: 2, length: 4 },
];

function record(src: string, dst: string, srcPort: number, dstPort: number, proto: number, bytes: number, packets: number): Buffer {
  return Buffer.concat([
    ipv4(src),
    ipv4(dst),
    u16(srcPort),
    u16(dstPort),
    Buffer.from([proto]),
    u32(bytes),
    u32(packets),
  ]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NetFlow v9 decoding', () => {
  it('decodes a template followed by data records in the same packet', () => {
    const cache: TemplateCache = new Map();
    const packet = v9Packet(0, [
      flowset(0, templateBody(256, V9_FIELDS)),
      flowset(256, Buffer.concat([
        record('192.168.1.10', '93.184.216.34', 54321, 443, 6, 1500, 10),
        record('93.184.216.34', '192.168.1.10', 443, 54321, 6, 90000, 60),
      ])),
    ]);

    const result = decodePacket(packet, '10.0.0.1', cache);
    expect(result.templatesParsed).toBe(1);
    expect(result.flows).toHaveLength(2);
    expect(result.flows[0]).toEqual({
      srcAddr: '192.168.1.10',
      dstAddr: '93.184.216.34',
      srcPort: 54321,
      dstPort: 443,
      protocol: 6,
      bytes: 1500,
      packets: 10,
    });
    expect(result.flows[1].bytes).toBe(90000);
  });

  it('drops data that arrives before its template, then decodes once the template is known', () => {
    const cache: TemplateCache = new Map();
    const dataOnly = v9Packet(0, [
      flowset(256, record('192.168.1.10', '1.1.1.1', 50000, 53, 17, 120, 2)),
    ]);

    const first = decodePacket(dataOnly, '10.0.0.1', cache);
    expect(first.flows).toHaveLength(0);
    expect(first.recordsWithoutTemplate).toBe(1);

    const templateOnly = v9Packet(0, [flowset(0, templateBody(256, V9_FIELDS))]);
    decodePacket(templateOnly, '10.0.0.1', cache);

    const second = decodePacket(dataOnly, '10.0.0.1', cache);
    expect(second.flows).toHaveLength(1);
    expect(second.flows[0].dstPort).toBe(53);
  });

  it('keeps templates from different exporters separate', () => {
    const cache: TemplateCache = new Map();
    const templateOnly = v9Packet(0, [flowset(0, templateBody(256, V9_FIELDS))]);
    decodePacket(templateOnly, '10.0.0.1', cache);

    const dataOnly = v9Packet(0, [
      flowset(256, record('192.168.1.10', '1.1.1.1', 50000, 53, 17, 120, 2)),
    ]);
    // Different exporter never sent its template
    const other = decodePacket(dataOnly, '10.0.0.2', cache);
    expect(other.flows).toHaveLength(0);
    expect(other.recordsWithoutTemplate).toBe(1);
  });

  it('ignores trailing padding in data flowsets', () => {
    const cache: TemplateCache = new Map();
    decodePacket(v9Packet(0, [flowset(0, templateBody(256, V9_FIELDS))]), '10.0.0.1', cache);

    // One 21-byte record + flowset padding to a 4-byte boundary
    const packet = v9Packet(0, [
      flowset(256, record('192.168.1.20', '8.8.8.8', 40000, 443, 17, 555, 5)),
    ]);
    const result = decodePacket(packet, '10.0.0.1', cache);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].bytes).toBe(555);
  });

  it('ignores options templates and unknown packet versions', () => {
    const cache: TemplateCache = new Map();
    const optionsSet = v9Packet(0, [flowset(1, Buffer.alloc(8))]);
    expect(decodePacket(optionsSet, '10.0.0.1', cache).flows).toHaveLength(0);

    const v5ish = Buffer.alloc(24);
    v5ish.writeUInt16BE(5, 0);
    expect(decodePacket(v5ish, '10.0.0.1', cache).flows).toHaveLength(0);
  });
});

describe('IPFIX decoding', () => {
  it('decodes IPFIX templates (set 2) and 64-bit counters', () => {
    const cache: TemplateCache = new Map();
    const fields: FieldSpec[] = [
      { id: 8, length: 4 },
      { id: 12, length: 4 },
      { id: 7, length: 2 },
      { id: 11, length: 2 },
      { id: 4, length: 1 },
      { id: 1, length: 8 }, // octetDeltaCount as 64-bit
      { id: 2, length: 8 },
    ];
    const bigBytes = Buffer.alloc(8);
    bigBytes.writeBigUInt64BE(5_000_000_000n);
    const bigPackets = Buffer.alloc(8);
    bigPackets.writeBigUInt64BE(4_000_000n);
    const dataRecord = Buffer.concat([
      ipv4('192.168.1.50'),
      ipv4('142.250.80.78'),
      u16(51000),
      u16(443),
      Buffer.from([17]),
      bigBytes,
      bigPackets,
    ]);

    const packet = ipfixPacket(7, [
      flowset(2, templateBody(300, fields)),
      flowset(300, dataRecord),
    ]);

    const result = decodePacket(packet, '10.0.0.1', cache);
    expect(result.templatesParsed).toBe(1);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].bytes).toBe(5_000_000_000);
    expect(result.flows[0].protocol).toBe(17);
  });

  it('skips enterprise-specific fields by length without corrupting the record walk', () => {
    const cache: TemplateCache = new Map();
    // Template: srcIPv4, dstIPv4, enterprise field (id 0x8000|99, 4 bytes + PEN), bytes
    const templateBuf = Buffer.concat([
      u16(301),
      u16(6),
      u16(8), u16(4),
      u16(12), u16(4),
      u16(0x8000 | 99), u16(4), u32(14988), // enterprise number (MikroTik PEN)
      u16(1), u16(4),
      u16(2), u16(4),
      u16(4), u16(1),
    ]);
    const dataRecord = Buffer.concat([
      ipv4('192.168.1.60'),
      ipv4('9.9.9.9'),
      u32(0xdeadbeef), // enterprise value — must be skipped
      u32(777),
      u32(7),
      Buffer.from([6]),
    ]);
    const packet = ipfixPacket(7, [
      flowset(2, templateBuf),
      flowset(301, dataRecord),
    ]);

    const result = decodePacket(packet, '10.0.0.1', cache);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].bytes).toBe(777);
    expect(result.flows[0].protocol).toBe(6);
  });

  it('decodes IPv6 flow records', () => {
    const cache: TemplateCache = new Map();
    const fields: FieldSpec[] = [
      { id: 27, length: 16 },
      { id: 28, length: 16 },
      { id: 7, length: 2 },
      { id: 11, length: 2 },
      { id: 4, length: 1 },
      { id: 1, length: 4 },
      { id: 2, length: 4 },
    ];
    const src = Buffer.alloc(16);
    src[0] = 0xfd;
    src[15] = 0x01;
    const dst = Buffer.alloc(16);
    dst[0] = 0x26;
    dst[1] = 0x07;
    const dataRecord = Buffer.concat([src, dst, u16(50000), u16(443), Buffer.from([6]), u32(2048), u32(4)]);

    const packet = ipfixPacket(7, [
      flowset(2, templateBody(302, fields)),
      flowset(302, dataRecord),
    ]);
    const result = decodePacket(packet, '10.0.0.1', cache);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].srcAddr).toMatch(/^fd00:/);
  });

  it('renders IPv6 canonically and unwraps IPv4-mapped addresses', () => {
    const V6_FIELDS: FieldSpec[] = [
      { id: 27, length: 16 },
      { id: 28, length: 16 },
      { id: 1, length: 4 },
    ];
    // Decode one flow whose src/dst are the given raw 16-byte addresses
    const decodePair = (src: Buffer, dst: Buffer, templateId: number) => {
      const cache: TemplateCache = new Map();
      const packet = ipfixPacket(7, [
        flowset(2, templateBody(templateId, V6_FIELDS)),
        flowset(templateId, Buffer.concat([src, dst, u32(100)])),
      ]);
      return decodePacket(packet, '10.0.0.1', cache).flows[0];
    };

    // 2001:db8::1 — interior zero run compressed, not fully expanded
    const compressible = Buffer.alloc(16);
    compressible.writeUInt16BE(0x2001, 0);
    compressible.writeUInt16BE(0x0db8, 2);
    compressible[15] = 1;
    // ::ffff:192.0.2.1 — IPv4-mapped
    const mapped = Buffer.alloc(16);
    mapped.writeUInt16BE(0xffff, 10);
    Buffer.from([192, 0, 2, 1]).copy(mapped, 12);

    const flow = decodePair(compressible, mapped, 310);
    expect(flow.srcAddr).toBe('2001:db8::1');
    expect(flow.dstAddr).toBe('192.0.2.1');

    // Loopback (all zeros but the last group) and a no-run address
    const loopback = Buffer.alloc(16);
    loopback[15] = 1;
    const noRun = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) noRun.writeUInt16BE(0x2000 + i, i * 2);

    const flow2 = decodePair(loopback, noRun, 311);
    expect(flow2.srcAddr).toBe('::1');
    expect(flow2.dstAddr).toBe('2000:2001:2002:2003:2004:2005:2006:2007');
  });
});

describe('malformed / hostile packets', () => {
  // Regression: a template field of length 0 made a record zero-width, so the
  // data-set loop never advanced and spun forever — a single unauthenticated UDP
  // packet could hang the whole (single-threaded) backend. If this regresses the
  // decode call never returns, so these tests hang rather than fail — that is
  // still a loud CI failure, and the cache assertions pin the actual guard.
  it('rejects a template containing a zero-length field instead of looping forever', () => {
    const cache: TemplateCache = new Map();
    const packet = ipfixPacket(1, [
      flowset(2, templateBody(256, [{ id: 1, length: 0 }])),
      flowset(256, Buffer.alloc(4)),
    ]);

    const result = decodePacket(packet, '10.0.0.9', cache);
    expect(result.templatesParsed).toBe(0);
    expect(cache.size).toBe(0);
    expect(result.flows).toHaveLength(0);
  });

  it('rejects the whole template when a zero-length field sits among valid ones', () => {
    const cache: TemplateCache = new Map();
    const packet = ipfixPacket(1, [
      flowset(2, templateBody(257, [
        { id: 8, length: 4 },
        { id: 12, length: 0 }, // malformed
        { id: 1, length: 4 },
      ])),
    ]);

    expect(decodePacket(packet, '10.0.0.9', cache).templatesParsed).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('terminates on a variable-length field whose length byte is zero', () => {
    const cache: TemplateCache = new Map();
    const packet = ipfixPacket(1, [
      flowset(2, templateBody(258, [{ id: 1, length: 0xffff }])),
      flowset(258, Buffer.alloc(8)), // every length byte reads as 0
    ]);

    const result = decodePacket(packet, '10.0.0.9', cache);
    expect(result.templatesParsed).toBe(1);
    expect(result.flows).toHaveLength(0);
  });

  it('handles absurd field lengths and truncated records without throwing', () => {
    const cache: TemplateCache = new Map();
    const huge = ipfixPacket(1, [
      flowset(2, templateBody(259, [{ id: 1, length: 60000 }])),
      flowset(259, Buffer.alloc(8)),
    ]);
    expect(() => decodePacket(huge, '10.0.0.9', cache)).not.toThrow();

    // Declares a 16-byte IPv6 field but supplies only 4 bytes of data
    const truncated = ipfixPacket(1, [
      flowset(2, templateBody(260, [{ id: 27, length: 16 }, { id: 1, length: 4 }])),
      flowset(260, Buffer.alloc(4)),
    ]);
    const result = decodePacket(truncated, '10.0.0.9', cache);
    expect(result.flows).toHaveLength(0);
  });

  it('bounds the template cache by TTL and hard cap', () => {
    const cache: TemplateCache = new Map();
    const mkTemplate = (lastUsed: number) => ({
      fields: [{ id: 1, length: 4, enterprise: false }],
      minLength: 4,
      lastUsed,
    });

    // Idle templates age out; recently-used ones survive
    cache.set('a', mkTemplate(0));
    cache.set('b', mkTemplate(9_000));
    expect(pruneTemplateCache(cache, 5_000, 100, 10_000)).toBe(1);
    expect([...cache.keys()]).toEqual(['b']);

    // Hard cap evicts least-recently-used first
    cache.clear();
    for (let i = 0; i < 50; i++) cache.set(`t${i}`, mkTemplate(i));
    pruneTemplateCache(cache, 1_000_000, 10, 100);
    expect(cache.size).toBe(10);
    expect(cache.has('t49')).toBe(true); // newest kept
    expect(cache.has('t0')).toBe(false); // oldest evicted
  });

  it('keeps a template alive while it is actively decoding data', () => {
    const cache: TemplateCache = new Map();
    decodePacket(v9Packet(0, [flowset(0, templateBody(256, V9_FIELDS))]), '10.0.0.1', cache);
    const key = [...cache.keys()][0];
    cache.get(key)!.lastUsed = 0; // pretend it went idle

    decodePacket(
      v9Packet(0, [flowset(256, record('192.168.1.10', '1.1.1.1', 50000, 53, 17, 120, 2))]),
      '10.0.0.1',
      cache
    );
    expect(cache.get(key)!.lastUsed).toBeGreaterThan(0);
  });

  it('still decodes valid traffic after rejecting a malformed template', () => {
    const cache: TemplateCache = new Map();
    decodePacket(
      ipfixPacket(1, [flowset(2, templateBody(256, [{ id: 1, length: 0 }]))]),
      '10.0.0.9',
      cache
    );

    const good = v9Packet(0, [
      flowset(0, templateBody(256, V9_FIELDS)),
      flowset(256, record('192.168.1.10', '1.1.1.1', 50000, 53, 17, 120, 2)),
    ]);
    const result = decodePacket(good, '10.0.0.9', cache);
    expect(result.templatesParsed).toBe(1);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].bytes).toBe(120);
  });
});
