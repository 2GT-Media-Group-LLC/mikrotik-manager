import { splitHostPort, apiConnectionSources, managerIpFromConntrack, type DeviceSnapshot } from '../pathModel';

describe('splitHostPort', () => {
  it('reads IPv4 and IPv6 connection addresses', () => {
    expect(splitHostPort('10.0.0.1:8728')).toEqual({ ip: '10.0.0.1', port: 8728 });
    expect(splitHostPort('[fd10:99::1]:51000')).toEqual({ ip: 'fd10:99::1', port: 51000 });
    expect(splitHostPort('fd10:99::1.51000')).toEqual({ ip: 'fd10:99::1', port: 51000 });
  });
  it('gives no port when there is none', () => {
    expect(splitHostPort('fd10:99::1').port).toBeNaN();
    expect(splitHostPort('10.0.0.1').port).toBeNaN();
    expect(splitHostPort('junk')).toEqual({ ip: '', port: NaN });
  });
});

describe('managerIpFromConntrack over IPv6 (#205)', () => {
  const snap = (rows: Record<string, string>[], managerLocalPort: number | null = null) =>
    ({ mgmtConnections: rows, managerLocalPort } as unknown as DeviceSnapshot);
  it('finds the manager in the IPv6 connection table', () => {
    const rows = [
      { protocol: 'tcp', 'src-address': '[fd10:99::1]:51000', 'dst-address': '[fd10:99::7]:8729' },
      { protocol: 'tcp', 'src-address': '[fd10:99::9]:40000', 'dst-address': '[fd10:99::7]:8729' },
      { protocol: 'udp', 'src-address': '[fd10:99::1]:51000', 'dst-address': '[fd10:99::7]:8729' },
    ];
    expect(apiConnectionSources(snap(rows), 8729)).toHaveLength(2);
    expect(managerIpFromConntrack(snap(rows, 51000), 8729)).toBe('fd10:99::1');
  });
  it('reads the separate port fields RouterOS 7.24 uses (captured from a 7.24.5 switch)', () => {
    const rows = [
      { protocol: 'tcp', 'src-address': '192.168.0.76', 'src-port': '58431', 'dst-address': '192.168.0.51', 'dst-port': '8729' },
      { protocol: 'tcp', 'src-address': '192.168.0.76', 'src-port': '58428', 'dst-address': '192.168.0.51', 'dst-port': '22' },
      { protocol: 'tcp', 'src-address': 'fd99:205::1', 'src-port': '34418', 'dst-address': 'fd99:205::7', 'dst-port': '8729' },
    ];
    expect(apiConnectionSources(snap(rows), 8729)).toEqual([
      { ip: '192.168.0.76', port: 58431 },
      { ip: 'fd99:205::1', port: 34418 },
    ]);
    expect(managerIpFromConntrack(snap(rows, 34418), 8729)).toBe('fd99:205::1');
  });
  it('still reads the older address:port form', () => {
    const rows = [{ protocol: 'tcp', 'src-address': '10.99.0.1:51000', 'dst-address': '10.99.0.7:8728' }];
    expect(managerIpFromConntrack(snap(rows), 8728)).toBe('10.99.0.1');
  });
});
