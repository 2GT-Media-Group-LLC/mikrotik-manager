import { tracerouteHops } from '../traceroute';

// As a CRS309 on 7.25.1 sent them to 8.8.8.8 (#460), trimmed.
const rows: Record<string, string>[] = [
  { '.section': '0', address: '192.168.0.1', sent: '1', avg: '0.3' },
  { '.section': '0', address: '50.39.144.1', sent: '1', avg: '2.1' },
  { '.section': '0', address: '', sent: '1', loss: '0' },
  { '.section': '1', address: '192.168.0.1', sent: '2', avg: '0.3' },
  { '.section': '1', address: '50.39.144.1', sent: '2', avg: '2.2' },
  { '.section': '1', address: '', sent: '2', loss: '100' },
  { '.section': '1', address: '8.8.8.8', sent: '1', avg: '5.5' },
];

describe('tracerouteHops (#460)', () => {
  it('takes the last, fullest snapshot of the route, in hop order', () => {
    expect(tracerouteHops(rows)).toEqual([
      { address: '192.168.0.1', sent: '2', avg: '0.3' },
      { address: '50.39.144.1', sent: '2', avg: '2.2' },
      { address: '', sent: '2', loss: '100' },
      { address: '8.8.8.8', sent: '1', avg: '5.5' },
    ]);
  });

  it('reads one hop on RouterOS 6.49 the same way, and nothing as nothing', () => {
    expect(tracerouteHops([{ '.section': '0', address: '10.0.2.2', sent: '1', avg: '1.2' }])).toEqual([{ address: '10.0.2.2', sent: '1', avg: '1.2' }]);
    expect(tracerouteHops([])).toEqual([]);
  });

  it('keeps rows that carry no section as they are', () => {
    expect(tracerouteHops([{ address: '10.0.0.1' }, { address: '10.0.0.2' }])).toEqual([{ address: '10.0.0.1' }, { address: '10.0.0.2' }]);
  });
});
