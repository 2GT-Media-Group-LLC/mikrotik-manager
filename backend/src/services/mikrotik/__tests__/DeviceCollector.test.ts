// Mock external deps before importing DeviceCollector
jest.mock('../../../utils/crypto', () => ({ decrypt: (s: string) => s }));
jest.mock('../RouterOSClient');
jest.mock('../../../config/database');
jest.mock('../../../config/influxdb');
jest.mock('../../../utils/oui');
jest.mock('../../../utils/serverArp');

import { DeviceCollector, DeviceRow } from '../DeviceCollector';
import { query } from '../../../config/database';

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
