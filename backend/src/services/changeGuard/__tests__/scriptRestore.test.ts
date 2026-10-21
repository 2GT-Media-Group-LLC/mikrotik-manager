import { buildRestorePlan, restoreScopeFor, rosQuote, captureScope, CHUNK_MAX } from '../scriptRestore';

const plan = (captured: Parameters<typeof buildRestorePlan>[0]) => buildRestorePlan(captured, 'mtm-revert-abc');
const all = (p: ReturnType<typeof plan>) => p.chunks.join('\n');

describe('restoreScopeFor', () => {
  it('names the menus a change touches, parents first', () => {
    expect(restoreScopeFor('bond.delete')).toEqual(['bonding', 'bridgePort', 'bridgeVlan', 'ipAddress']);
    expect(restoreScopeFor('bridge-port.move')).toEqual(['bridge', 'bridgePort', 'bridgeVlan', 'ipAddress']);
  });
  it('has no scope for changes it cannot restore selectively', () => {
    expect(restoreScopeFor('command.bulk')).toBeNull();
    expect(restoreScopeFor('wireguard.set')).toBeNull();
  });
});

describe('rosQuote', () => {
  it('escapes what RouterOS would interpret', () => {
    expect(rosQuote('a "b" $c ?d \\e\nf')).toBe('"a \\"b\\" \\$c \\?d \\\\e\\nf"');
  });
});

describe('buildRestorePlan', () => {
  it('removes the scheduler before anything else, and cleans up after', () => {
    const p = plan([{ menu: 'ipAddress', rows: [] }]);
    expect(p.onEvent.split('\n')[0]).toBe('/system scheduler remove [find name="mtm-revert-abc"]');
    expect(p.onEvent).toContain('/system script run [find name=$s]');
    expect(p.onEvent).toContain('/system script remove $s');
  });

  it('sets back rows by id, adds back deleted ones, and removes rows the change created', () => {
    const p = all(plan([{ menu: 'bridgePort', rows: [
      { '.id': '*1', interface: 'ether2', bridge: 'bridge', pvid: '10', hw: 'true', status: 'in-bridge', 'hw-offload': 'true', dynamic: 'false' },
      { '.id': '*9', interface: 'wlan1', bridge: 'bridge', dynamic: 'true' },
    ] }]));
    expect(p).toContain(':local keep {"*1"}');
    expect(p).toContain('[/interface bridge port find where dynamic=no]');
    expect(p).toContain('/interface bridge port set *1 interface="ether2" bridge="bridge" pvid="10" hw="yes"');
    expect(p).toContain('/interface bridge port add interface="ether2" bridge="bridge" pvid="10" hw="yes"');
    // Status and dynamic rows are never written back.
    expect(p).not.toContain('status=');
    expect(p).not.toContain('hw-offload=');
    expect(p).not.toContain('*9');
  });

  it('runs removals children first and sets parents first', () => {
    const p = all(plan([
      { menu: 'bridgePort', rows: [{ '.id': '*1', interface: 'bond1', bridge: 'bridge', dynamic: 'false' }] },
      { menu: 'bonding', rows: [{ '.id': '*5', name: 'bond1', slaves: 'ether1,ether2', mode: '802.3ad' }] },
    ]));
    expect(p.indexOf('/interface bridge port remove')).toBeLessThan(p.indexOf('/interface bonding remove'));
    expect(p.indexOf('/interface bonding set *5')).toBeLessThan(p.indexOf('/interface bridge port set *1'));
  });

  it('writes a blackhole route back with the bare flag RouterOS scripts accept', () => {
    // RouterOS 7 prints blackhole="" on a blackhole route; in a script only the
    // bare word works (blackhole="" and blackhole=yes are silently ignored).
    const p = all(plan([{ menu: 'ipRoute', rows: [
      { '.id': '*80000005', 'dst-address': '203.0.113.0/24', blackhole: '', distance: '1', comment: 'bh', dynamic: 'false' },
      { '.id': '*80000006', 'dst-address': '0.0.0.0/0', gateway: '192.168.0.1', distance: '1', dynamic: 'false' },
    ] }]));
    expect(p).toContain('/ip route add dst-address="203.0.113.0/24" blackhole distance="1" comment="bh"');
    expect(p).not.toMatch(/blackhole="/);
    expect(p).toContain('/ip route add dst-address="0.0.0.0/0" gateway="192.168.0.1" distance="1"');
  });

  it('clears a comment the snapshot did not have', () => {
    const p = all(plan([{ menu: 'interface', rows: [{ '.id': '*3', name: 'ether3', disabled: 'false', mtu: '1500' }] }]));
    expect(p).toContain('/interface set *3 disabled="no" mtu="1500" comment=""');
  });

  it('rebuilds an ordered menu in order with globals, removing the old rules only if every add worked', () => {
    const p = all(plan([{ menu: 'firewallFilter', rows: [
      { '.id': '*A', chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '22', bytes: '100', packets: '2', dynamic: 'false' },
      { '.id': '*B', chain: 'input', action: 'drop', dynamic: 'false' },
    ] }]));
    const first = p.indexOf('chain="input" action="accept" protocol="tcp" dst-port="22"');
    const second = p.indexOf('chain="input" action="drop"');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(p).not.toContain('bytes=');
    expect(p).toMatch(/:global mtmrevertabco\d/);
    expect(p).toMatch(/:if \(\$mtmrevertabck\d\) do=\{ :foreach r in=\$mtmrevertabco\d do=\{ :do \{ \/ip firewall filter remove \$r \}/);
  });

  it('removes and re-adds address-list entries rather than setting them back', () => {
    const p = all(plan([{ menu: 'addressList', rows: [{ '.id': '*7', list: 'mgmt', address: '10.0.0.5', dynamic: 'false' }] }]));
    expect(p).toContain(':do { /ip firewall address-list remove *7 } on-error={}');
    expect(p).toContain('/ip firewall address-list add list="mgmt" address="10.0.0.5"');
  });

  it('splits a long restore into chunks under the RouterOS limit', () => {
    const rows = Array.from({ length: 600 }, (_, n) => ({
      '.id': `*${(n + 1).toString(16).toUpperCase()}`, chain: 'forward', action: 'accept',
      'src-address': `198.18.${n >> 8}.${n & 255}`, comment: `rule ${n} with a comment long enough to matter`, dynamic: 'false',
    }));
    const p = plan([{ menu: 'firewallFilter', rows }]);
    expect(p.chunks.length).toBeGreaterThan(1);
    for (const c of p.chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(p.onEvent).toContain('"mtm-revert-abc-1"');
    expect(p.onEvent).toContain(`"mtm-revert-abc-${p.chunks.length}"`);
  });
});

describe('captureScope', () => {
  it('reads each menu and leaves out one the device does not have', async () => {
    const execute = jest.fn(async (path: string) => {
      if (path === '/interface/ethernet/poe/print') throw new Error('no such command prefix');
      return [{ '.id': '*1' }];
    });
    const caps = await captureScope(execute, ['interface', 'ethernet', 'ethernetPoe']);
    expect(caps.map((c) => c.menu)).toEqual(['interface', 'ethernet']);
  });
});
