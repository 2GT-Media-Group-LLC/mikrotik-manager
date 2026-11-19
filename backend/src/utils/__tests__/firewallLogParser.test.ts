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

  it('parses an IPv6 TCP firewall log', () => {
    const event = parseFirewallLog(
      'FW-ACCEPT forward: in:wan out:lan, connection-state:new, ' +
      'proto TCP (SYN), ' +
      '[2001:db8:1::10]:54321->[2001:db8:2::20]:443, len 60'
    );

    expect(event?.action).toBe('accept');
    expect(event?.protocol).toBe('tcp');
    expect(event?.srcIp).toBe('2001:db8:1::10');
    expect(event?.srcPort).toBe(54321);
    expect(event?.dstIp).toBe('2001:db8:2::20');
    expect(event?.dstPort).toBe(443);
  });

  it('parses an ICMPv6 firewall log without ports', () => {
    const event = parseFirewallLog(
      'FW-DROP input: in:wan, proto ICMPv6 (type 128, code 0), ' +
      '[2001:db8::10]->[2001:db8::1], len 64'
    );

    expect(event?.action).toBe('drop');
    expect(event?.protocol).toBe('icmpv6');
    expect(event?.tcpFlags).toBe('type 128, code 0');
    expect(event?.srcIp).toBe('2001:db8::10');
    expect(event?.dstIp).toBe('2001:db8::1');
    expect(event?.srcPort).toBeUndefined();
    expect(event?.dstPort).toBeUndefined();
  });

  it('returns null for a normal RouterOS log', () => {
    expect(
      parseFirewallLog('user operator logged in from 192.0.2.50 via api')
    ).toBeNull();
  });

  it('reads "(unknown 0)" as no interface', () => {
    const e = parseFirewallLog('zone drop in mtm#0khn input: in:bridge out:(unknown 0), connection-state:new src-mac D0:EA:11:05:2E:44, proto UDP, 192.168.0.84:5678->255.255.255.255:5678, len 193');
    expect(e?.inInterface).toBe('bridge');
    expect(e?.outInterface).toBeUndefined();
    expect(e?.prefix).toBe('zone drop in mtm#0khn');
  });

  it('reads a line from a chain of the user\'s own, such as a zone pair\'s (#369)', () => {
    const fwd = parseFirewallLog('zone accept mtm#w4yr LAN-to-WAN: in:bridge out:ether1, connection-state:new src-mac 02:00:00:00:00:01, proto TCP (SYN), 192.168.88.10:51234->1.1.1.1:443, len 60');
    expect(fwd).toEqual(expect.objectContaining({ action: 'accept', prefix: 'zone accept mtm#w4yr', chain: 'forward', ruleChain: 'LAN-to-WAN', inInterface: 'bridge', outInterface: 'ether1', dstPort: 443 }));
    // As RouterOS 7.25 printed it, from a jump target off output.
    const out = parseFirewallLog('mtmchaintest mtm-test-out: in:(unknown 0) out:ether1, connection-state:established proto TCP (ACK,FIN), 10.0.2.15:48244->198.35.26.224:443, len 40');
    expect(out).toEqual(expect.objectContaining({ prefix: 'mtmchaintest', chain: 'output', ruleChain: 'mtm-test-out' }));
    const input = parseFirewallLog('WAN-to-router: in:ether1 out:(unknown 0), proto ICMP (type 8, code 0), 203.0.113.10->192.0.2.1, len 84');
    expect(input).toEqual(expect.objectContaining({ prefix: '', chain: 'input', ruleChain: 'WAN-to-router' }));
    // The built-in chains carry no ruleChain, and a prefix with a colon still reads.
    const plain = parseFirewallLog('FW: forward: in:bridge out:ether1, proto UDP, 10.0.0.1:1->10.0.0.2:2, len 30');
    expect(plain?.prefix).toBe('FW:');
    expect(plain?.chain).toBe('forward');
    expect(plain && 'ruleChain' in plain).toBe(false);
  });
});
