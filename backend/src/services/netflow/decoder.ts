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
}

// Keyed by `${exporterKey}|${sourceId}|${templateId}` so two exporters (or two
// observation domains on one exporter) can't clobber each other's templates.
export type TemplateCache = Map<string, Template>;

export interface DecodeResult {
  flows: FlowRecord[];
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
} as const;

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
  const parts: string[] = [];
  for (let i = 0; i < 8; i++) {
    parts.push(buf.readUInt16BE(offset + i * 2).toString(16));
  }
  return parts.join(':');
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
    cache.set(`${exporterKey}|${sourceId}|${templateId}`, { fields, minLength });
    parsed++;
  }
  return parsed;
}

function parseDataSet(
  buf: Buffer,
  start: number,
  setEnd: number,
  template: Template,
  flows: FlowRecord[]
): void {
  let off = start;
  // Records are packed back to back; trailing bytes < minLength are padding
  while (off + template.minLength <= setEnd) {
    const recordStart = off;
    let srcAddr = '';
    let dstAddr = '';
    let srcPort = 0;
    let dstPort = 0;
    let protocol = 0;
    let bytes = -1;
    let packets = 0;
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
      flows.push({ srcAddr, dstAddr, srcPort, dstPort, protocol, bytes, packets });
    }
  }
}

export function decodePacket(buf: Buffer, exporterKey: string, cache: TemplateCache): DecodeResult {
  const result: DecodeResult = { flows: [], templatesParsed: 0, recordsWithoutTemplate: 0 };
  if (buf.length < 16) return result;

  const version = buf.readUInt16BE(0);
  let offset: number;
  let end: number;
  let sourceId: number;
  let ipfix: boolean;

  if (version === 9) {
    if (buf.length < 20) return result;
    ipfix = false;
    sourceId = buf.readUInt32BE(16);
    offset = 20;
    end = buf.length;
  } else if (version === 10) {
    ipfix = true;
    const declaredLength = buf.readUInt16BE(2);
    sourceId = buf.readUInt32BE(12); // observation domain ID
    offset = 16;
    end = Math.min(declaredLength, buf.length);
  } else {
    return result; // unsupported version (v5 etc.)
  }

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
        parseDataSet(buf, setStart, setEnd, template, result.flows);
      } else {
        result.recordsWithoutTemplate++;
      }
    }
    offset = setEnd;
  }

  return result;
}
