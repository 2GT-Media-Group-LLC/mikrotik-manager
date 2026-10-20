export type FirewallAction =
  | 'accept'
  | 'drop'
  | 'reject'
  | 'fasttrack'
  | 'unknown';

export interface FirewallLogEvent {
  action: FirewallAction;
  prefix: string;
  chain: 'input' | 'forward' | 'output';
  inInterface?: string;
  outInterface?: string;
  connectionState?: string;
  srcMac?: string;
  protocol: string;
  tcpFlags?: string;
  srcIp: string;
  srcPort?: number;
  dstIp: string;
  dstPort?: number;
  length?: number;
}

interface ParsedEndpoint {
  ip: string;
  port?: number;
}

function inferAction(prefix: string): FirewallAction {
  const value = prefix.toLowerCase();

  if (/\b(fasttrack|fast-track)\b/.test(value)) return 'fasttrack';
  if (/\b(drop|deny|denied|block|blocked)\b/.test(value)) return 'drop';
  if (/\breject(ed)?\b/.test(value)) return 'reject';
  if (/\b(accept|accepted|allow|allowed|permit|permitted)\b/.test(value)) {
    return 'accept';
  }

  return 'unknown';
}

function parseEndpoint(value: string): ParsedEndpoint | null {
  // RouterOS wraps IPv6 addresses in [] when a port follows:
  // [2001:db8::10]:54321
  const bracketed = value.match(
    /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/
  );

  if (bracketed) {
    return {
      ip: bracketed[1],
      port: bracketed[2] ? Number(bracketed[2]) : undefined,
    };
  }

  const ipv4 = value.match(
    /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/
  );

  if (ipv4) {
    return {
      ip: ipv4[1],
      port: ipv4[2] ? Number(ipv4[2]) : undefined,
    };
  }

  // Be tolerant of an unbracketed IPv6 address when no port is present.
  if (value.includes(':') && /^[0-9A-Fa-f:.]+$/.test(value)) {
    return { ip: value };
  }

  return null;
}

export function parseFirewallLog(message: string): FirewallLogEvent | null {
  const header = message.match(
    /^(.*?)\s*\b(input|forward|output):\s*(.+)$/i
  );
  if (!header) return null;

  const prefix = header[1].trim();
  const chain = header[2].toLowerCase() as FirewallLogEvent['chain'];
  const body = header[3];

  const protocolMatch = body.match(
    /\bproto\s+([A-Za-z0-9_-]+)(?:\s+\(([^)]+)\))?/i
  );
  if (!protocolMatch) return null;

  // Packet endpoints are the token immediately before "len".
  // This covers both:
  //   192.0.2.10:1234->198.51.100.20:443
  //   [2001:db8::10]:1234->[2001:db8::20]:443
  const endpointsMatch = body.match(
    /,\s*([^\s,]+)->([^\s,]+)(?=,\s*len\b|$)/i
  );
  if (!endpointsMatch) return null;

  const src = parseEndpoint(endpointsMatch[1]);
  const dst = parseEndpoint(endpointsMatch[2]);
  if (!src || !dst) return null;

  const inInterface = body.match(/\bin:([^\s,]+)/i)?.[1];
  const outInterface = body.match(/\bout:([^\s,]+)/i)?.[1];
  const connectionState = body.match(
    /\bconnection-state:([^\s,]+)/i
  )?.[1];
  const srcMac = body.match(
    /\bsrc-mac\s+([0-9A-Fa-f:]+)/i
  )?.[1];
  const length = body.match(/\blen\s+(\d+)/i)?.[1];

  return {
    action: inferAction(prefix),
    prefix,
    chain,
    inInterface,
    outInterface,
    connectionState,
    srcMac,
    protocol: protocolMatch[1].toLowerCase(),
    tcpFlags: protocolMatch[2],
    srcIp: src.ip,
    srcPort: src.port,
    dstIp: dst.ip,
    dstPort: dst.port,
    length: length ? Number(length) : undefined,
  };
}
