import { describe, it, expect } from 'vitest';
import { endpoint, rateBps, sortConnections } from './connections';

describe('connection rows (discussion #85)', () => {
  it('reads the port fields RouterOS 7.24 sends', () => {
    expect(endpoint({ 'src-address': '10.0.0.5', 'src-port': '51515' }, 'src')).toEqual({ ip: '10.0.0.5', port: '51515' });
  });

  it('splits the older address:port form, IPv4 and bracketed IPv6', () => {
    expect(endpoint({ 'dst-address': '192.0.2.1:443' }, 'dst')).toEqual({ ip: '192.0.2.1', port: '443' });
    expect(endpoint({ 'dst-address': '[2001:db8::1]:443' }, 'dst')).toEqual({ ip: '2001:db8::1', port: '443' });
    expect(endpoint({ 'dst-address': '2001:db8::1' }, 'dst')).toEqual({ ip: '2001:db8::1', port: '' });
  });

  it('reads rates with units', () => {
    expect(rateBps('12.5kbps')).toBe(12500);
    expect(rateBps('3Mbps')).toBe(3e6);
    expect(rateBps('800')).toBe(800);
    expect(rateBps(undefined)).toBe(0);
  });

  it('sorts by port numerically, address numerically, and bytes', () => {
    const rows = [
      { 'src-address': '10.0.0.10', 'dst-address': '1.1.1.1', 'dst-port': '443', 'orig-bytes': '5' },
      { 'src-address': '10.0.0.9', 'dst-address': '1.1.1.1', 'dst-port': '53', 'orig-bytes': '50' },
      { 'src-address': '10.0.0.100', 'dst-address': '1.1.1.1', 'dst-port': '8080', 'orig-bytes': '1' },
    ];
    expect(sortConnections(rows, 'dport', 'asc').map((r) => r['dst-port'])).toEqual(['53', '443', '8080']);
    expect(sortConnections(rows, 'src', 'asc').map((r) => r['src-address'])).toEqual(['10.0.0.9', '10.0.0.10', '10.0.0.100']);
    expect(sortConnections(rows, 'bytes', 'desc').map((r) => r['orig-bytes'])).toEqual(['50', '5', '1']);
  });
});
