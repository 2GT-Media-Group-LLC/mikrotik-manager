import {
  isReadCommand, toCli, describeWrite, targetQuery, isPreviewableRoute, isDbWrite, cliValue,
} from '../changePreview';

describe('isReadCommand', () => {
  it('lets reads through', () => {
    expect(isReadCommand('/interface/vlan/print')).toBe(true);
    expect(isReadCommand('/interface/ethernet/switch/l3hw-settings/monitor', { once: '' })).toBe(true);
    expect(isReadCommand('/system/resource/getall')).toBe(true);
    expect(isReadCommand('/export')).toBe(true);
  });
  it('treats everything else as a write', () => {
    for (const c of ['/interface/vlan/add', '/interface/vlan/set', '/ip/address/remove', '/ip/firewall/filter/move',
      '/interface/enable', '/system/reboot', '/ip/dns/cache/flush', '/system/script/run', '/tool/fetch']) {
      expect(isReadCommand(c)).toBe(false);
    }
    expect(isReadCommand('/export', { file: 'x' })).toBe(false);
  });
});

describe('cliValue', () => {
  it('quotes only when it must', () => {
    expect(cliValue('vlan10')).toBe('vlan10');
    expect(cliValue('10.0.0.1/24')).toBe('10.0.0.1/24');
    expect(cliValue('')).toBe('""');
    expect(cliValue('Guest network')).toBe('"Guest network"');
    expect(cliValue('a"b$c')).toBe('"a\\"b\\$c"');
  });
});

describe('describeWrite', () => {
  it('renders an add', () => {
    const s = describeWrite('10.0.0.2', '/interface/vlan/add', { name: 'vlan10', 'vlan-id': '10', interface: 'bridge' }, null);
    expect(s.action).toBe('add');
    expect(s.path).toBe('/interface/vlan');
    expect(s.cli).toBe('/interface vlan add name=vlan10 vlan-id=10 interface=bridge');
    expect(s.changes).toEqual([]);
  });

  it('diffs a set against the current item, naming it rather than its id', () => {
    const target = { '.id': '*1A', name: 'ether5', mtu: '1500', disabled: 'false', comment: 'uplink' };
    const s = describeWrite('h', '/interface/set', { '.id': '*1A', mtu: '9000', disabled: 'no', comment: 'core uplink' }, target);
    expect(s.changes).toEqual([
      { field: 'mtu', from: '1500', to: '9000' },
      { field: 'comment', from: 'uplink', to: 'core uplink' },
    ]);
    expect(s.unchanged).toEqual(['disabled']);
    expect(s.cli).toBe('/interface set [find name=ether5] mtu=9000 disabled=no comment="core uplink"');
  });

  it('shows a field the item does not have yet as new', () => {
    const s = describeWrite('h', '/ip/dns/set', { servers: '1.1.1.1' }, { 'allow-remote-requests': 'true' });
    expect(s.changes).toEqual([{ field: 'servers', from: null, to: '1.1.1.1' }]);
  });

  it('never shows a secret', () => {
    const s = describeWrite('h', '/interface/wireguard/peers/set',
      { '.id': '*3', 'preshared-key': 'c2VjcmV0', comment: 'x' },
      { '.id': '*3', 'preshared-key': 'b2xk', comment: 'x', name: 'peer1' });
    expect(JSON.stringify(s)).not.toContain('c2VjcmV0');
    expect(JSON.stringify(s)).not.toContain('b2xk');
    expect(s.changes).toEqual([{ field: 'preshared-key', from: '(hidden)', to: '(hidden)' }]);
    expect(s.cli).toContain('preshared-key=(hidden)');
  });

  it('names a removed item', () => {
    const s = describeWrite('h', '/ip/address/remove', { '.id': '*7' }, { '.id': '*7', address: '10.9.0.1/24', interface: 'vlan90' });
    expect(s.cli).toBe('/ip address remove *7');
    expect(s.target?.address).toBe('10.9.0.1/24');
  });

  it('never selects by comment, which other items can share', () => {
    const s = describeWrite('h', '/interface/bridge/port/set', { '.id': '*2', pvid: '99' }, { '.id': '*2', interface: 'ether1', comment: 'defconf', pvid: '1' });
    expect(s.cli).toBe('/interface bridge port set *2 pvid=99');
  });

  it('quotes an emptied value', () => {
    const s = describeWrite('h', '/interface/bridge/vlan/add', { bridge: 'bridge', 'vlan-ids': '99', tagged: '', untagged: 'ether1' }, null);
    expect(s.cli).toBe('/interface bridge vlan add bridge=bridge vlan-ids=99 tagged="" untagged=ether1');
  });
});

describe('targetQuery', () => {
  it('reads the item by id, by name, or the singleton', () => {
    expect(targetQuery('/interface/set', { '.id': '*1A' })).toEqual({ print: '/interface/print', queries: ['?.id=*1A'] });
    expect(targetQuery('/interface/set', { numbers: 'ether1' })).toEqual({ print: '/interface/print', queries: ['?name=ether1'] });
    expect(targetQuery('/ip/dns/set', { servers: '1.1.1.1' })).toEqual({ print: '/ip/dns/print', queries: [] });
    expect(targetQuery('/interface/vlan/add', { name: 'x' })).toBeNull();
    expect(targetQuery('/interface/bridge/port/remove', { numbers: '*1,*2' })).toBeNull();
  });
});

describe('isPreviewableRoute', () => {
  it('accepts the edit forms', () => {
    expect(isPreviewableRoute('POST', '/api/devices/7/vlans')).toBe(true);
    expect(isPreviewableRoute('PUT', '/api/devices/7/vlans/12')).toBe(true);
    expect(isPreviewableRoute('PUT', '/api/devices/7/ports/ether1/vlan')).toBe(true);
    expect(isPreviewableRoute('POST', '/api/devices/7/firewall')).toBe(true);
    expect(isPreviewableRoute('POST', '/api/devices/7/routing/ospf/area')).toBe(true);
    expect(isPreviewableRoute('PUT', '/api/network-services/dns?deviceId=7')).toBe(true);
    expect(isPreviewableRoute('POST', '/api/network-services/dhcp/static-lease?deviceId=7')).toBe(true);
    expect(isPreviewableRoute('PUT', '/api/wireless/7/interfaces/wifi1')).toBe(true);
  });
  it('refuses actions and anything outside the list', () => {
    expect(isPreviewableRoute('POST', '/api/devices/7/reboot')).toBe(false);
    expect(isPreviewableRoute('POST', '/api/devices/7/firewall/reset-counters')).toBe(false);
    expect(isPreviewableRoute('POST', '/api/network-services/dns/flush?deviceId=7')).toBe(false);
    expect(isPreviewableRoute('POST', '/api/devices/7/tools/capture')).toBe(false);
    expect(isPreviewableRoute('POST', '/api/devices/7/ssh-key')).toBe(false);
    expect(isPreviewableRoute('PUT', '/api/devices/7')).toBe(false);
    expect(isPreviewableRoute('GET', '/api/devices/7/vlans')).toBe(false);
  });
});

describe('isDbWrite', () => {
  it('lets reads through and catches writes', () => {
    expect(isDbWrite('SELECT * FROM devices WHERE id = $1')).toBe(false);
    expect(isDbWrite('  -- note\n select 1')).toBe(false);
    expect(isDbWrite('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
    expect(isDbWrite('INSERT INTO vlans VALUES ($1)')).toBe(true);
    expect(isDbWrite('UPDATE devices SET name=$1')).toBe(true);
    expect(isDbWrite('DELETE FROM vlans WHERE id=$1')).toBe(true);
    expect(isDbWrite('WITH d AS (DELETE FROM x RETURNING *) SELECT * FROM d')).toBe(true);
    expect(isDbWrite('/* c */ TRUNCATE x')).toBe(true);
  });
});

describe('wire form and trimming', () => {
  it('joins list values the way the client sends them', () => {
    const s = describeWrite('h', '/ip/dns/set', { servers: ['1.1.1.1', '9.9.9.9'] as unknown as string }, { servers: '1.1.1.1' });
    expect(s.cli).toBe('/ip dns set servers=1.1.1.1,9.9.9.9');
    expect(s.changes[0]).toEqual({ field: 'servers', from: '1.1.1.1', to: '1.1.1.1,9.9.9.9' });
  });
  it('drops counters from the item shown', () => {
    const s = describeWrite('h', '/interface/remove', { '.id': '*9' },
      { '.id': '*9', name: 'vlan9', mtu: '1500', 'rx-byte': '9', 'tx-packet': '1', running: 'true', 'last-link-up-time': 'x', 'fp-rx-byte': '1' });
    expect(s.target).toEqual({ '.id': '*9', name: 'vlan9', mtu: '1500' });
  });
});

describe('untrusted keys', () => {
  it('drops prototype keys rather than writing them', () => {
    const params = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": "x", "name": "vlan9"}');
    const s = describeWrite('h', '/interface/vlan/add', params, null);
    expect(s.params).toEqual({ name: 'vlan9' });
    expect(Object.getPrototypeOf(s.params)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(s.cli).toBe('/interface vlan add name=vlan9');
  });
});
