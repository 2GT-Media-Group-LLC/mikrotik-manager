// NetFlow v9 / IPFIX (v10) decoder — purpose-built for the fields RouterOS
// Traffic Flow exports. Both protocols share the same structure (header +
// sets; template sets describe field layouts, data sets reference them), and
// the field IDs we care about are identical in v9 field types and IPFIX
// information elements, so one decoder covers both.

export interface FlowRecord {
  srcAddr: string;
  dstAddr: string;
  srcPort: number;
  dstPort: number;
  protocol: number;
  bytes: number;
  packets: number;
  /**
   * Post-NAT addresses (IPFIX 225/226, IPv6 281/282), present only when NAT
   * changed them. RouterOS records a download where it enters the WAN, before
   * NAT is reversed: the destination is the router's public address and the
   * LAN client is only in natDstAddr (#345).
   */
  natSrcAddr?: string;
  natDstAddr?: string;
  /** Post-NAT ports (227/228), only when NAT changed them. */
  natSrcPort?: number;
  natDstPort?: number;
  /** TCP flags seen across the flow, OR'd (field 6), when exported. */
  tcpFlags?: number;
  /**
   * First and last packet of the flow, epoch ms, when the exporter sends them
   * (v9 FIRST/LAST_SWITCHED against the header uptime, or IPFIX absolute times).
   */
  startMs?: number;
  endMs?: number;
}

interface TemplateField {
  id: number;
  length: number; // 65535 = IPFIX variable-length
  enterprise: boolean;
}

interface Template {
  fields: TemplateField[];
  // Minimum bytes a record can occupy (var-length fields count as 1)
  minLength: number;
  // Epoch ms of the last time this template was stored or used to decode data.
  // Drives TTL/LRU eviction so a hostile or churning sender can't grow the cache
  // without bound (see pruneTemplateCache).
  lastUsed: number;
}

// Keyed by `${exporterKey}|${sourceId}|${templateId}` so two exporters (or two
// observation domains on one exporter) can't clobber each other's templates.
export type TemplateCache = Map<string, Template>;

/**
 * Evict templates unused for longer than `ttlMs`, then enforce `max` entries by
 * dropping the least-recently-used. Returns how many were removed.
 */
export function pruneTemplateCache(
  cache: TemplateCache,
  ttlMs: number,
  max: number,
  now: number = Date.now()
): number {
  let removed = 0;
  const cutoff = now - ttlMs;
  for (const [key, tpl] of cache) {
    if (tpl.lastUsed < cutoff) {
      cache.delete(key);
      removed++;
    }
  }
  if (cache.size > max) {
    const byAge = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < byAge.length - max; i++) {
      cache.delete(byAge[i][0]);
      removed++;
    }
  }
  return removed;
}

export interface DecodeResult {
  flows: FlowRecord[];
  /** v9 source id or IPFIX observation domain: one exporter can send several. */
  sourceId?: number;
  /** Header export time, epoch ms. */
  exportMs?: number;
  /** v9 header uptime, ms (IPFIX has none). */
  uptimeMs?: number;
  /**
   * When the exporter booted, epoch ms: export time less uptime for v9, or
   * IPFIX systemInitTimeMilliseconds when a record carries it.
   */
  bootMs?: number;
  templatesParsed: number;
  // Data records that arrived before their template (dropped)
  recordsWithoutTemplate: number;
}

const FIELD = {
  BYTES: 1, // IN_BYTES / octetDeltaCount
  PACKETS: 2, // IN_PKTS / packetDeltaCount
  PROTOCOL: 4, // PROTOCOL / protocolIdentifier
  SRC_PORT: 7, // L4_SRC_PORT / sourceTransportPort
  SRC_IPV4: 8, // IPV4_SRC_ADDR / sourceIPv4Address
  DST_PORT: 11, // L4_DST_PORT / destinationTransportPort
  DST_IPV4: 12, // IPV4_DST_ADDR / destinationIPv4Address
  SRC_IPV6: 27, // IPV6_SRC_ADDR / sourceIPv6Address
  DST_IPV6: 28, // IPV6_DST_ADDR / destinationIPv6Address
  TCP_FLAGS: 6, // TCP_FLAGS / tcpControlBits
  LAST_SWITCHED: 21, // sysUpTime ms of the last packet (IPFIX flowEndSysUpTime)
  FIRST_SWITCHED: 22, // sysUpTime ms of the first packet (IPFIX flowStartSysUpTime)
  START_SECONDS: 150, // flowStartSeconds
  END_SECONDS: 151, // flowEndSeconds
  START_MS: 152, // flowStartMilliseconds
  END_MS: 153, // flowEndMilliseconds
  SYS_INIT_MS: 160, // systemInitTimeMilliseconds (IPFIX uptime base)
  NAT_SRC_IPV4: 225, // postNATSourceIPv4Address
  NAT_DST_IPV4: 226, // postNATDestinationIPv4Address
  NAT_SRC_IPV6: 281, // postNATSourceIPv6Address
  NAT_DST_IPV6: 282, // postNATDestinationIPv6Address
  NAT_SRC_PORT: 227, // postNAPTSourceTransportPort
  NAT_DST_PORT: 228, // postNAPTDestinationTransportPort
} as const;

/**
 * Header clock, for turning uptime-relative times into wall-clock ones. v9
 * carries the exporter's uptime next to the export time; IPFIX has no uptime
 * in its header and needs systemInitTimeMilliseconds in the record instead.
 */
interface HeaderClock {
  exportMs: number;
  uptimeMs?: number;
  /** IPFIX systemInitTimeMilliseconds, from the first record that has it. */
  sysInitMs?: number;
}

/** RouterOS fills a post-NAT field with zeros when nothing was translated. */
const NO_ADDRESS = new Set(['0.0.0.0', '::']);

function readUInt(buf: Buffer, offset: number, length: number): number {
  if (length === 8) {
    // 64-bit counters (IPFIX octetDeltaCount is often 8 bytes)
    return Number(buf.readBigUInt64BE(offset));
  }
  if (length >= 1 && length <= 6) {
    return buf.readUIntBE(offset, length);
  }
  return 0;
}

function formatIPv4(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

function formatIPv6(buf: Buffer, offset: number): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(offset + i * 2));

  // IPv4-mapped (::ffff:a.b.c.d) — report the underlying IPv4 address so these
  // flows match client/exporter IPs and don't look like separate IPv6 endpoints.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
      groups[4] === 0 && groups[5] === 0xffff) {
    return formatIPv4(buf, offset + 12);
  }

  // RFC 5952: compress the longest run of 2+ zero groups to '::'
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (runStart === -1) runStart = i;
      runLen++;
      if (runLen > bestLen) { bestStart = runStart; bestLen = runLen; }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }

  const parts = groups.map((g) => g.toString(16));
  if (bestLen < 2) return parts.join(':');
  return `${parts.slice(0, bestStart).join(':')}::${parts.slice(bestStart + bestLen).join(':')}`;
}

function parseTemplates(
  buf: Buffer,
  start: number,
  setEnd: number,
  ipfix: boolean,
  exporterKey: string,
  sourceId: number,
  cache: TemplateCache
): number {
  let off = start;
  let parsed = 0;
  // A template set can contain multiple template records back to back
  while (off + 4 <= setEnd) {
    const templateId = buf.readUInt16BE(off);
    const fieldCount = buf.readUInt16BE(off + 2);
    off += 4;
    if (templateId < 256 || fieldCount === 0 || fieldCount > 128) break;

    const fields: TemplateField[] = [];
    let minLength = 0;
    let ok = true;
    for (let i = 0; i < fieldCount; i++) {
      if (off + 4 > setEnd) { ok = false; break; }
      let id = buf.readUInt16BE(off);
      const length = buf.readUInt16BE(off + 2);
      off += 4;
      let enterprise = false;
      if (ipfix && (id & 0x8000) !== 0) {
        // Enterprise-specific element: 4-byte enterprise number follows
        if (off + 4 > setEnd) { ok = false; break; }
        off += 4;
        id = id & 0x7fff;
        enterprise = true;
      }
      // A zero-length field is meaningless in v9/IPFIX and makes a record
      // zero-width, which would spin parseDataSet forever. Reject the template.
      if (length === 0) { ok = false; break; }
      fields.push({ id, length, enterprise });
      minLength += length === 0xffff ? 1 : length;
    }
    if (!ok || minLength === 0) break;
    cache.set(`${exporterKey}|${sourceId}|${templateId}`, { fields, minLength, lastUsed: Date.now() });
    parsed++;
  }
  return parsed;
}

function parseDataSet(
  buf: Buffer,
  start: number,
  setEnd: number,
  template: Template,
  flows: FlowRecord[],
  clock: HeaderClock
): void {
  let off = start;
  // Records are packed back to back; trailing bytes < minLength are padding
  while (off + template.minLength <= setEnd) {
    const recordStart = off;
    let srcAddr = '';
    let dstAddr = '';
    let natSrcAddr = '';
    let natDstAddr = '';
    let srcPort = 0;
    let dstPort = 0;
    let protocol = 0;
    let bytes = -1;
    let packets = 0;
    let natSrcPort = 0;
    let natDstPort = 0;
    let tcpFlags: number | undefined;
    let firstUp: number | undefined;
    let lastUp: number | undefined;
    let startAbs: number | undefined;
    let endAbs: number | undefined;
    let sysInit: number | undefined;
    let valid = true;

    for (const field of template.fields) {
      let len = field.length;
      if (len === 0xffff) {
        // IPFIX variable-length: first byte is the length (255 → next 2 bytes)
        if (off + 1 > setEnd) { valid = false; break; }
        len = buf[off];
        off += 1;
        if (len === 255) {
          if (off + 2 > setEnd) { valid = false; break; }
          len = buf.readUInt16BE(off);
          off += 2;
        }
      }
      if (off + len > setEnd) { valid = false; break; }

      if (!field.enterprise) {
        switch (field.id) {
          case FIELD.BYTES: bytes = readUInt(buf, off, len); break;
          case FIELD.PACKETS: packets = readUInt(buf, off, len); break;
          case FIELD.PROTOCOL: protocol = readUInt(buf, off, len); break;
          case FIELD.SRC_PORT: srcPort = readUInt(buf, off, len); break;
          case FIELD.DST_PORT: dstPort = readUInt(buf, off, len); break;
          case FIELD.SRC_IPV4: if (len === 4) srcAddr = formatIPv4(buf, off); break;
          case FIELD.DST_IPV4: if (len === 4) dstAddr = formatIPv4(buf, off); break;
          case FIELD.SRC_IPV6: if (len === 16 && !srcAddr) srcAddr = formatIPv6(buf, off); break;
          case FIELD.DST_IPV6: if (len === 16 && !dstAddr) dstAddr = formatIPv6(buf, off); break;
          case FIELD.NAT_SRC_IPV4: if (len === 4) natSrcAddr = formatIPv4(buf, off); break;
          case FIELD.NAT_DST_IPV4: if (len === 4) natDstAddr = formatIPv4(buf, off); break;
          case FIELD.NAT_SRC_IPV6: if (len === 16 && !natSrcAddr) natSrcAddr = formatIPv6(buf, off); break;
          case FIELD.NAT_DST_IPV6: if (len === 16 && !natDstAddr) natDstAddr = formatIPv6(buf, off); break;
          case FIELD.NAT_SRC_PORT: natSrcPort = readUInt(buf, off, len); break;
          case FIELD.NAT_DST_PORT: natDstPort = readUInt(buf, off, len); break;
          case FIELD.TCP_FLAGS: tcpFlags = readUInt(buf, off, len) & 0xff; break;
          case FIELD.FIRST_SWITCHED: firstUp = readUInt(buf, off, len); break;
          case FIELD.LAST_SWITCHED: lastUp = readUInt(buf, off, len); break;
          case FIELD.START_MS: startAbs = readUInt(buf, off, len); break;
          case FIELD.END_MS: endAbs = readUInt(buf, off, len); break;
          case FIELD.START_SECONDS: if (startAbs === undefined) startAbs = readUInt(buf, off, len) * 1000; break;
          case FIELD.END_SECONDS: if (endAbs === undefined) endAbs = readUInt(buf, off, len) * 1000; break;
          case FIELD.SYS_INIT_MS: sysInit = readUInt(buf, off, len); break;
        }
      }
      off += len;
    }

    if (!valid) break;
    // Forward-progress guard: a record that consumed no bytes would loop forever.
    // Template validation should prevent this, but never let a malformed packet
    // hang the (single-threaded) event loop.
    if (off <= recordStart) break;
    // Only emit records that look like flows (options/stats records lack these)
    if (srcAddr && dstAddr && bytes >= 0) {
      const flow: FlowRecord = { srcAddr, dstAddr, srcPort, dstPort, protocol, bytes, packets };
      // Only when NAT actually changed the address, so untranslated records
      // (and the existing tests) look exactly as before.
      if (natSrcAddr && !NO_ADDRESS.has(natSrcAddr) && natSrcAddr !== srcAddr) flow.natSrcAddr = natSrcAddr;
      if (natDstAddr && !NO_ADDRESS.has(natDstAddr) && natDstAddr !== dstAddr) flow.natDstAddr = natDstAddr;
      if (natSrcPort && natSrcPort !== srcPort) flow.natSrcPort = natSrcPort;
      if (natDstPort && natDstPort !== dstPort) flow.natDstPort = natDstPort;
      if (tcpFlags !== undefined) flow.tcpFlags = tcpFlags;
      if (sysInit && clock.sysInitMs === undefined) clock.sysInitMs = sysInit;
      const times = flowTimes(clock, firstUp, lastUp, startAbs, endAbs, sysInit);
      if (times) { flow.startMs = times.start; flow.endMs = times.end; }
      flows.push(flow);
    }
  }
}

/** A plausible epoch-ms time: after 2000, and not more than a day ahead of the export. */
function plausible(ms: number, exportMs: number): boolean {
  return ms > 946_684_800_000 && ms <= exportMs + 86_400_000;
}

/**
 * Wall-clock start and end of a flow, or nothing when the record doesn't say.
 * Uptime-relative times count back from the export: the exporter's uptime at
 * export, less the uptime at the packet, is how long before the export it was.
 */
function flowTimes(
  clock: HeaderClock, firstUp?: number, lastUp?: number, startAbs?: number, endAbs?: number, sysInit?: number
): { start: number; end: number } | null {
  let start: number | undefined;
  let end: number | undefined;
  if (startAbs !== undefined && endAbs !== undefined) {
    start = startAbs; end = endAbs;
  } else if (firstUp !== undefined && lastUp !== undefined) {
    if (sysInit) { start = sysInit + firstUp; end = sysInit + lastUp; }
    else if (clock.uptimeMs !== undefined) {
      // Unsigned 32-bit ms wraps after 49.7 days; a flow straddling the wrap
      // reads as just before it.
      const ago = (t: number) => ((clock.uptimeMs! - t) >>> 0);
      start = clock.exportMs - ago(firstUp);
      end = clock.exportMs - ago(lastUp);
    } else {
      // Uptimes with nothing to anchor them: the length is still right, and
      // a flow is exported soon after its last packet, so end it at the export.
      end = clock.exportMs;
      start = end - ((lastUp - firstUp) >>> 0);
    }
  }
  if (start === undefined || end === undefined) return null;
  if (end < start) [start, end] = [end, start];
  if (!plausible(start, clock.exportMs) || !plausible(end, clock.exportMs)) return null;
  return { start, end };
}

export function decodePacket(buf: Buffer, exporterKey: string, cache: TemplateCache): DecodeResult {
  const result: DecodeResult = { flows: [], templatesParsed: 0, recordsWithoutTemplate: 0 };
  if (buf.length < 16) return result;

  const version = buf.readUInt16BE(0);
  let offset: number;
  let end: number;
  let sourceId: number;
  let ipfix: boolean;
  let clock: HeaderClock;

  if (version === 9) {
    if (buf.length < 20) return result;
    ipfix = false;
    sourceId = buf.readUInt32BE(16);
    clock = { uptimeMs: buf.readUInt32BE(4), exportMs: buf.readUInt32BE(8) * 1000 };
    offset = 20;
    end = buf.length;
  } else if (version === 10) {
    ipfix = true;
    const declaredLength = buf.readUInt16BE(2);
    sourceId = buf.readUInt32BE(12); // observation domain ID
    clock = { exportMs: buf.readUInt32BE(4) * 1000 };
    offset = 16;
    end = Math.min(declaredLength, buf.length);
  } else {
    return result; // unsupported version (v5 etc.)
  }
  result.sourceId = sourceId;
  result.exportMs = clock.exportMs;
  if (clock.uptimeMs !== undefined) result.uptimeMs = clock.uptimeMs;

  while (offset + 4 <= end) {
    const setId = buf.readUInt16BE(offset);
    const setLength = buf.readUInt16BE(offset + 2);
    if (setLength < 4 || offset + setLength > end) break;
    const setStart = offset + 4;
    const setEnd = offset + setLength;

    const isTemplateSet = ipfix ? setId === 2 : setId === 0;
    const isOptionsSet = ipfix ? setId === 3 : setId === 1;

    if (isTemplateSet) {
      result.templatesParsed += parseTemplates(buf, setStart, setEnd, ipfix, exporterKey, sourceId, cache);
    } else if (!isOptionsSet && setId >= 256) {
      const template = cache.get(`${exporterKey}|${sourceId}|${setId}`);
      if (template) {
        template.lastUsed = Date.now(); // keep actively-used templates alive
        parseDataSet(buf, setStart, setEnd, template, result.flows, clock);
      } else {
        result.recordsWithoutTemplate++;
      }
    }
    offset = setEnd;
  }

  if (clock.uptimeMs !== undefined) result.bootMs = clock.exportMs - clock.uptimeMs;
  else if (clock.sysInitMs !== undefined) result.bootMs = clock.sysInitMs;
  return result;
}
