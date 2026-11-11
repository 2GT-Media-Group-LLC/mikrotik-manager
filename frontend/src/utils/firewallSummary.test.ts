import { describe, it, expect } from 'vitest';
import { ruleSummary, natSummary, formatBytes, formatCount } from './firewallSummary';

describe('ruleSummary', () => {
  it('summarizes an allow rule with address lists and a port', () => {
    expect(ruleSummary({
      action: 'accept', protocol: 'tcp', 'src-address-list': 'LAN', 'dst-port': '443',
    })).toBe('Allow TCP from list:LAN to any on 443');
  });

  it('summarizes a drop rule with connection state', () => {
    expect(ruleSummary({ action: 'drop', protocol: 'tcp', 'connection-state': 'invalid' }))
      .toBe('Drop TCP from any to any [invalid]');
  });

  it('falls back to interface when no address is set', () => {
    expect(ruleSummary({ action: 'accept', 'in-interface': 'ether1' }))
      .toBe('Allow any from if:ether1 to any');
  });

  it('shows jump target', () => {
    expect(ruleSummary({ action: 'jump', 'jump-target': 'mychain' }))
      .toMatch(/^Jump to mychain/);
  });
});

describe('natSummary', () => {
  it('summarizes masquerade', () => {
    expect(natSummary({ action: 'masquerade', chain: 'srcnat', 'out-interface': 'ether1' }))
      .toBe('Masquerade any out ether1');
  });
  it('summarizes a port-forward (dst-nat)', () => {
    expect(natSummary({
      action: 'dst-nat', chain: 'dstnat', protocol: 'tcp', 'dst-port': '443',
      'to-addresses': '192.168.1.10', 'to-ports': '443',
    })).toBe('Forward TCP any:443 → 192.168.1.10:443');
  });
  it('names the WAN of a netmap or src-nat (#440)', () => {
    expect(natSummary({ action: 'netmap', chain: 'srcnat', 'src-address': '192.168.62.0/24', 'to-addresses': '203.0.113.0/24', 'out-interface': 'ether2' }))
      .toBe('Netmap 192.168.62.0/24 → 203.0.113.0/24 out ether2');
    expect(natSummary({ action: 'netmap', chain: 'dstnat', 'dst-address': '203.0.113.10', 'to-addresses': '192.168.1.10', 'in-interface': 'ether1' }))
      .toBe('1:1 NAT 203.0.113.10 ↔ 192.168.1.10 in ether1');
    expect(natSummary({ action: 'src-nat', chain: 'srcnat', 'to-addresses': '198.51.100.1', 'out-interface': 'ether1' }))
      .toBe('Source-NAT any → 198.51.100.1 out ether1');
  });
});

describe('formatBytes / formatCount', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.00 GB');
  });
  it('formats counts', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(2500)).toBe('2.5K');
    expect(formatCount(3_400_000)).toBe('3.4M');
  });
});
