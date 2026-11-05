import { tunnelsFrom, inPrefix, MAX_SESSIONS, type TunnelInput } from '../tunnels';

const empty: TunnelInput = { ipsecPeers: [], ipsecActive: [], pppoeServers: [], pppActive: [], pppoeClients: [], eoip: [], gre: [], ipip: [] };
const rows = (over: Partial<TunnelInput>) => tunnelsFrom({ ...empty, ...over });

describe('tunnelsFrom (#310)', () => {
  it('nothing configured is nothing to show', () => {
    expect(rows({})).toEqual([]);
  });

  it('matches active IPsec peers to the most specific configured peer', () => {
    const r = rows({
      ipsecPeers: [
        { '.id': '*1', name: 'branch-a', address: '203.0.113.10/32', 'exchange-mode': 'ike2' },
        { '.id': '*2', name: 'road', address: '0.0.0.0/0', passive: 'true' },
        { '.id': '*3', name: 'branch-b', address: '198.51.100.7/32' },
      ],
      ipsecActive: [
        { 'remote-address': '203.0.113.10', 'local-address': '192.0.2.1', state: 'established', uptime: '3d4h', 'ph2-total': '2' },
        { 'remote-address': '100.64.1.5', state: 'established' },
        { 'remote-address': '100.64.1.6', state: 'established' },
      ],
    });
    const a = r.find((x) => x.name === 'branch-a')!;
    expect(a).toMatchObject({ status: 'up', state: 'established', uptime: '3d4h', local: '192.0.2.1', remote: '203.0.113.10' });
    expect(a.detail).toBe('ike2 · 2 SAs');
    expect(r.find((x) => x.name === 'road')).toMatchObject({ status: 'up', remote: '0.0.0.0/0', detail: 'passive · 2 of 2 connected' });
    expect(r.find((x) => x.name === 'branch-b')).toMatchObject({ status: 'down', state: 'not connected' });
  });

  it('a passive peer with nobody on it is waiting, not down; a disabled one is disabled', () => {
    const r = rows({ ipsecPeers: [{ name: 'road', address: '0.0.0.0/0', passive: 'yes' }, { name: 'old', address: '192.0.2.9', disabled: 'true' }] });
    expect(r.map((x) => [x.name, x.status, x.state])).toEqual([['road', 'idle', 'waiting'], ['old', 'disabled', 'disabled']]);
  });

  it('never keeps a tunnel\'s IPsec secret', () => {
    const r = rows({ eoip: [{ name: 'eoip-hq', 'local-address': '192.0.2.1', 'remote-address': '192.0.2.2', 'tunnel-id': '7', running: 'true', 'ipsec-secret': 'SUPERSECRET' }] });
    expect(r[0]).toMatchObject({ kind: 'eoip', status: 'up', detail: 'tunnel 7 · IPsec' });
    expect(JSON.stringify(r)).not.toContain('SUPERSECRET');
  });

  it('tells running, stopped and disabled interface tunnels apart', () => {
    const r = rows({
      gre: [{ name: 'gre1', 'local-address': '0.0.0.0', 'remote-address': '192.0.2.5', running: 'false' }],
      ipip: [{ name: 'ipip1', 'remote-address': '192.0.2.6', disabled: 'true' }],
    });
    expect(r.map((x) => [x.kind, x.status])).toEqual([['gre', 'down'], ['ipip', 'disabled']]);
    expect(r[0].local).toBeNull();
  });

  it('lists PPPoE servers with their sessions, and every session', () => {
    const r = rows({
      pppoeServers: [{ 'service-name': 'isp', interface: 'vlan100' }],
      pppActive: [
        { '.id': '*A', name: 'cust1', service: 'pppoe', 'caller-id': 'AA:BB:CC:00:00:01', address: '100.64.0.10', uptime: '1h' },
        { '.id': '*B', name: 'cust2', service: 'pppoe', 'caller-id': 'AA:BB:CC:00:00:02', address: '100.64.0.11', uptime: '2h' },
        { '.id': '*C', name: 'vpnuser', service: 'l2tp', 'caller-id': '203.0.113.9', address: '10.9.0.2' },
      ],
    });
    expect(r.find((x) => x.kind === 'pppoe-server')).toMatchObject({ name: 'isp', local: 'vlan100', status: 'up', detail: '2 PPPoE sessions' });
    const sessions = r.filter((x) => x.kind === 'ppp-session');
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({ name: 'cust1', remote: '100.64.0.10', detail: 'pppoe · from AA:BB:CC:00:00:01', uptime: '1h' });
    expect(rows({ pppoeServers: [{ 'service-name': 'isp', interface: 'vlan100' }] })[0]).toMatchObject({ status: 'idle', detail: '0 PPPoE sessions' });
  });

  it('keeps at most MAX_SESSIONS sessions per device', () => {
    const pppActive = Array.from({ length: MAX_SESSIONS + 10 }, (_, i) => ({ '.id': `*${i}`, name: `u${i}`, service: 'pppoe' }));
    expect(rows({ pppActive }).filter((x) => x.kind === 'ppp-session')).toHaveLength(MAX_SESSIONS);
  });

  it('shows PPPoE clients up or down', () => {
    const r = rows({ pppoeClients: [{ name: 'wan-pppoe', interface: 'ether1', user: 'acct123', running: 'true' }, { name: 'backup', interface: 'ether2' }] });
    expect(r.map((x) => [x.name, x.status, x.local, x.detail])).toEqual([['wan-pppoe', 'up', 'ether1', 'user acct123'], ['backup', 'down', 'ether2', null]]);
  });
});

describe('inPrefix', () => {
  it('matches IPv4 and IPv6 prefixes and lone addresses', () => {
    expect(inPrefix('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inPrefix('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(inPrefix('192.0.2.1', '192.0.2.1')).toBe(true);
    expect(inPrefix('2001:db8::5', '2001:db8::/32')).toBe(true);
    expect(inPrefix('2001:db9::5', '2001:db8::/32')).toBe(false);
    expect(inPrefix('192.0.2.1', '::/0')).toBe(false);
    expect(inPrefix('nonsense', '0.0.0.0/0')).toBe(false);
  });
});
