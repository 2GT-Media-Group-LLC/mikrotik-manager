import { parseFirewallLog } from '../firewallLogParser';

const packet =
  'forward: in:vlan-source out:vlan-destination, connection-state:new ' +
  'src-mac 02:00:00:00:00:01, proto TCP (SYN), ' +
  '192.0.2.10:54321->198.51.100.20:443, len 52';

describe('parseFirewallLog', () => {
  it('parses a RouterOS firewall packet log', () => {
    expect(parseFirewallLog(`FW-ACCEPT ${packet}`)).toEqual({
      action: 'accept',
      prefix: 'FW-ACCEPT',
      chain: 'forward',
      inInterface: 'vlan-source',
      outInterface: 'vlan-destination',
      connectionState: 'new',
      srcMac: '02:00:00:00:00:01',
      protocol: 'tcp',
      tcpFlags: 'SYN',
      srcIp: '192.0.2.10',
      srcPort: 54321,
      dstIp: '198.51.100.20',
      dstPort: 443,
      length: 52,
    });
  });

  it.each([
    ['FW-DROP', 'drop'],
    ['DENY-IOT', 'drop'],
    ['BLOCK-GUEST', 'drop'],
    ['FW-REJECT', 'reject'],
    ['ALLOW-WAN', 'accept'],
    ['PERMIT-DNS', 'accept'],
    ['FW-FASTTRACK', 'fasttrack'],
    ['CUSTOM-PREFIX', 'unknown'],
  ] as const)('infers %s as %s', (prefix, action) => {
    expect(parseFirewallLog(`${prefix} ${packet}`)?.action).toBe(action);
  });

  it('parses a UDP firewall log', () => {
    const event = parseFirewallLog(
      'FW-ACCEPT forward: in:vlan-source out:vlan-destination, ' +
      'connection-state:new src-mac 02:00:00:00:00:01, proto UDP, ' +
      '192.0.2.10:53000->198.51.100.20:53, len 60'
    );

    expect(event?.action).toBe('accept');
    expect(event?.protocol).toBe('udp');
    expect(event?.srcPort).toBe(53000);
    expect(event?.dstPort).toBe(53);
  });

  it('parses an ICMP firewall log without ports', () => {
    const event = parseFirewallLog(
      'FW-DROP forward: in:vlan-source out:vlan-destination, ' +
      'connection-state:new src-mac 02:00:00:00:00:01, ' +
      'proto ICMP (type 8, code 0), 192.0.2.10->198.51.100.20, len 60'
    );

    expect(event?.action).toBe('drop');
    expect(event?.protocol).toBe('icmp');
    expect(event?.tcpFlags).toBe('type 8, code 0');
    expect(event?.srcPort).toBeUndefined();
    expect(event?.dstPort).toBeUndefined();
  });

  it('returns null for a normal RouterOS log', () => {
    expect(
      parseFirewallLog('user operator logged in from 192.0.2.50 via api')
    ).toBeNull();
  });
});
