import { poolSize, usedPerPool, poolState } from '../dhcpPools';

describe('DHCP pool usage (#156)', () => {
  it('sizes pools the way RouterOS writes them', () => {
    expect(poolSize('192.168.88.10-192.168.88.254')).toBe(245); // a wAP ax's defconf pool
    expect(poolSize('10.0.0.0/24')).toBe(256);
    expect(poolSize('10.0.0.10-10.0.0.19,10.0.1.0/30')).toBe(14);
    expect(poolSize('10.0.0.5')).toBe(1);
    expect(poolSize('')).toBeNull();
    expect(poolSize('fd00::/64')).toBeNull();
    expect(poolSize('10.0.0.20-10.0.0.10')).toBeNull();
  });
  it('counts used addresses per pool', () => {
    const m = usedPerPool([{ pool: 'lan', address: '10.0.0.10' }, { pool: 'lan', address: '10.0.0.11' }, { pool: 'guest', address: '10.1.0.5' }]);
    expect(m.get('lan')).toBe(2);
    expect(m.get('guest')).toBe(1);
  });
  it('warns from 80% and calls it full from 95%', () => {
    expect(poolState(197, 245)).toBe('warn'); // 80.4%
    expect(poolState(195, 245)).toBeNull(); // 79.6%
    expect(poolState(233, 245)).toBe('full');
    expect(poolState(10, 245)).toBeNull();
    expect(poolState(5, null)).toBeNull();
  });
});
