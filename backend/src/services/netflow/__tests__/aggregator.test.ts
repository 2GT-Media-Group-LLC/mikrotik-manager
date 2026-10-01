import { FlowAggregator, CLIENT_UNKNOWN, CLIENT_OTHER } from '../FlowAggregator';
import { classifyApp } from '../appCategories';

const MAC_A = 'aa:aa:aa:aa:aa:01';
const MAC_B = 'aa:aa:aa:aa:aa:02';

describe('FlowAggregator dedup', () => {
  it('keeps only the exporter that saw the most bytes for each client', () => {
    const agg = new FlowAggregator();
    // Gateway (device 1) sees all of client A's traffic; an intermediate
    // switch/router (device 2) sees a subset of the same flows.
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 10_000, packets: 20 });
    agg.add({ exporterId: 2, siteId: 1, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 7_000, packets: 14 });

    const rows = agg.drain(50);
    expect(rows).toHaveLength(1);
    expect(rows[0].bytes).toBe(10_000);
  });

  it('breaks byte ties deterministically by lowest exporter id', () => {
    const agg = new FlowAggregator();
    agg.add({ exporterId: 5, siteId: 1, clientKey: MAC_A, direction: 'upload', app: 'DNS', bytes: 100, packets: 1 });
    agg.add({ exporterId: 3, siteId: 1, clientKey: MAC_A, direction: 'upload', app: 'QUIC', bytes: 100, packets: 1 });

    const rows = agg.drain(50);
    expect(rows).toHaveLength(1);
    expect(rows[0].app).toBe('QUIC'); // exporter 3 wins the tie
  });

  it('picks the winning exporter per client independently', () => {
    const agg = new FlowAggregator();
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 500, packets: 1 });
    agg.add({ exporterId: 2, siteId: 1, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 100, packets: 1 });
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_B, direction: 'download', app: 'HTTPS', bytes: 100, packets: 1 });
    agg.add({ exporterId: 2, siteId: 1, clientKey: MAC_B, direction: 'download', app: 'HTTPS', bytes: 900, packets: 1 });

    const rows = agg.drain(50);
    const a = rows.find((r) => r.clientKey === MAC_A);
    const b = rows.find((r) => r.clientKey === MAC_B);
    expect(a?.bytes).toBe(500); // device 1 wins for A
    expect(b?.bytes).toBe(900); // device 2 wins for B
  });

  it('accumulates repeated samples within the window and clears on drain', () => {
    const agg = new FlowAggregator();
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_A, direction: 'upload', app: 'HTTPS', bytes: 100, packets: 1 });
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_A, direction: 'upload', app: 'HTTPS', bytes: 250, packets: 2 });

    const rows = agg.drain(50);
    expect(rows).toHaveLength(1);
    expect(rows[0].bytes).toBe(350);
    expect(rows[0].packets).toBe(3);
    expect(agg.drain(50)).toHaveLength(0);
  });
});

describe('FlowAggregator top-N fold', () => {
  it('folds clients beyond the top-N into the "other" bucket', () => {
    const agg = new FlowAggregator();
    for (let i = 0; i < 5; i++) {
      const mac = `aa:aa:aa:aa:bb:0${i}`;
      agg.add({ exporterId: 1, siteId: 1, clientKey: mac, direction: 'download', app: 'HTTPS', bytes: (i + 1) * 1000, packets: 1 });
    }

    const rows = agg.drain(2);
    const macs = new Set(rows.map((r) => r.clientKey));
    expect(macs.has('aa:aa:aa:aa:bb:04')).toBe(true); // biggest
    expect(macs.has('aa:aa:aa:aa:bb:03')).toBe(true); // second
    expect(macs.has(CLIENT_OTHER)).toBe(true);
    const other = rows.find((r) => r.clientKey === CLIENT_OTHER);
    expect(other?.bytes).toBe(1000 + 2000 + 3000); // the three folded clients
  });

  it('never folds the unknown pseudo-client and does not let it consume a top-N slot', () => {
    const agg = new FlowAggregator();
    agg.add({ exporterId: 1, siteId: 1, clientKey: CLIENT_UNKNOWN, direction: 'download', app: 'HTTPS', bytes: 999_999, packets: 1 });
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 10, packets: 1 });

    const rows = agg.drain(1);
    const macs = new Set(rows.map((r) => r.clientKey));
    expect(macs.has(CLIENT_UNKNOWN)).toBe(true);
    expect(macs.has(MAC_A)).toBe(true); // still fits — unknown didn't take its slot
  });
});

describe('classifyApp', () => {
  it('classifies by the remote port first', () => {
    expect(classifyApp(6, 54321, 443)).toBe('HTTPS');
    expect(classifyApp(17, 54321, 443)).toBe('QUIC');
    expect(classifyApp(17, 50000, 53)).toBe('DNS');
    expect(classifyApp(6, 50000, 22)).toBe('SSH');
  });

  it('falls back to the local port for inbound services', () => {
    // Remote ephemeral port, local well-known port (client hosts SSH)
    expect(classifyApp(6, 22, 51515)).toBe('SSH');
  });

  it('handles non-port protocols and fallbacks', () => {
    expect(classifyApp(1, 0, 0)).toBe('ICMP');
    expect(classifyApp(58, 0, 0)).toBe('ICMP');
    expect(classifyApp(47, 0, 0)).toBe('GRE');
    expect(classifyApp(6, 49152, 49153)).toBe('Other TCP');
    expect(classifyApp(17, 49152, 49153)).toBe('Other UDP');
    expect(classifyApp(132, 0, 0)).toBe('Other');
  });
});

// Outside review J4: a client is a MAC within a site.
describe('FlowAggregator sites', () => {
  it('keeps the same MAC at two sites apart, deduplicating within each', () => {
    const agg = new FlowAggregator();
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 1_000, packets: 1 });
    agg.add({ exporterId: 2, siteId: 1, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 400, packets: 1 });
    agg.add({ exporterId: 9, siteId: 3, clientKey: MAC_A, direction: 'download', app: 'HTTPS', bytes: 50, packets: 1 });

    const rows = agg.drain(50);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.siteId === 1)?.bytes).toBe(1_000); // exporter 2's copy dropped
    expect(rows.find((r) => r.siteId === 3)?.bytes).toBe(50); // not lost to site 1's bigger exporter
  });

  it("keeps each site's unknown bucket and folds into each site's own 'other'", () => {
    const agg = new FlowAggregator();
    agg.add({ exporterId: 1, siteId: 1, clientKey: CLIENT_UNKNOWN, direction: 'upload', app: 'DNS', bytes: 10, packets: 1 });
    agg.add({ exporterId: 9, siteId: 3, clientKey: CLIENT_UNKNOWN, direction: 'upload', app: 'DNS', bytes: 20, packets: 1 });
    agg.add({ exporterId: 1, siteId: 1, clientKey: MAC_A, direction: 'upload', app: 'DNS', bytes: 500, packets: 1 });
    agg.add({ exporterId: 9, siteId: 3, clientKey: MAC_B, direction: 'upload', app: 'DNS', bytes: 5, packets: 1 });

    const rows = agg.drain(1); // only the biggest real client keeps its identity
    expect(rows.filter((r) => r.clientKey === CLIENT_UNKNOWN).map((r) => r.siteId).sort()).toEqual([1, 3]);
    expect(rows.find((r) => r.clientKey === CLIENT_OTHER)?.siteId).toBe(3);
    expect(rows.find((r) => r.clientKey === MAC_A)?.siteId).toBe(1);
  });
});
