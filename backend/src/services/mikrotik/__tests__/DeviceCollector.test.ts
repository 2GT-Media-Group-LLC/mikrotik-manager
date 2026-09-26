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

// ── collectSystemInfo: name vs. router identity ─────────────────────────────
//
// Regression test for a device's "+ Add Device" name getting silently
// clobbered by RouterOS's own /system/identity on the very first poll — see
// the `nameIsPlaceholder` gate in collectSystemInfo().

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

  beforeEach(() => {
    (query as jest.Mock).mockClear();
  });

  it("adopts the router's identity when the stored name is still the address placeholder", async () => {
    // CSV import / Try All default an un-named device's name to its address —
    // that placeholder should be replaced by something more useful once known.
    const device: DeviceRow = { ...testDevice, name: testDevice.ip_address };
    const collector = new DeviceCollector(device);
    (collector as unknown as { client: { execute: jest.Mock } }).client.execute = mockExecute('Core-Switch');

    await collector.collectSystemInfo();

    const [sql, params] = (query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/UPDATE devices/);
    expect(params[0]).toBe('Core-Switch');
  });

  it("never overwrites a name the operator actually typed, even with RouterOS's un-customized factory identity", async () => {
    const device: DeviceRow = { ...testDevice, name: 'aaa' };
    const collector = new DeviceCollector(device);
    // RouterOS ships with this as the un-customized default identity.
    (collector as unknown as { client: { execute: jest.Mock } }).client.execute = mockExecute('MikroTik');

    await collector.collectSystemInfo();

    const [, params] = (query as jest.Mock).mock.calls[0];
    expect(params[0]).toBe('aaa');
  });
});
