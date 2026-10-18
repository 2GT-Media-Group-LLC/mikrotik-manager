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

export function parseFirewallLog(message: string): FirewallLogEvent | null {
  const header = message.match(/^(.*?)\s*\b(input|forward|output):\s*(.+)$/i);
  if (!header) return null;

  const prefix = header[1].trim();
  const chain = header[2].toLowerCase() as FirewallLogEvent['chain'];
  const body = header[3];

  const protocolMatch = body.match(
    /\bproto\s+([A-Za-z0-9_-]+)(?:\s+\(([^)]+)\))?/i
  );
  if (!protocolMatch) return null;

  // RouterOS IPv4 packet-log format.
  const endpoints = body.match(
    /\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?->(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?\b/
  );
  if (!endpoints) return null;

  const inInterface = body.match(/\bin:([^\s,]+)/i)?.[1];
  const outInterface = body.match(/\bout:([^\s,]+)/i)?.[1];
  const connectionState = body.match(/\bconnection-state:([^\s,]+)/i)?.[1];
  const srcMac = body.match(/\bsrc-mac\s+([0-9A-Fa-f:]+)/i)?.[1];
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
    srcIp: endpoints[1],
    srcPort: endpoints[2] ? Number(endpoints[2]) : undefined,
    dstIp: endpoints[3],
    dstPort: endpoints[4] ? Number(endpoints[4]) : undefined,
    length: length ? Number(length) : undefined,
  };
}
