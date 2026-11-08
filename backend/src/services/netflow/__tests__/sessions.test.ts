import { SessionTracker, HOLD_MS, clientIsA, endReason, realEnds } from '../sessions';
import type { FlowRecord } from '../decoder';

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const FIN = 0x01, SYN = 0x02, RST = 0x04, PSH = 0x08, ACK = 0x10;

function flow(p: Partial<FlowRecord> & Pick<FlowRecord, 'srcAddr' | 'dstAddr' | 'srcPort' | 'dstPort'>): FlowRecord {
  return { protocol: 6, bytes: 100, packets: 2, startMs: T0, endMs: T0 + 1000, tcpFlags: SYN | ACK | PSH | FIN, ...p };
}

describe('session tracker (#415)', () => {
  it('pairs both directions through masquerade into one session, client to server', () => {
    const t = new SessionTracker();
    // Out: the client, with its public address in post-NAT source.
    t.add('d1', null, null, flow({ srcAddr: '192.168.1.10', srcPort: 51000, dstAddr: '1.1.1.1', dstPort: 443,
      natSrcAddr: '203.0.113.5', natSrcPort: 61000, bytes: 1_000, packets: 10 }), T0);
    // Back: to the public address, with the client in post-NAT destination.
    t.add('d1', null, null, flow({ srcAddr: '1.1.1.1', srcPort: 443, dstAddr: '203.0.113.5', dstPort: 61000,
      natDstAddr: '192.168.1.10', natDstPort: 51000, bytes: 50_000, packets: 40, startMs: T0 + 20 }), T0);
    expect(t.drain(T0 + HOLD_MS - 1)).toEqual([]);
    const [s, ...rest] = t.drain(T0 + HOLD_MS);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      client: { addr: '192.168.1.10', port: 51000 },
      server: { addr: '1.1.1.1', port: 443 },
      clientNat: { addr: '203.0.113.5', port: 61000 },
      bytesOut: 1_000, bytesIn: 50_000, packetsOut: 10, packetsIn: 40,
      reason: 'fin', app: 'HTTPS',
    });
    expect(s.serverNat).toBeUndefined();
  });

  it('pairs a port forward, keeping the address the client dialled', () => {
    const t = new SessionTracker();
    t.add('d1', null, null, flow({ srcAddr: '198.51.100.7', srcPort: 40000, dstAddr: '203.0.113.5', dstPort: 80,
      natDstAddr: '192.168.1.20', natDstPort: 8080 }), T0);
    t.add('d1', null, null, flow({ srcAddr: '192.168.1.20', srcPort: 8080, dstAddr: '198.51.100.7', dstPort: 40000,
      natSrcAddr: '203.0.113.5', natSrcPort: 80, startMs: T0 + 5 }), T0);
    const [s] = t.drain(T0 + HOLD_MS);
    expect(s).toMatchObject({
      client: { addr: '198.51.100.7', port: 40000 },
      server: { addr: '192.168.1.20', port: 8080 },
      serverNat: { addr: '203.0.113.5', port: 80 },
    });
  });

  it('says how a TCP session ended', () => {
    expect(endReason(6, SYN | ACK | RST, SYN | ACK, true, true)).toBe('reset-client');
    expect(endReason(6, SYN | ACK, SYN | ACK | RST, true, true)).toBe('reset-server');
    expect(endReason(6, SYN | ACK | FIN, SYN | ACK | FIN, true, true)).toBe('fin');
    expect(endReason(6, SYN, 0, true, false)).toBe('no-reply');
    expect(endReason(6, ACK, ACK, true, true)).toBe('aged-out');
    expect(endReason(17, 0, 0, true, false)).toBe('no-reply');
    expect(endReason(17, 0, 0, true, true)).toBe('aged-out');
  });

  it('takes a lone SYN as the client knocking, whatever the ports', () => {
    const t = new SessionTracker();
    t.add('d1', null, null, flow({ srcAddr: '10.0.0.5', srcPort: 22, dstAddr: '10.0.0.9', dstPort: 60000, tcpFlags: SYN, packets: 3 }), T0);
    const [s] = t.drain(T0 + HOLD_MS);
    expect(s).toMatchObject({ client: { addr: '10.0.0.5', port: 22 }, reason: 'no-reply', bytesIn: 0 });
  });

  it('finds the server by its port, then by who spoke first', () => {
    const dir = (start: number, seen = true) => ({ bytes: 1, packets: 1, flags: ACK, start, end: start, seen });
    const a = (port: number) => ({ addr: '10.0.0.1', port });
    const b = (port: number) => ({ addr: '10.0.0.2', port });
    // A known service beats a high port.
    expect(clientIsA({ protocol: 6, a: a(443), b: b(50000), ab: dir(5), ba: dir(0) })).toBe(false);
    expect(clientIsA({ protocol: 17, a: a(50000), b: b(53), ab: dir(5), ba: dir(0) })).toBe(true);
    // Neither named: under 1024 beats over.
    expect(clientIsA({ protocol: 6, a: a(40000), b: b(999), ab: dir(5), ba: dir(0) })).toBe(true);
    // Same kind of port: whoever sent first.
    expect(clientIsA({ protocol: 17, a: a(5678), b: b(5678), ab: dir(10), ba: dir(3) })).toBe(false);
    expect(clientIsA({ protocol: 17, a: a(5678), b: b(5678), ab: dir(3), ba: dir(10) })).toBe(true);
  });

  it('adds the next piece of a long connection to the stored row, keeping its client', () => {
    const t = new SessionTracker(60_000);
    const out = (start: number, bytes: number) => flow({ srcAddr: '192.168.1.10', srcPort: 51000, dstAddr: '10.9.9.9', dstPort: 22,
      tcpFlags: ACK | PSH | (start === T0 ? SYN : 0), bytes, startMs: start, endMs: start + 59_000 });
    const back = (start: number, bytes: number) => flow({ srcAddr: '10.9.9.9', srcPort: 22, dstAddr: '192.168.1.10', dstPort: 51000,
      tcpFlags: ACK | PSH | (start === T0 ? SYN : 0), bytes, startMs: start, endMs: start + 59_000 });
    t.add('d1', null, null, out(T0, 100), T0 + 60_000);
    t.add('d1', null, null, back(T0 + 3, 200), T0 + 60_000);
    const [first] = t.drain(T0 + 60_000 + HOLD_MS);
    expect(first).toMatchObject({ client: { port: 51000 }, server: { port: 22 }, reason: 'aged-out', bytesOut: 100, bytesIn: 200 });
    expect(first.rowId).toBeUndefined();
    t.stored(first, 42, T0 + 60_000 + HOLD_MS);

    // The next minute: the reply happens to be recorded first this time.
    t.add('d1', null, null, back(T0 + 60_000, 20), T0 + 120_000);
    t.add('d1', null, null, { ...out(T0 + 60_010, 10), tcpFlags: ACK | FIN }, T0 + 120_000);
    const [second] = t.drain(T0 + 120_000 + HOLD_MS);
    expect(second).toMatchObject({
      rowId: 42, client: { port: 51000 }, server: { port: 22 },
      bytesOut: 10, bytesIn: 20, reason: 'fin',
    });
    // Flags over the whole session: the first piece's SYN is still there.
    expect(second.flagsOut! & SYN).toBe(SYN);
  });

  it('starts a new row once a connection has closed', () => {
    const t = new SessionTracker(60_000);
    const f = flow({ srcAddr: '192.168.1.10', srcPort: 51000, dstAddr: '1.1.1.1', dstPort: 443, startMs: T0, endMs: T0 + 59_000 });
    t.add('d1', null, null, f, T0);
    const [first] = t.drain(T0 + HOLD_MS);
    expect(first.reason).toBe('fin');
    t.stored(first, 7, T0 + HOLD_MS);
    t.add('d1', null, null, { ...f, startMs: T0 + 60_000, endMs: T0 + 61_000 }, T0 + 61_000);
    const [second] = t.drain(T0 + 61_000 + HOLD_MS);
    expect(second.rowId).toBeUndefined();
  });

  it('keeps routers apart, and leaves out records without times', () => {
    const t = new SessionTracker();
    const f = flow({ srcAddr: '192.168.1.10', srcPort: 51000, dstAddr: '1.1.1.1', dstPort: 443 });
    t.add('d1', null, null, f, T0);
    t.add('d2', null, null, f, T0);
    t.add('d3', null, null, { ...f, startMs: undefined, endMs: undefined }, T0);
    expect(t.drain(T0 + HOLD_MS)).toHaveLength(2);
  });

  it('pairs ICMP echo and reply, whose type sits in the port field', () => {
    const t = new SessionTracker();
    t.add('d1', null, null, flow({ protocol: 1, srcAddr: '192.168.1.10', srcPort: 0, dstAddr: '8.8.8.8', dstPort: 2048, tcpFlags: undefined }), T0);
    t.add('d1', null, null, flow({ protocol: 1, srcAddr: '8.8.8.8', srcPort: 0, dstAddr: '192.168.1.10', dstPort: 0, tcpFlags: undefined, startMs: T0 + 9 }), T0);
    const recs = t.drain(T0 + HOLD_MS);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ client: { addr: '192.168.1.10' }, server: { addr: '8.8.8.8' }, reason: 'aged-out', flagsOut: null });
  });

  it('reads the real ends of a record', () => {
    expect(realEnds(flow({ srcAddr: '1.1.1.1', srcPort: 443, dstAddr: '203.0.113.5', dstPort: 61000,
      natDstAddr: '192.168.1.10', natDstPort: 51000 }))).toEqual({
      src: { addr: '1.1.1.1', port: 443 },
      dst: { addr: '192.168.1.10', port: 51000 },
      dstDialled: { addr: '203.0.113.5', port: 61000 },
    });
  });
});
