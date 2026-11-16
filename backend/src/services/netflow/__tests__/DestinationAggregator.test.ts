import { DestinationAggregator, OTHER_REMOTE, type DestinationSample } from '../DestinationAggregator';

const s = (o: Partial<DestinationSample>): DestinationSample => ({
  exporterId: 1, siteId: 3, clientKey: 'aa:bb:cc:dd:ee:01', app: 'HTTPS', remote: '142.250.1.1',
  direction: 'download', bytes: 100, packets: 1, ...o,
});

describe('DestinationAggregator (#366)', () => {
  it('sums each client, application and remote, by direction', () => {
    const a = new DestinationAggregator();
    a.add(s({ bytes: 100 }));
    a.add(s({ bytes: 50, direction: 'upload' }));
    a.add(s({ remote: '149.154.167.51', bytes: 10 }));
    const rows = a.drain();
    expect(rows).toEqual(expect.arrayContaining([
      { siteId: 3, clientKey: 'aa:bb:cc:dd:ee:01', app: 'HTTPS', remote: '142.250.1.1', uploadBytes: 50, downloadBytes: 100, packets: 2 },
      expect.objectContaining({ remote: '149.154.167.51', downloadBytes: 10 }),
    ]));
    expect(a.drain()).toEqual([]);
  });

  it('keeps the busiest remotes and sums the rest as other', () => {
    const a = new DestinationAggregator();
    for (let i = 1; i <= 5; i++) a.add(s({ remote: `203.0.113.${i}`, bytes: i * 100 }));
    const rows = a.drain(2);
    expect(rows.map((r) => r.remote).sort()).toEqual([OTHER_REMOTE, '203.0.113.4', '203.0.113.5'].sort());
    expect(rows.find((r) => r.remote === OTHER_REMOTE)?.downloadBytes).toBe(100 + 200 + 300);
  });

  it('counts a flow seen by two routers once, from the router that saw more of the client', () => {
    const a = new DestinationAggregator();
    a.add(s({ exporterId: 1, bytes: 1000 }));
    a.add(s({ exporterId: 2, bytes: 1000 }));
    a.add(s({ exporterId: 2, remote: '1.1.1.1', bytes: 10 }));
    const rows = a.drain();
    expect(rows.reduce((n, r) => n + r.downloadBytes, 0)).toBe(1010);
  });

  it('keeps the same MAC at two sites apart, and puts traffic with no site under 0', () => {
    const a = new DestinationAggregator();
    a.add(s({ siteId: 3 }));
    a.add(s({ siteId: 4, exporterId: 9 }));
    a.add(s({ siteId: null, exporterId: 7, clientKey: 'unknown' }));
    expect(a.drain().map((r) => r.siteId).sort()).toEqual([0, 3, 4]);
  });
});
