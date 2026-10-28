// Mock external deps before importing DeviceCollector
jest.mock('../../../utils/crypto', () => ({ decrypt: (s: string) => s }));
// The client is mocked; how its errors are told apart is real.
jest.mock('../RouterOSClient', () => {
  const actual = jest.requireActual('../RouterOSClient');
  return {
    ...jest.createMockFromModule<Record<string, unknown>>('../RouterOSClient'),
    RouterOSError: actual.RouterOSError,
    RouterOSTrapError: actual.RouterOSTrapError,
    isNoSuchCommand: actual.isNoSuchCommand,
  };
});
import { RouterOSTrapError, isNoSuchCommand } from '../RouterOSClient';
jest.mock('../../../config/database');
jest.mock('../../../config/influxdb');
jest.mock('../../../utils/oui');
jest.mock('../../../utils/serverArp');

import { DeviceCollector, DeviceRow } from '../DeviceCollector';
import { query } from '../../../config/database';
import { isPartialApply } from '../../changeGuard/partialApply';

const testDevice: DeviceRow = {
  id: 1,
  name: 'test-router',
  ip_address: '192.168.1.1',
  api_port: 8728,
  api_username: 'admin',
  api_password_encrypted: 'plaintext-password',
  device_type: 'router',
  status: 'online',
};

// ── parseUptime ───────────────────────────────────────────────────────────────

describe('parseUptime', () => {
  let collector: DeviceCollector;

  beforeEach(() => {
    collector = new DeviceCollector(testDevice);
  });

  function parse(uptime: string): number {
    // Access private method for unit testing
    return (collector as unknown as Record<string, (s: string) => number>).parseUptime(uptime);
  }

  it('parses a full uptime string (1w2d3h4m5s)', () => {
    // 1w=604800, 2d=172800, 3h=10800, 4m=240, 5s=5 → 788645
    expect(parse('1w2d3h4m5s')).toBe(788645);
  });

  it('parses weeks only', () => {
    expect(parse('2w')).toBe(2 * 604800);
  });

  it('parses days only', () => {
    expect(parse('3d')).toBe(3 * 86400);
  });

  it('parses hours and minutes', () => {
    expect(parse('5h30m')).toBe(5 * 3600 + 30 * 60);
  });

  it('parses seconds only', () => {
    expect(parse('45s')).toBe(45);
  });

  it('returns 0 for an empty string', () => {
    expect(parse('')).toBe(0);
  });

  it('returns 0 for zero-second uptime (0s)', () => {
    expect(parse('0s')).toBe(0);
  });
});

// ── installRouterboardUpgrade (#141) ────────────────────────────────────────

describe('installRouterboardUpgrade', () => {
  const withExecute = (impl: (path: string) => Promise<unknown>) => {
    const collector = new DeviceCollector(testDevice);
    const execute = jest.fn(impl);
    (collector as unknown as { client: { execute: jest.Mock } }).client.execute = execute;
    return { collector, execute };
  };

  it('treats the reboot dropping the connection as expected, not a failed upgrade', async () => {
    // The reported case: the socket closed before RouterOS acknowledged the reboot.
    const { collector, execute } = withExecute((path) =>
      path === '/system/reboot' ? Promise.reject(new Error('Connection closed')) : Promise.resolve([]));
    await expect(collector.installRouterboardUpgrade()).resolves.toBeUndefined();
    expect(execute.mock.calls.map((c) => c[0])).toEqual(['/system/routerboard/upgrade', '/system/reboot']);
  });

  it('still fails when the upgrade itself is refused', async () => {
    const { collector } = withExecute((path) =>
      path === '/system/routerboard/upgrade' ? Promise.reject(new Error('failure: not allowed')) : Promise.resolve([]));
    await expect(collector.installRouterboardUpgrade()).rejects.toThrow('not allowed');
  });
});

// ── collectSystemInfo: name vs. router identity ─────────────────────────────
//
// Regression test for a device's "+ Add Device" name getting silently
// clobbered by RouterOS's own /system/identity on the very first poll.
// The decision now lives entirely in device.name_locked (set at creation by
// deviceCreation.ts, and on every rename by PUT /devices/:id) rather than a
// heuristic here — collectSystemInfo just obeys the flag.

describe('collectSystemInfo', () => {
  const resourceRow = [{ version: '7.15 (stable)' }];
  const routerboardRow = [{ model: 'CCR2004', 'serial-number': 'ABC123', 'current-firmware': '7.15' }];
  const clockRow = [{ 'time-zone-name': 'UTC', 'gmt-offset': '0' }];

  function mockExecute(identityName: string): jest.Mock {
    const responses: Record<string, Record<string, string>[]> = {
      '/system/identity/print': [{ name: identityName }],
      '/system/resource/print': resourceRow,
      '/system/routerboard/print': routerboardRow,
      '/system/clock/print': clockRow,
    };
    return jest.fn((path: string) => Promise.resolve(responses[path] ?? []));
  }

  async function collectedName(device: DeviceRow, identityName: string): Promise<string> {
    const collector = new DeviceCollector(device);
    (collector as unknown as { client: { execute: jest.Mock } }).client.execute = mockExecute(identityName);
    await collector.collectSystemInfo();
    const [, params] = (query as jest.Mock).mock.calls[0];
    return params[0];
  }

  beforeEach(() => {
    (query as jest.Mock).mockClear();
  });

  it("adopts the router's identity when unlocked, even for the address placeholder", async () => {
    // CSV import / Try All default an un-named device's name to its address,
    // and those rows start unlocked — that placeholder should be replaced by
    // something more useful once known.
    const device: DeviceRow = { ...testDevice, name: testDevice.ip_address, name_locked: false };
    expect(await collectedName(device, 'Core-Switch')).toBe('Core-Switch');
  });

  it('adopts the router\'s identity when unlocked, even for a name that looks deliberate', async () => {
    // The deciding factor is the flag, not what the name happens to look
    // like — an unlocked row always follows, address-shaped or not.
    const device: DeviceRow = { ...testDevice, name: 'aaa', name_locked: false };
    expect(await collectedName(device, 'Core-Switch')).toBe('Core-Switch');
  });

  it("never overwrites a name the operator actually typed, even with RouterOS's un-customized factory identity", async () => {
    const device: DeviceRow = { ...testDevice, name: 'aaa', name_locked: true };
    // RouterOS ships with this as the un-customized default identity.
    expect(await collectedName(device, 'MikroTik')).toBe('aaa');
  });

  it('never overwrites a locked name even if it happens to equal the address', async () => {
    // Legacy data (locked before a later address change) shouldn't fall back
    // to the placeholder heuristic — the flag wins outright.
    const device: DeviceRow = { ...testDevice, name: testDevice.ip_address, name_locked: true };
    expect(await collectedName(device, 'Core-Switch')).toBe(testDevice.ip_address);
  });

  it("stores the router's identity even while the name is locked, so a mismatch can be shown (#253)", async () => {
    const collector = new DeviceCollector({ ...testDevice, name: 'Office router', name_locked: true });
    (collector as unknown as { client: { execute: jest.Mock } }).client.execute = mockExecute('MikroTik');
    await collector.collectSystemInfo();
    const [sql, params] = (query as jest.Mock).mock.calls[0];
    expect(sql).toContain('ros_identity = COALESCE($11, ros_identity)');
    expect(params[0]).toBe('Office router');
    expect(params[10]).toBe('MikroTik');
  });
});

// ── setSnmpConfig: fleet changes touch only what was chosen (P1-11, P2-13) ──

describe('setSnmpConfig', () => {
  function collectorWith(communities: Record<string, string>[]) {
    const collector = new DeviceCollector(testDevice);
    const calls: { cmd: string; params: Record<string, string> }[] = [];
    (collector as unknown as { client: { execute: jest.Mock } }).client = {
      execute: jest.fn(async (cmd: string, params: Record<string, string> = {}) => {
        calls.push({ cmd, params });
        return cmd === '/snmp/community/print' ? communities : [];
      }),
    };
    return { collector, calls };
  }

  it('writes only the fields given', async () => {
    const { collector, calls } = collectorWith([{ '.id': '*1', name: 'public' }]);
    await collector.setSnmpConfig({ trap_target: '10.0.0.5' });
    expect(calls).toEqual([{ cmd: '/snmp/set', params: { 'trap-target': '10.0.0.5' } }]);
  });

  it('adds a community that does not exist instead of renaming the first one', async () => {
    const { collector, calls } = collectorWith([{ '.id': '*1', name: 'public' }]);
    await collector.setSnmpConfig({ community_name: 'monitoring', version: 'v2c' });
    expect(calls.some((c) => c.cmd === '/snmp/community/set')).toBe(false);
    expect(calls).toContainEqual({ cmd: '/snmp/community/add', params: { name: 'monitoring', security: 'none' } });
  });

  it('keeps an encrypted SNMPv3 user encrypted when the privacy password is left blank', async () => {
    const { collector, calls } = collectorWith([{ '.id': '*2', name: 'nms' }]);
    await collector.setSnmpConfig({ community_name: 'nms', version: 'v3', auth_protocol: 'SHA1', priv_protocol: 'AES' });
    const set = calls.find((c) => c.cmd === '/snmp/community/set');
    expect(set?.params.security).toBe('private');
    expect(set?.params['encryption-password']).toBeUndefined();
  });

  it('never switches SNMP on or off unless asked', async () => {
    const { collector, calls } = collectorWith([]);
    await collector.setSnmpConfig({ contact: 'noc@example.com' });
    expect(calls[0].params.enabled).toBeUndefined();
  });
});

// ── Edits change only what was asked, and clearing clears (P2-10, P2-11, P2-14) ──

function collectorOn(responses: Record<string, Record<string, string>[]>) {
  const collector = new DeviceCollector(testDevice);
  const calls: { cmd: string; params: Record<string, string> }[] = [];
  (collector as unknown as { client: { execute: jest.Mock } }).client = {
    execute: jest.fn(async (cmd: string, params: Record<string, string> = {}) => {
      calls.push({ cmd, params });
      return responses[cmd] ?? [];
    }),
  };
  return { collector, calls };
}

describe('updating an item (setItem)', () => {
  it('unsets a cleared matcher instead of dropping it', async () => {
    const { collector, calls } = collectorOn({
      '/ip/firewall/filter/print': [{ '.id': '*5', 'src-address': '10.0.0.0/8', 'dst-port': '22' }],
    });
    await collector.updateFirewallRule('*5', { action: 'accept', 'src-address': '', 'dst-port': '' });
    expect(calls).toContainEqual({ cmd: '/ip/firewall/filter/set', params: { action: 'accept', '.id': '*5' } });
    expect(calls).toContainEqual({ cmd: '/ip/firewall/filter/unset', params: { numbers: '*5', 'value-name': 'src-address' } });
    expect(calls).toContainEqual({ cmd: '/ip/firewall/filter/unset', params: { numbers: '*5', 'value-name': 'dst-port' } });
  });

  it('does not unset what is already clear', async () => {
    const { collector, calls } = collectorOn({ '/ip/firewall/nat/print': [{ '.id': '*2' }] });
    await collector.updateNatRule('*2', { 'to-ports': '' });
    expect(calls.some((c) => c.cmd.endsWith('/unset'))).toBe(false);
  });

  it('ignores names that are not RouterOS properties', async () => {
    const { collector, calls } = collectorOn({});
    await collector.updateNatRule('*2', { __proto__: 'x', 'Bad Name': 'y', comment: 'ok' } as unknown as Record<string, string>);
    expect(calls).toEqual([{ cmd: '/ip/firewall/nat/set', params: { comment: 'ok', '.id': '*2' } }]);
  });

  it('always writes to the item in the URL, never an id from the body', async () => {
    const { collector, calls } = collectorOn({});
    await collector.updateNatRule('*2', { '.id': '*99', numbers: '*98', comment: 'x' });
    expect(calls[0]).toEqual({ cmd: '/ip/firewall/nat/set', params: { comment: 'x', '.id': '*2' } });
  });
});

describe('setNtpConfig on RouterOS 7', () => {
  it('changes the first two servers and keeps the rest', async () => {
    const { collector, calls } = collectorOn({
      '/system/ntp/client/print': [{ enabled: 'true', mode: 'unicast' }],
      '/system/ntp/client/servers/print': [
        { '.id': '*1', address: 'a.pool' }, { '.id': '*2', address: 'b.pool' }, { '.id': '*3', address: 'c.pool' },
      ],
    });
    await collector.setNtpConfig({ primary: 'x.pool' });
    const added = calls.filter((c) => c.cmd === '/system/ntp/client/servers/add').map((c) => c.params.address);
    expect(added).toEqual(['x.pool', 'b.pool', 'c.pool']);
    expect(calls.some((c) => c.cmd === '/system/ntp/client/set')).toBe(false);   // enabled not touched
  });

  it('does nothing to the servers when only enabled changes', async () => {
    const { collector, calls } = collectorOn({ '/system/ntp/client/print': [{ enabled: 'true' }] });
    await collector.setNtpConfig({ enabled: false });
    expect(calls).toContainEqual({ cmd: '/system/ntp/client/set', params: { enabled: 'no' } });
    expect(calls.some((c) => c.cmd.includes('/servers/'))).toBe(false);
  });
});

describe('setFlowControl', () => {
  it('changes only the direction given', async () => {
    const { collector, calls } = collectorOn({});
    await collector.setFlowControl('ether1', undefined, 'on');
    expect(calls).toEqual([{ cmd: '/interface/ethernet/set', params: { numbers: 'ether1', 'rx-flow-control': 'on' } }]);
  });
});

// ── Legacy wireless security (outside review P2-12) ─────────────────────────

describe('legacy wireless security', () => {
  const legacy = (responses: Record<string, Record<string, string>[]>, failures: Record<string, Error> = {}) => {
    const fail = new Map(Object.entries(failures));
    const { collector, calls } = collectorOn(responses);
    (collector as unknown as { wifiPackageCache: string }).wifiPackageCache = 'wireless';
    const exec = (collector as unknown as { client: { execute: jest.Mock } }).client.execute;
    const base = exec.getMockImplementation()!;
    exec.mockImplementation(async (cmd: string, params?: Record<string, string>) => {
      const err = fail.get(cmd);
      if (err) { calls.push({ cmd, params: params ?? {} }); throw err; }
      return base(cmd, params);
    });
    return { collector, calls };
  };
  const cmds = (calls: { cmd: string }[]) => calls.map((c) => c.cmd);

  it('creates the security profile first, then the SSID already pointing at it', async () => {
    const { collector, calls } = legacy({});
    await collector.addWirelessInterface({ name: 'wlan2', ssid: 'Office', passphrase: 'correct-horse', 'authentication-types': 'wpa2-psk' });
    const add = calls.find((c) => c.cmd === '/interface/wireless/security-profiles/add')!;
    expect(add.params).toMatchObject({ name: 'mtm-wlan2', mode: 'dynamic-keys', 'authentication-types': 'wpa2-psk', 'wpa2-pre-shared-key': 'correct-horse' });
    const iface = calls.find((c) => c.cmd === '/interface/wireless/add')!;
    expect(iface.params).toEqual({ name: 'wlan2', ssid: 'Office', 'security-profile': 'mtm-wlan2' });
    expect(cmds(calls).indexOf('/interface/wireless/security-profiles/add')).toBeLessThan(cmds(calls).indexOf('/interface/wireless/add'));
  });

  it('creates nothing when the network cannot be secured', async () => {
    const { collector, calls } = legacy({}, { '/interface/wireless/security-profiles/add': new Error('failure: not allowed') });
    await expect(collector.addWirelessInterface({ name: 'wlan2', ssid: 'Office', passphrase: 'correct-horse' })).rejects.toThrow('not allowed');
    expect(cmds(calls)).not.toContain('/interface/wireless/add');
  });

  it('refuses WPA3 rather than quietly downgrading it', async () => {
    const { collector, calls } = legacy({});
    await expect(collector.addWirelessInterface({ name: 'wlan2', ssid: 'Office', passphrase: 'correct-horse', 'authentication-types': 'wpa3-psk' }))
      .rejects.toThrow(/only wpa-psk and wpa2-psk/);
    expect(cmds(calls)).not.toContain('/interface/wireless/add');
  });

  it('removes the profile again if the SSID itself is refused', async () => {
    const { collector, calls } = legacy(
      { '/interface/wireless/security-profiles/print': [{ '.id': '*9', name: 'mtm-wlan2' }] },
      { '/interface/wireless/add': new Error('failure: bad master') });
    await expect(collector.addWirelessInterface({ name: 'wlan2', ssid: 'Office', passphrase: 'correct-horse' })).rejects.toThrow('bad master');
    expect(calls).toContainEqual({ cmd: '/interface/wireless/security-profiles/remove', params: { '.id': '*9' } });
  });

  it('applies a new passphrase through the interface\'s own profile, never a shared one', async () => {
    const { collector, calls } = legacy({});
    await collector.setWirelessInterface('wlan1', { passphrase: 'new-passphrase' });
    expect(calls.find((c) => c.cmd === '/interface/wireless/security-profiles/add')?.params.name).toBe('mtm-wlan1');
    expect(calls).toContainEqual({ cmd: '/interface/wireless/set', params: { '.id': 'wlan1', 'security-profile': 'mtm-wlan1' } });
    expect(cmds(calls)).not.toContain('/interface/wireless/security-profiles/set');
  });

  it("won't take over another SSID that only shares the guest network's name", async () => {
    const { collector, calls } = legacy({
      '/interface/wireless/print': [
        { name: 'wlan1' },
        { name: 'wlan3', 'master-interface': 'wlan1', ssid: 'Guest' }, // someone else's
      ],
    });
    await expect(collector.setupGuestNetwork({
      name: 'guest', gatewayCidr: '10.5.50.1/24', poolRange: '10.5.50.10-10.5.50.254', ssid: { ssid: 'Guest', passphrase: 'correct-horse' },
    })).rejects.toThrow(/already exists on wlan3/);
    expect(cmds(calls).some((c) => c.endsWith('/add') || c.endsWith('/set'))).toBe(false);
  });

  it('tags the SSIDs it creates so a rerun knows them', async () => {
    const { collector, calls } = legacy({ '/interface/wireless/print': [{ name: 'wlan1' }] });
    await collector.setupGuestNetwork({
      name: 'guest', gatewayCidr: '10.5.50.1/24', poolRange: '10.5.50.10-10.5.50.254', ssid: { ssid: 'Guest', passphrase: 'correct-horse' },
    }).catch(() => { /* the hotspot steps after it don't matter here */ });
    const iface = calls.find((c) => c.cmd === '/interface/wireless/add')!;
    expect(iface.params).toMatchObject({ ssid: 'Guest', comment: 'mtm-guest:guest', 'security-profile': iface.params.name ? `mtm-${iface.params.name}` : '' });
  });
});

// ── Legacy CAPsMAN (#250) ────────────────────────────────────────────────────

import { legacyFixture } from '../__fixtures__/legacyCapsman';

describe('legacy CAPsMAN (#250)', () => {
  const noMenu = () => { throw Object.create(RouterOSTrapError.prototype, { message: { value: 'no such command' } }); };
  const on = (responses: Record<string, Record<string, string>[] | (() => never)>, device: Partial<DeviceRow> = {}) => {
    const collector = new DeviceCollector({ ...testDevice, ...device } as DeviceRow);
    const calls: { cmd: string; params: Record<string, string> }[] = [];
    (collector as unknown as { client: { execute: jest.Mock } }).client = {
      execute: jest.fn(async (cmd: string, params: Record<string, string> = {}) => {
        calls.push({ cmd, params });
        const r = responses[cmd];
        if (typeof r === 'function') return r();
        return r ?? [];
      }),
    };
    return { collector, calls };
  };

  beforeEach(() => { (query as jest.Mock).mockReset(); (query as jest.Mock).mockResolvedValue([]); });

  it('classifies a CHR running legacy CAPsMAN as a controller, even with the wifi menu present', async () => {
    const { collector } = on({ '/interface/wifi/print': [], '/caps-man/manager/print': legacyFixture.manager });
    expect(await collector.detectWifiRole()).toBe('controller');
    expect((collector as unknown as { capsmanFlavor: string }).capsmanFlavor).toBe('legacy');
  });

  it('classifies an RB951 handing wlan1 to a legacy controller as a CAP', async () => {
    const { collector } = on({
      '/interface/wifi/print': noMenu, '/interface/wireless/print': [{ name: 'wlan1' }],
      '/caps-man/manager/print': [{ enabled: 'false' }], '/interface/wireless/cap/print': legacyFixture.cap,
    });
    expect(await collector.detectWifiRole()).toBe('cap');
    expect((collector as unknown as { legacyCapIfaces: string[] }).legacyCapIfaces).toEqual(['wlan1']);
  });

  it('still calls a plain legacy-wireless AP standalone', async () => {
    const { collector } = on({
      '/interface/wifi/print': noMenu, '/interface/wireless/print': [{ name: 'wlan1' }],
      '/caps-man/manager/print': [{ enabled: 'false' }], '/interface/wireless/cap/print': [{ enabled: 'false' }],
    });
    expect(await collector.detectWifiRole()).toBe('standalone');
  });

  it('leaves the newer CAPsMAN alone', async () => {
    const { collector } = on({
      '/interface/wifi/print': [{ name: 'wifi1' }], '/interface/wifi/capsman/print': [{ enabled: 'true' }],
      '/caps-man/manager/print': noMenu,
    });
    expect(await collector.detectWifiRole()).toBe('controller');
    expect((collector as unknown as { capsmanFlavor: string }).capsmanFlavor).toBe('wifi');
  });

  it('stores the radio against the RB951 by MAC, with its SSID, channel and clients', async () => {
    const { collector } = on({
      '/interface/wifi/print': [], '/caps-man/manager/print': legacyFixture.manager,
      '/caps-man/interface/print': legacyFixture.interface, '/caps-man/remote-cap/print': legacyFixture.remoteCap,
      '/caps-man/registration-table/print': legacyFixture.registrations,
    });
    (query as jest.Mock).mockImplementation(async (sql: string) =>
      sql.includes('FROM interfaces WHERE mac_address') ? [{ device_id: 42, mac_address: 'D4:CA:6D:BB:0E:57' }, { device_id: 1, mac_address: '00:0C:29:00:00:01' }] : []);
    await collector.collectCapsman();
    const insert = (query as jest.Mock).mock.calls.find(([sql]) => String(sql).includes('INSERT INTO capsman_radios'));
    expect(insert).toBeDefined();
    const p = insert![1];
    expect(p.slice(0, 6)).toEqual([1, 'D4:CA:6D:BB:0E:57', 'BonusRoom 2.4Ghz', '2412/20/gn', 'BonusRoom', 42]);
    expect(p.slice(7)).toEqual(['running-ap', 3, 3, 30, 'Laney Legacy']);
  });

  it('reads both when a CHR runs the newer and the legacy CAPsMAN together', async () => {
    const both = {
      '/interface/wifi/print': [], '/interface/wifi/capsman/print': [{ enabled: 'true' }],
      '/interface/wifi/radio/print': [{ 'radio-mac': '48:A9:8A:00:00:01', interface: 'cap-wifi1', local: 'false' }],
      '/interface/wifi/provisioning/print': [{ '.id': '*1', action: 'create-enabled' }],
      '/caps-man/manager/print': legacyFixture.manager,
      '/caps-man/interface/print': legacyFixture.interface, '/caps-man/remote-cap/print': legacyFixture.remoteCap,
      '/caps-man/registration-table/print': legacyFixture.registrations,
      '/caps-man/provisioning/print': [{ '.id': '*1', action: 'create-dynamic-enabled' }],
    };
    const { collector } = on(both);
    expect(await collector.detectWifiRole()).toBe('controller');
    expect((collector as unknown as { capsmanFlavor: string }).capsmanFlavor).toBe('both');
    await collector.collectCapsman();
    const calls = (query as jest.Mock).mock.calls;
    const radioMacs = calls.filter(([sql]) => String(sql).includes('INSERT INTO capsman_radios')).map(([, p]) => p[1]);
    expect(radioMacs.sort()).toEqual(['48:A9:8A:00:00:01', 'D4:CA:6D:BB:0E:57']);
    // One removal, against both lists — not one per CAPsMAN deleting the other's.
    const prunes = calls.filter(([sql]) => String(sql).includes('DELETE FROM capsman_radios'));
    expect(prunes).toHaveLength(1);
    expect([...prunes[0][1][1]].sort()).toEqual(['48:A9:8A:00:00:01', 'D4:CA:6D:BB:0E:57']);
    // Rule ids restart at *1 in each tree.
    const provIds = calls.filter(([sql]) => String(sql).includes('INSERT INTO capsman_provisioning')).map(([, p]) => p[1]);
    expect(provIds.sort()).toEqual(['*1', 'legacy:*1']);
  });

  it('removes nothing when one of the two could not be read', async () => {
    const { collector } = on({
      '/interface/wifi/print': [], '/interface/wifi/capsman/print': [{ enabled: 'true' }],
      '/interface/wifi/radio/print': [{ 'radio-mac': '48:A9:8A:00:00:01', interface: 'cap-wifi1', local: 'false' }],
      '/caps-man/manager/print': legacyFixture.manager,
      '/caps-man/interface/print': () => { throw new Error('timeout'); },
    });
    await collector.collectCapsman();
    expect((query as jest.Mock).mock.calls.some(([sql]) => String(sql).includes('DELETE FROM capsman_radios'))).toBe(false);
  });

  it("lists the controller's clients, named by their registration comment", async () => {
    const { collector, calls } = on({
      '/interface/wifi/print': [], '/caps-man/registration-table/print': legacyFixture.registrations,
    }, { capsman_flavor: 'legacy' } as Partial<DeviceRow>);
    await collector.updateClients();
    expect(calls.find((c) => c.cmd === '/caps-man/registration-table/print')?.params).toEqual({ stats: '' });
    const inserts = (query as jest.Mock).mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO clients'));
    const iphone = inserts.find(([, params]) => params[1] === '38:9c:b2:3d:9b:19');
    expect(iphone).toBeDefined();
    expect(iphone![1][2]).toBe("Matt's iPhone 15");      // hostname
    expect(iphone![1][4]).toBe('BonusRoom 2.4Ghz');       // interface
    expect(iphone![1][8]).toBeNull();                     // no signal without stats
  });

  it('takes signal, address and traffic from the stats the reporter sent', async () => {
    const { collector } = on({
      '/interface/wifi/print': [], '/caps-man/registration-table/print': legacyFixture.registrationsStats,
    }, { capsman_flavor: 'legacy' } as Partial<DeviceRow>);
    await collector.updateClients();
    const inserts = (query as jest.Mock).mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO clients'));
    const fireTv = inserts.find(([, params]) => params[1] === '9c:c8:e9:53:ba:f0')![1];
    expect(fireTv[2]).toBe('BonusRoom FireTV Stick 4k Max');
    expect(fireTv[3]).toBe('110.87.22.10');               // last-ip: the CHR isn't the DHCP server
    expect(fireTv[6]).toBe(150684303);                    // tx: what the AP sent the streaming stick
    expect(fireTv[7]).toBe(19365193);                     // rx
    expect(fireTv[8]).toBe(-70);
    expect(fireTv[10]).toBe(130_000_000);                 // tx rate "130Mbps-20MHz/2S" (#252)
    expect(fireTv[11]).toBe(1_000_000);                   // rx rate "1Mbps"
  });
});

// ── Bonds: only a failure after a write is a partial apply ─────────────────────

describe('bond create/remove failures', () => {
  // A !trap: the device answered and refused, so nothing was written.
  const trap = (message: string) => Object.create(RouterOSTrapError.prototype, { message: { value: message } }) as Error;
  /** A collector whose `failOn` command rejects with `error`; the rest answer from `responses`. */
  function bondCollector(
    responses: Record<string, Record<string, string>[]>, failOn: string, error: string | Error = trap('failure: already have interface with such name'),
  ) {
    const collector = new DeviceCollector(testDevice);
    const calls: string[] = [];
    (collector as unknown as { client: { execute: jest.Mock } }).client = {
      execute: jest.fn(async (cmd: string) => {
        calls.push(cmd);
        if (cmd === failOn) throw typeof error === 'string' ? new Error(error) : error;
        return responses[cmd] ?? [];
      }),
    };
    return { collector, calls };
  }
  const bridged = { '/interface/bridge/port/print': [{ '.id': '*1', interface: 'ether2', bridge: 'bridge' }] };
  const bond = { '/interface/bonding/print': [{ '.id': '*b', name: 'bond1', slaves: 'ether2,ether3' }] };

  it('create: a rejection before anything was written is a plain failure', async () => {
    const { collector } = bondCollector({}, '/interface/bonding/add');
    const err = await collector.createBond('bond1', ['ether2', 'ether3'], '802.3ad', {}).catch((e) => e);
    expect(isPartialApply(err)).toBe(false);
    expect((err as Error).message).toMatch(/already have/);
  });

  it('create: a rejected first port removal is a plain failure', async () => {
    const { collector } = bondCollector(bridged, '/interface/bridge/port/remove');
    const err = await collector.createBond('bond1', ['ether2'], '802.3ad', {}).catch((e) => e);
    expect(isPartialApply(err)).toBe(false);
  });

  it('create: a failure after the slaves left the bridge is partial', async () => {
    const { collector } = bondCollector(bridged, '/interface/bonding/add');
    const err = await collector.createBond('bond1', ['ether2'], '802.3ad', {}).catch((e) => e);
    expect(isPartialApply(err)).toBe(true);
  });

  it('create: a lost reply on the first write is partial (it may have landed)', async () => {
    const { collector } = bondCollector({}, '/interface/bonding/add', 'Read timeout waiting for API response');
    const err = await collector.createBond('bond1', ['ether2'], '802.3ad', {}).catch((e) => e);
    expect(isPartialApply(err)).toBe(true);
  });

  it('remove: a rejected bridge-port removal is a plain failure', async () => {
    const { collector } = bondCollector({ ...bond, ...bridged }, '/interface/bridge/port/remove');
    const err = await collector.deleteBond('bond1').catch((e) => e);
    expect(isPartialApply(err)).toBe(false);
  });

  it('remove: an unbridged bond whose removal is rejected is a plain failure', async () => {
    const { collector } = bondCollector(bond, '/interface/bonding/remove');
    const err = await collector.deleteBond('bond1').catch((e) => e);
    expect(isPartialApply(err)).toBe(false);
  });

  it('remove: a rejection after the bond left the bridge is partial', async () => {
    const { collector } = bondCollector({ ...bond, ...bridged }, '/interface/bonding/remove');
    const err = await collector.deleteBond('bond1').catch((e) => e);
    expect(isPartialApply(err)).toBe(true);
  });
});

// ── disconnectWirelessClient (#338) ───────────────────────────────────────────

describe('disconnectWirelessClient', () => {
  function withTables(tables: Record<string, Record<string, string>[] | null>) {
    const collector = new DeviceCollector(testDevice);
    const removed: Array<[string, string]> = [];
    const execute = jest.fn(async (cmd: string, params?: Record<string, string>) => {
      const menu = cmd.replace(/\/(print|remove)$/, '');
      if (cmd.endsWith('/print')) {
        const rows = tables[menu];
        if (rows === null || rows === undefined) throw new Error('no such command prefix');
        return rows;
      }
      removed.push([menu, params?.['.id'] ?? '']);
      return [];
    });
    (collector as unknown as { client: { execute: typeof execute } }).client = { execute };
    return { collector, removed };
  }

  it('removes the matching entry from the wifi package table, case-insensitively', async () => {
    const { collector, removed } = withTables({
      '/interface/wifi/registration-table': [
        { '.id': '*A', 'mac-address': 'AA:BB:CC:00:11:22' },
        { '.id': '*B', 'mac-address': 'AA:BB:CC:00:11:33' },
      ],
      '/interface/wireless/registration-table': null,
      '/caps-man/registration-table': null,
    });
    expect(await collector.disconnectWirelessClient('aa:bb:cc:00:11:22')).toBe(1);
    expect(removed).toEqual([['/interface/wifi/registration-table', '*A']]);
  });

  it('covers legacy wireless and a legacy CAPsMAN controller, every matching entry', async () => {
    const { collector, removed } = withTables({
      '/interface/wifi/registration-table': null,
      '/interface/wireless/registration-table': [{ '.id': '*1', 'mac-address': 'AA:BB:CC:00:11:22' }],
      '/caps-man/registration-table': [
        { '.id': '*7', 'mac-address': 'aa:bb:cc:00:11:22' },
        { '.id': '*8', 'mac-address': 'AA:BB:CC:00:11:99' },
      ],
    });
    expect(await collector.disconnectWirelessClient('aa:bb:cc:00:11:22')).toBe(2);
    expect(removed).toEqual([['/interface/wireless/registration-table', '*1'], ['/caps-man/registration-table', '*7']]);
  });

  it('returns 0 and removes nothing when the client is not registered', async () => {
    const { collector, removed } = withTables({
      '/interface/wifi/registration-table': [{ '.id': '*A', 'mac-address': 'AA:BB:CC:00:11:33' }],
      '/interface/wireless/registration-table': null,
      '/caps-man/registration-table': null,
    });
    expect(await collector.disconnectWirelessClient('aa:bb:cc:00:11:22')).toBe(0);
    expect(removed).toEqual([]);
  });
});

// ── legacy wireless scan: privacy flag via a script (#295) ────────────────────

describe('scanWireless on the legacy package (#295)', () => {
  const apiRows = [{ '.section': '0', address: 'A4:16:E7:92:06:78', channel: '2412/20-Ce/gn', ssid: 'Home', sig: '-83', nf: '-101', snr: '18' }];
  const scriptOut = 'A4:16:E7:92:06:78|true|-83|-101|18|2412/20-Ce/gn|Home\r\n';

  function make(id: number, opts: { api?: Record<string, string>[]; script?: () => Promise<string> }) {
    const c = new DeviceCollector({ ...testDevice, id });
    (c as unknown as { detectWifiPackage: () => Promise<string> }).detectWifiPackage = async () => 'wireless';
    const client = {
      executeStreaming: jest.fn(async () => opts.api ?? apiRows),
      runScript: jest.fn(opts.script ?? (async () => scriptOut)),
    };
    (c as unknown as { client: typeof client }).client = client;
    return { c, client };
  }

  it('runs the scan as a script when the API reply has no privacy flag, then goes straight to the script', async () => {
    const first = make(9101, {});
    const rows = await first.c.scanWireless('wlan1', 5_000);
    expect(rows[0]).toMatchObject({ address: 'A4:16:E7:92:06:78', privacy: 'true' });
    expect(first.client.executeStreaming).toHaveBeenCalledTimes(1);
    expect(first.client.runScript).toHaveBeenCalledTimes(1);

    const second = make(9101, {});
    await second.c.scanWireless('wlan1', 5_000);
    expect(second.client.executeStreaming).not.toHaveBeenCalled();
    expect(second.client.runScript).toHaveBeenCalledTimes(1);
  });

  it('keeps the API rows, and stops trying the script, when the script fails', async () => {
    const first = make(9102, { script: async () => { throw new Error('no such command'); } });
    expect(await first.c.scanWireless('wlan1', 5_000)).toEqual(apiRows);
    const second = make(9102, {});
    expect(await second.c.scanWireless('wlan1', 5_000)).toEqual(apiRows);
    expect(second.client.runScript).not.toHaveBeenCalled();
  });

  it('never runs the script when the API reply already has the privacy flag', async () => {
    const withPrivacy = [{ ...apiRows[0], privacy: 'true' }];
    const { c, client } = make(9103, { api: withPrivacy });
    expect(await c.scanWireless('wlan1', 5_000)).toEqual(withPrivacy);
    expect(client.runScript).not.toHaveBeenCalled();
  });
});

// ── collectStp: a bond's role reaches its members' links (#363) ───────────────

describe('collectStp with a bonded root port (#363)', () => {
  it('marks the links stored under the bond members', async () => {
    const c = new DeviceCollector({ ...testDevice, id: 9201 });
    const execute = jest.fn(async (cmd: string) => {
      if (cmd === '/interface/bridge/print') return [{ name: 'bridge' }];
      if (cmd === '/interface/bridge/port/print') return [{ '.id': '*1', interface: 'Po1', bridge: 'bridge', role: 'root-port' }];
      return [];
    });
    (c as unknown as { client: { execute: typeof execute } }).client = { execute };
    const q = query as jest.Mock;
    q.mockReset();
    q.mockImplementation(async (sql: string) =>
      /type = 'bond'/.test(sql) ? [{ name: 'Po1', slaves: 'sfp-sfpplus1,sfp-sfpplus2' }] : []);
    await c.collectStp();
    const update = q.mock.calls.find(([sql]) => /UPDATE topology_links/.test(sql) && /stp_role/.test(sql));
    expect(update).toBeDefined();
    expect(update![0]).toContain('from_interface = ANY($6::text[])');
    expect(update![1]).toEqual([9201, 'Po1', 'root', 'forwarding', 'bridge', ['sfp-sfpplus1', 'sfp-sfpplus2']]);
    q.mockReset();
  });
});

// ── Wireless role checked again (#365) ───────────────────────────────────────

describe('a device without a wireless role is checked again (#365)', () => {
  const trap = () => { throw Object.create(RouterOSTrapError.prototype, { message: { value: 'no such command' } }); };
  const timeout = () => { throw new Error('Timed out'); };
  const make = (device: Partial<DeviceRow> & Record<string, unknown>, responses: Record<string, Record<string, string>[] | (() => never)> = {}) => {
    const collector = new DeviceCollector({ ...testDevice, ...device } as DeviceRow);
    (collector as unknown as { client: { execute: jest.Mock } }).client = {
      execute: jest.fn(async (cmd: string) => {
        const r = responses[cmd];
        if (typeof r === 'function') return r();
        return r ?? [];
      }),
    };
    return collector;
  };
  const should = (c: DeviceCollector, recheck?: boolean) =>
    (c as unknown as { shouldCollectWireless: (r?: boolean) => boolean }).shouldCollectWireless(recheck);
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  beforeEach(() => { (query as jest.Mock).mockReset(); (query as jest.Mock).mockResolvedValue([]); });

  it('looks again after a day, and on a manual Sync, not on every poll', () => {
    const none = { wifi_role: 'none', wifi_role_probe: 4 };
    expect(should(make({ ...none, wifi_role_checked_at: hoursAgo(2) }))).toBe(false);
    expect(should(make({ ...none, wifi_role_checked_at: hoursAgo(2) }), true)).toBe(true);
    expect(should(make({ ...none, wifi_role_checked_at: hoursAgo(25) }))).toBe(true);
    // Recorded before the check was dated: looked at once more.
    expect(should(make({ ...none, wifi_role_checked_at: null }))).toBe(true);
    // A device with a role is read on every slow poll, as before.
    expect(should(make({ wifi_role: 'controller', wifi_role_probe: 4, wifi_role_checked_at: hoursAgo(1) }))).toBe(true);
  });

  it('finds CAPsMAN switched on since, and dates the check', async () => {
    const c = make({ wifi_role: 'none', wifi_role_probe: 4, wifi_role_checked_at: hoursAgo(30) }, {
      '/interface/wifi/print': [], '/interface/wireless/print': trap,
      '/interface/wifi/capsman/print': [{ enabled: 'yes' }], '/interface/wifi/cap/print': [{ enabled: 'no' }],
      '/caps-man/manager/print': trap,
    });
    await c.collectWirelessInterfaces();
    const update = (query as jest.Mock).mock.calls.find(([sql]) => String(sql).includes('UPDATE devices SET wifi_role'));
    expect(update![0]).toContain('wifi_role_checked_at = NOW()');
    expect(update![1].slice(0, 3)).toEqual([1, 'controller', 'wifi']);
  });

  it('records nothing when the wireless menus time out', async () => {
    // Both time out: not "no wireless".
    const both = make({ wifi_role: null }, { '/interface/wifi/print': timeout, '/interface/wireless/print': timeout });
    await both.collectWirelessInterfaces();
    // The wifi menu times out and the legacy one answers empty: not a router
    // with the legacy package and no radios.
    const wifiOnly = make({ wifi_role: null }, {
      '/interface/wifi/print': timeout, '/interface/wireless/print': [], '/caps-man/manager/print': trap,
    });
    await wifiOnly.collectWirelessInterfaces();
    expect((query as jest.Mock).mock.calls.filter(([sql]) => String(sql).includes('UPDATE devices SET wifi_role'))).toHaveLength(0);
    // A device that refuses both menus has no wireless, and that is recorded.
    const neither = make({ wifi_role: null }, { '/interface/wifi/print': trap, '/interface/wireless/print': trap });
    await neither.collectWirelessInterfaces();
    const update = (query as jest.Mock).mock.calls.find(([sql]) => String(sql).includes('UPDATE devices SET wifi_role'));
    expect(update![1].slice(0, 3)).toEqual([1, 'none', 'none']);
  });
});

describe('a recorded wireless role isn\'t dropped on one bad read (#365)', () => {
  const missing = () => { throw new RouterOSTrapError('no such command or directory (caps-man)', '0'); };
  const interrupted = () => { throw new RouterOSTrapError('interrupted', '2'); };
  const make = (device: Partial<DeviceRow> & Record<string, unknown>, responses: Record<string, Record<string, string>[] | (() => never)>) => {
    const collector = new DeviceCollector({ ...testDevice, ...device } as DeviceRow);
    (collector as unknown as { client: { execute: jest.Mock } }).client = {
      execute: jest.fn(async (cmd: string) => {
        const r = responses[cmd];
        if (typeof r === 'function') return r();
        return r ?? [];
      }),
    };
    return collector;
  };
  const sql = (text: string) => (query as jest.Mock).mock.calls.filter(([s]) => String(s).includes(text));
  // An RB5009 on RouterOS 7.25: the wifi menu with no radios, no legacy package.
  const rb5009 = (capsman: Record<string, string>[] | (() => never)) => ({
    '/interface/wifi/print': [], '/interface/wireless/print': missing,
    '/interface/wifi/capsman/print': capsman, '/interface/wifi/cap/print': [{ enabled: 'no' }],
    '/caps-man/manager/print': missing,
  });
  const controller = (id: number) => ({ id, wifi_role: 'controller', wifi_role_probe: 4, capsman_flavor: 'wifi' });

  beforeEach(() => { (query as jest.Mock).mockReset(); (query as jest.Mock).mockResolvedValue([]); });

  it('tells "no such menu" from other traps', () => {
    expect(isNoSuchCommand(new RouterOSTrapError('no such command or directory (wireless)', '0'))).toBe(true);
    expect(isNoSuchCommand(new RouterOSTrapError('no such command prefix'))).toBe(true);
    expect(isNoSuchCommand(new RouterOSTrapError('interrupted', '2'))).toBe(false);
    expect(isNoSuchCommand(new RouterOSTrapError('not enough permissions (9)', '4'))).toBe(false);
    expect(isNoSuchCommand(new Error('Timed out'))).toBe(false);
  });

  it('an interrupted read records nothing and keeps the CAP inventory', async () => {
    const c = make(controller(101), rb5009(interrupted));
    await c.collectWirelessInterfaces();
    await c.collectCapsman();
    expect(sql('UPDATE devices SET wifi_role')).toHaveLength(0);
    expect(sql('DELETE FROM capsman_radios')).toHaveLength(0);
    // An interrupted package read doesn't make a 'none' either.
    const pkg = make(controller(102), { '/interface/wifi/print': interrupted, '/interface/wireless/print': missing });
    await pkg.collectWirelessInterfaces();
    expect(sql('UPDATE devices SET wifi_role')).toHaveLength(0);
  });

  it('a controller read as none once keeps its role until the next check agrees', async () => {
    const first = make(controller(103), rb5009([{ enabled: 'no' }]));
    expect(await first.detectWifiRole()).toBe('controller');
    await first.collectWirelessInterfaces();
    await first.collectCapsman();
    expect(sql('UPDATE devices SET wifi_role')).toHaveLength(0);
    expect(sql('DELETE FROM capsman_radios')).toHaveLength(0);

    const second = make(controller(103), rb5009([{ enabled: 'no' }]));
    await second.collectWirelessInterfaces();
    await second.collectCapsman();
    expect(sql('UPDATE devices SET wifi_role')[0][1].slice(0, 3)).toEqual([103, 'none', 'wifi']);
    expect(sql('DELETE FROM capsman_radios')).toHaveLength(1);
  });

  it('an answer matching the recorded role clears a pending change', async () => {
    await make(controller(104), rb5009([{ enabled: 'no' }])).detectWifiRole();     // held
    expect(await make(controller(104), rb5009([{ enabled: 'yes' }])).detectWifiRole()).toBe('controller');
    // The next 'none' is a first sighting again, not a second one.
    expect(await make(controller(104), rb5009([{ enabled: 'no' }])).detectWifiRole()).toBe('controller');
  });

  it('a role found where none was recorded is taken at once', async () => {
    const c = make({ id: 105, wifi_role: 'none', wifi_role_probe: 4 }, rb5009([{ enabled: 'yes' }]));
    await c.collectWirelessInterfaces();
    expect(sql('UPDATE devices SET wifi_role')[0][1].slice(0, 3)).toEqual([105, 'controller', 'wifi']);
  });
});
