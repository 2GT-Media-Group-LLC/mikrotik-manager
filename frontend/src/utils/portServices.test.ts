import { describe, expect, it } from 'vitest';
import { highlightColors, savedServices, serviceFor, serviceIndex, trafficKind } from './portServices';

describe('serviceFor', () => {
  const idx = serviceIndex();
  it('names the destination port', () => {
    expect(serviceFor(idx, 'tcp', 443)).toBe('HTTPS');
    expect(serviceFor(idx, 'tcp', 587)).toBe('SUBMISSION');
    expect(serviceFor(idx, 'TCP', 8291)).toBe('WINBOX');
  });
  it('keeps to the protocol', () => {
    expect(serviceFor(idx, 'udp', 443)).toBe('HTTPS');
    expect(serviceFor(idx, 'udp', 22)).toBeUndefined();
    expect(serviceFor(idx, 'icmp', 443)).toBeUndefined();
  });
  it('falls back to the source port for replies', () => {
    expect(serviceFor(idx, 'udp', 51234, 53)).toBe('DNS');
    expect(serviceFor(idx, 'tcp', 51234, 40000)).toBeUndefined();
  });
  it('lets saved entries add and override', () => {
    const custom = serviceIndex([
      { port: 443, protocol: 'tcp', name: 'Web' },
      { port: 9999, protocol: 'both', name: 'Camera' },
    ]);
    expect(serviceFor(custom, 'tcp', 443)).toBe('Web');
    expect(serviceFor(custom, 'udp', 443)).toBe('HTTPS');
    expect(serviceFor(custom, 'udp', 9999)).toBe('Camera');
  });
  it('names every port in a saved range, with single ports and narrower ranges over it (#415)', () => {
    const custom = serviceIndex([
      { port: 5050, protocol: 'udp', name: 'Voice' },
      { port: 5000, to: 5100, protocol: 'udp', name: 'Game' },
      { port: 5040, to: 5060, protocol: 'udp', name: 'Lobby' },
      { port: 20, to: 25, protocol: 'tcp', name: 'Old' },
    ]);
    expect(serviceFor(custom, 'udp', 5000)).toBe('Game');
    expect(serviceFor(custom, 'udp', 5100)).toBe('Game');
    expect(serviceFor(custom, 'udp', 5101)).toBeUndefined();
    expect(serviceFor(custom, 'udp', 5045)).toBe('Lobby');
    expect(serviceFor(custom, 'udp', 5050)).toBe('Voice');
    expect(serviceFor(custom, 'tcp', 5050)).toBeUndefined();
    expect(serviceFor(custom, 'tcp', 22)).toBe('Old');
  });
});

describe('trafficKind', () => {
  it('finds DHCP before broadcast', () => {
    expect(trafficKind({ protocol: 'udp', dstIp: '255.255.255.255', srcPort: 68, dstPort: 67 })).toBe('dhcp');
    expect(trafficKind({ protocol: 'udp', dstIp: 'ff02::1:2', dstPort: 547 })).toBe('dhcp');
  });
  it('finds multicast and broadcast', () => {
    expect(trafficKind({ protocol: 'udp', dstIp: '224.0.0.251', dstPort: 5353 })).toBe('multicast');
    expect(trafficKind({ protocol: 'udp', dstIp: '239.255.255.250', dstPort: 1900 })).toBe('multicast');
    expect(trafficKind({ protocol: 'icmpv6', dstIp: 'FF02::1' })).toBe('multicast');
    expect(trafficKind({ protocol: 'udp', dstIp: '255.255.255.255', dstPort: 5678 })).toBe('multicast');
  });
  it('leaves the rest', () => {
    expect(trafficKind({ protocol: 'tcp', dstIp: '192.168.88.1', dstPort: 67 })).toBeUndefined();
    expect(trafficKind({ protocol: 'udp', dstIp: '240.0.0.1' })).toBeUndefined();
    expect(trafficKind({ protocol: 'tcp', dstIp: 'fe80::1' })).toBeUndefined();
  });
});

describe('saved settings', () => {
  it('falls back to the defaults', () => {
    expect(highlightColors(undefined)).toEqual({ dhcp: 'cyan', multicast: 'violet' });
    expect(highlightColors({ dhcp: 'none', multicast: 'toString' })).toEqual({ dhcp: 'none', multicast: 'violet' });
  });
  it('drops malformed entries', () => {
    expect(savedServices([{ port: 80, protocol: 'tcp', name: 'Web' }, { port: 0, protocol: 'tcp', name: 'x' }, null, 'x'])).toEqual([
      { port: 80, protocol: 'tcp', name: 'Web' },
    ]);
    expect(savedServices('nope')).toEqual([]);
  });
});

describe('saved ranges', () => {
  it('keeps a well-formed range and drops a backwards one', () => {
    expect(savedServices([
      { port: 5000, to: 5100, protocol: 'udp', name: 'Game' },
      { port: 5000, to: 4000, protocol: 'udp', name: 'Bad' },
      { port: 5000, to: 70000, protocol: 'udp', name: 'Bad' },
    ])).toEqual([{ port: 5000, to: 5100, protocol: 'udp', name: 'Game' }]);
  });
});
