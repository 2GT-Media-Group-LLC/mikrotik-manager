// Mock external deps before importing DeviceCollector
jest.mock('../../../utils/crypto', () => ({ decrypt: (s: string) => s }));
jest.mock('../RouterOSClient');
jest.mock('../../../config/database');
jest.mock('../../../config/influxdb');
jest.mock('../../../utils/oui');
jest.mock('../../../utils/serverArp');

import { DeviceCollector, DeviceRow } from '../DeviceCollector';

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
