// Session log from NetFlow (#415 step 2): one row per connection, the way a
// Palo Alto or Check Point traffic log reads, instead of one per packet a
// logging rule matched.
//
// RouterOS exports each direction of a connection as its own flow record, and
// splits a long one into a record per active timeout (MTM sets 1 minute). The
// tracker pairs the two directions, merges the pieces, and works out which end
// started it and how it ended. Kept free of sockets and the database so it can
// be tested on its own; the collector feeds it and writes what it hands back.

import type { FlowRecord } from './decoder';
import type { ExporterInfo } from './attribution';
import { classifyApp, isKnownServicePort } from './appCategories';

export const TCP = 6;
export const UDP = 17;
const ICMP = 1;
const ICMPV6 = 58;

const FIN = 0x01;
const SYN = 0x02;
const RST = 0x04;
const ACK = 0x10;

/** A session is handed over once no record for it has arrived for this long. */
export const HOLD_MS = 10_000;
/** Bounds, so a flood of flows can't grow memory without limit. */
export const MAX_OPEN = 200_000;
export const MAX_RECENT = 100_000;

export type EndReason = 'fin' | 'reset-client' | 'reset-server' | 'no-reply' | 'aged-out';
export const END_REASONS: readonly EndReason[] = ['fin', 'reset-client', 'reset-server', 'no-reply', 'aged-out'];

interface Endpoint { addr: string; port: number }

interface DirStats {
  bytes: number;
  packets: number;
  flags: number;
  start: number;
  end: number;
  seen: boolean;
}

interface OpenSession {
  key: string;
  exporter: ExporterInfo | null;
  exporterLabel: string | null;
  protocol: number;
  /** The real endpoints, A being the source of the first record seen. */
  a: Endpoint;
  b: Endpoint;
  /** Where NAT showed A to B, and what A dialled to reach B. */
  aNat?: Endpoint;
  bNat?: Endpoint;
  ab: DirStats;
  ba: DirStats;
  lastReceived: number;
  /** A stored row this continues (a long connection's next piece). */
  continues?: Recent;
}

/** What is kept about a stored session that may yet continue. */
interface Recent {
  rowId: number;
  /** The client end, as epKey: a later piece may see either end first. */
  clientKey: string;
  flagsOut: number;
  flagsIn: number;
  seenOut: boolean;
  seenIn: boolean;
  end: number;
  expires: number;
}

/** A finished (or finished-for-now) session, oriented client to server. */
export interface SessionRecord {
  key: string;
  /** Set when this adds to a row already stored. */
  rowId?: number;
  exporter: ExporterInfo | null;
  exporterLabel: string | null;
  protocol: number;
  client: Endpoint;
  server: Endpoint;
  clientNat?: Endpoint;
  serverNat?: Endpoint;
  app: string;
  start: number;
  end: number;
  bytesOut: number;
  bytesIn: number;
  packetsOut: number;
  packetsIn: number;
  /** Flags over the whole session so far, each way (null when not TCP). */
  flagsOut: number | null;
  flagsIn: number | null;
  reason: EndReason;
  seenOut: boolean;
  seenIn: boolean;
}

const isIcmp = (p: number) => p === ICMP || p === ICMPV6;
const epKey = (e: Endpoint) => `${e.addr}|${e.port}`;

/**
 * The real source and destination of a record, and the translated ones.
 *
 * RouterOS records a packet with the addresses it had arriving and adds the
 * post-NAT ones. For the way out through masquerade that is the client, with
 * its public address in post-NAT source; for the reply it is the public
 * address, with the client in post-NAT destination. So the real ends are the
 * pre-NAT source and the post-NAT destination, both ways, port forwards too.
 * ICMP carries its type in the port fields, which differ each way, so its
 * ports are left out.
 */
export function realEnds(flow: FlowRecord): { src: Endpoint; dst: Endpoint; srcNat?: Endpoint; dstDialled?: Endpoint } {
  const icmp = isIcmp(flow.protocol);
  const sp = icmp ? 0 : flow.srcPort;
  const dp = icmp ? 0 : flow.dstPort;
  const src = { addr: flow.srcAddr, port: sp };
  const dst = { addr: flow.natDstAddr ?? flow.dstAddr, port: icmp ? 0 : (flow.natDstPort ?? dp) };
  const out: ReturnType<typeof realEnds> = { src, dst };
  if (flow.natSrcAddr || flow.natSrcPort) {
    out.srcNat = { addr: flow.natSrcAddr ?? flow.srcAddr, port: icmp ? 0 : (flow.natSrcPort ?? sp) };
  }
  if (flow.natDstAddr || flow.natDstPort) out.dstDialled = { addr: flow.dstAddr, port: dp };
  return out;
}

export function sessionKey(exporterKey: string, protocol: number, x: Endpoint, y: Endpoint): string {
  const [p, q] = [epKey(x), epKey(y)].sort();
  return `${exporterKey}#${protocol}#${p}#${q}`;
}

function emptyDir(): DirStats {
  return { bytes: 0, packets: 0, flags: 0, start: Infinity, end: -Infinity, seen: false };
}

/**
 * Which end is the server, from ports alone, or null when they don't say.
 * A port the app table names (443, 53) beats one it doesn't; a port under
 * 1024 beats one above; one below the ephemeral range beats one in it.
 */
function serverByPorts(protocol: number, a: number, b: number): 'a' | 'b' | null {
  const ka = isKnownServicePort(protocol, a);
  const kb = isKnownServicePort(protocol, b);
  if (ka !== kb) return ka ? 'a' : 'b';
  if ((a < 1024) !== (b < 1024)) return a < 1024 ? 'a' : 'b';
  if ((a >= 49152) !== (b >= 49152)) return a < 49152 ? 'a' : 'b';
  return null;
}

/** Whether A started the session. */
export function clientIsA(s: Pick<OpenSession, 'protocol' | 'a' | 'b' | 'ab' | 'ba'>): boolean {
  const { protocol, ab, ba } = s;
  if (isIcmp(protocol)) return true; // A sent first, and the ports can't say otherwise
  if (protocol === TCP) {
    // One way only: a bare SYN is a client knocking, a lone SYN-ACK a server answering.
    const oneWay = ab.seen !== ba.seen ? (ab.seen ? ab : ba) : null;
    if (oneWay) {
      const senderIsA = oneWay === ab;
      if ((oneWay.flags & SYN) && !(oneWay.flags & ACK)) return senderIsA;
      if ((oneWay.flags & (SYN | ACK)) === (SYN | ACK) && oneWay.packets <= 2) return !senderIsA;
    }
  }
  const byPorts = serverByPorts(protocol, s.a.port, s.b.port);
  if (byPorts) return byPorts === 'b';
  // The first packet's direction, when both were seen at different times.
  if (ab.seen && ba.seen && ab.start !== ba.start) return ab.start < ba.start;
  if (s.a.port !== s.b.port) return s.a.port > s.b.port; // the higher port is usually the client's
  return true;
}

export function endReason(protocol: number, flagsOut: number, flagsIn: number, seenOut: boolean, seenIn: boolean): EndReason {
  if (protocol === TCP) {
    if (flagsOut & RST) return 'reset-client';
    if (flagsIn & RST) return 'reset-server';
    if ((flagsOut | flagsIn) & FIN) return 'fin';
  }
  if (!seenIn || !seenOut) return 'no-reply';
  return 'aged-out';
}

export interface TrackerStats {
  open: number;
  recent: number;
  dropped: number;
}

export class SessionTracker {
  private open = new Map<string, OpenSession>();
  private recent = new Map<string, Recent>();
  private dropped = 0;

  /** @param activeTimeoutMs the exporters' active timeout, for how long a piece may continue */
  constructor(private activeTimeoutMs = 60_000) {}

  setActiveTimeout(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.activeTimeoutMs = ms;
  }

  stats(): TrackerStats {
    return { open: this.open.size, recent: this.recent.size, dropped: this.dropped };
  }

  /**
   * Add one flow record. `exporterKey` names the exporting router, so the
   * same connection seen by two routers is two sessions.
   */
  add(exporterKey: string, exporter: ExporterInfo | null, exporterLabel: string | null, flow: FlowRecord, receivedMs: number): void {
    if (flow.startMs === undefined || flow.endMs === undefined) return; // can't place it in time
    const { src, dst, srcNat, dstDialled } = realEnds(flow);
    const key = sessionKey(exporterKey, flow.protocol, src, dst);
    let s = this.open.get(key);
    if (!s) {
      if (this.open.size >= MAX_OPEN) { this.dropped++; return; }
      s = {
        key, exporter, exporterLabel, protocol: flow.protocol,
        a: src, b: dst, ab: emptyDir(), ba: emptyDir(), lastReceived: receivedMs,
      };
      const prev = this.recent.get(key);
      // A piece that starts soon after the stored one ended is the same
      // connection carried on; a long gap is a new one on the same ports.
      if (prev && prev.expires >= receivedMs && flow.startMs - prev.end <= this.activeTimeoutMs) {
        s.continues = prev;
        this.recent.delete(key);
      }
      this.open.set(key, s);
    }
    const forward = epKey(src) === epKey(s.a) && epKey(dst) === epKey(s.b);
    const d = forward ? s.ab : s.ba;
    d.bytes += flow.bytes;
    d.packets += flow.packets;
    d.flags |= flow.tcpFlags ?? 0;
    d.start = Math.min(d.start, flow.startMs);
    d.end = Math.max(d.end, flow.endMs);
    d.seen = true;
    if (forward) { s.aNat ??= srcNat; s.bNat ??= dstDialled; }
    else { s.bNat ??= srcNat; s.aNat ??= dstDialled; }
    s.lastReceived = Math.max(s.lastReceived, receivedMs);
  }

  /** Sessions quiet for HOLD_MS (all of them with `all`), oriented and ready to store. */
  drain(nowMs: number, all = false): SessionRecord[] {
    const out: SessionRecord[] = [];
    for (const [key, s] of this.open) {
      if (!all && nowMs - s.lastReceived < HOLD_MS) continue;
      this.open.delete(key);
      out.push(this.finish(s));
    }
    // Forget pieces that can no longer be continued.
    for (const [key, r] of this.recent) if (r.expires < nowMs) this.recent.delete(key);
    return out;
  }

  /**
   * The row a session was stored as, so a later piece of the same connection
   * adds to it. Only kept while one could still come: a TCP connection that
   * closed won't, and neither will a short exchange that ended on its own
   * before the active timeout.
   */
  stored(rec: SessionRecord, rowId: number, nowMs: number): void {
    if (rec.reason === 'fin' || rec.reason === 'reset-client' || rec.reason === 'reset-server') return;
    const piece = rec.end - rec.start;
    if (rec.protocol !== TCP && !rec.rowId && piece < this.activeTimeoutMs / 2) return;
    if (this.recent.size >= MAX_RECENT) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
    this.recent.set(rec.key, {
      rowId, clientKey: epKey(rec.client),
      flagsOut: rec.flagsOut ?? 0, flagsIn: rec.flagsIn ?? 0,
      seenOut: rec.seenOut, seenIn: rec.seenIn,
      end: rec.end,
      // The next piece is exported an active timeout after this one, plus the
      // time records take to arrive.
      expires: nowMs + this.activeTimeoutMs + 30_000,
    });
  }

  private finish(s: OpenSession): SessionRecord {
    const prev = s.continues;
    // A later piece keeps the client of the row it adds to: its own first
    // packet is just whichever came first after the cut.
    const aIsClient = prev ? epKey(s.a) === prev.clientKey : clientIsA(s);
    const cs = aIsClient ? s.ab : s.ba;
    const sc = aIsClient ? s.ba : s.ab;
    const tcp = s.protocol === TCP;
    let flagsOut = cs.flags;
    let flagsIn = sc.flags;
    let seenOut = cs.seen;
    let seenIn = sc.seen;
    if (prev) {
      flagsOut |= prev.flagsOut;
      flagsIn |= prev.flagsIn;
      seenOut ||= prev.seenOut;
      seenIn ||= prev.seenIn;
    }
    const client = aIsClient ? s.a : s.b;
    const server = aIsClient ? s.b : s.a;
    const start = Math.min(s.ab.start, s.ba.start);
    const end = Math.max(s.ab.end, s.ba.end);
    const rec: SessionRecord = {
      key: s.key,
      exporter: s.exporter,
      exporterLabel: s.exporterLabel,
      protocol: s.protocol,
      client, server,
      app: classifyApp(s.protocol, client.port, server.port),
      start, end,
      bytesOut: cs.bytes, bytesIn: sc.bytes,
      packetsOut: cs.packets, packetsIn: sc.packets,
      flagsOut: tcp ? flagsOut : null,
      flagsIn: tcp ? flagsIn : null,
      reason: endReason(s.protocol, flagsOut, flagsIn, seenOut, seenIn),
      seenOut, seenIn,
    };
    const clientNat = aIsClient ? s.aNat : s.bNat;
    const serverNat = aIsClient ? s.bNat : s.aNat;
    if (clientNat) rec.clientNat = clientNat;
    if (serverNat) rec.serverNat = serverNat;
    if (prev) rec.rowId = prev.rowId;
    return rec;
  }
}
