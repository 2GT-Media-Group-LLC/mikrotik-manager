// RouterBOOT-only rollouts (#262): the bootloader alone, without RouterOS.
jest.mock('../../config/database', () => ({ query: jest.fn(async () => []), queryOne: jest.fn() }));
jest.mock('../BackupService', () => ({ BackupService: jest.fn() }));
jest.mock('../mikrotik/DeviceCollector', () => ({ DeviceCollector: jest.fn() }));

import { query, queryOne } from '../../config/database';
import { DeviceCollector } from '../mikrotik/DeviceCollector';
import { FirmwareOrchestrator } from '../FirmwareOrchestrator';

const device = { id: 8, name: 'TEST', ip_address: '192.168.0.51', ros_version: '7.24.5' };
const rollout = { id: 1, name: 'rb', kind: 'routerboot', pre_backup: false, routerboot_after: false, package_source: 'mikrotik', post_command: null };
const item = { id: 11, rollout_id: 1, device_id: 8, wave: 1, status: 'pending' };
const upgrade = (o: FirmwareOrchestrator) =>
  (o as unknown as { upgradeDevice: (r: unknown, i: unknown) => Promise<boolean> }).upgradeDevice(rollout, item);
const itemUpdates = () => (query as jest.Mock).mock.calls
  .filter(([sql]: [string]) => /UPDATE firmware_rollout_devices SET status/.test(sql) || /UPDATE firmware_rollout_devices SET .*=\$/.test(sql))
  .map(([, params]: [string, unknown[]]) => params);

beforeEach(() => {
  jest.clearAllMocks();
  (queryOne as jest.Mock).mockResolvedValue(device);
});

it('skips a device whose RouterBOOT is already current, without touching RouterOS', async () => {
  const checkForUpdates = jest.fn();
  const install = jest.fn();
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), checkForUpdates, installRouterboardUpgrade: install,
    checkRouterboardUpgrade: jest.fn(async () => ({ currentFirmware: '7.24.5', upgradeFirmware: '7.24.5', upgradeAvailable: false })),
  }));
  expect(await upgrade(new FirmwareOrchestrator())).toBe(true);
  expect(install).not.toHaveBeenCalled();
  expect(checkForUpdates).not.toHaveBeenCalled();
  expect(JSON.stringify(itemUpdates())).toMatch(/skipped/);
});

it('upgrades a pending RouterBOOT and confirms the new version after the reboot', async () => {
  jest.useFakeTimers();
  let rebooted = false;
  const install = jest.fn(async () => { rebooted = true; });
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), checkForUpdates: jest.fn(), installRouterboardUpgrade: install,
    getUptimeSeconds: jest.fn(async () => (rebooted ? 20 : 86400)),
    checkRouterboardUpgrade: jest.fn(async () => (rebooted
      ? { currentFirmware: '7.24.5', upgradeFirmware: '7.24.5', upgradeAvailable: false }
      : { currentFirmware: '7.20.1', upgradeFirmware: '7.24.5', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(20_000);
  expect(await done).toBe(true);
  jest.useRealTimers();
  expect(install).toHaveBeenCalledTimes(1);
  const updates = JSON.stringify(itemUpdates());
  expect(updates).toMatch(/success/);
  expect(updates).toMatch(/7\.20\.1/);
  // Shown as it happens, not "Pending" (#262).
  const statuses = itemUpdates().map((p) => p[1]).filter((v) => typeof v === 'string');
  expect(statuses).toEqual(expect.arrayContaining(['routerboot', 'rebooting', 'success']));
  expect(statuses.indexOf('routerboot')).toBeLessThan(statuses.indexOf('rebooting'));
});

it('sends the reboot again when the device stays up after the RouterBOOT write (rollout 35)', async () => {
  jest.useFakeTimers();
  let rebooted = false;
  const install = jest.fn(async () => { /* written, but the reboot is ignored */ });
  const reboot = jest.fn(async () => { rebooted = true; });
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), checkForUpdates: jest.fn(), installRouterboardUpgrade: install, reboot,
    getUptimeSeconds: jest.fn(async () => (rebooted ? 20 : 86400)),
    checkRouterboardUpgrade: jest.fn(async () => (rebooted
      ? { currentFirmware: '7.25.1', upgradeFirmware: '7.25.1', upgradeAvailable: false }
      : { currentFirmware: '7.25', upgradeFirmware: '7.25.1', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(4 * 60_000);
  expect(await done).toBe(true);
  jest.useRealTimers();
  expect(reboot).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(itemUpdates())).toMatch(/success/);
});

it('says the device never restarted, not that it never came back, when it ignores both reboots', async () => {
  jest.useFakeTimers();
  const reboot = jest.fn(async () => { /* ignored again */ });
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), checkForUpdates: jest.fn(), installRouterboardUpgrade: jest.fn(), reboot,
    getUptimeSeconds: jest.fn(async () => 86400),
    checkRouterboardUpgrade: jest.fn(async () => ({ currentFirmware: '7.25', upgradeFirmware: '7.25.1', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(13 * 60_000);
  expect(await done).toBe(false);
  jest.useRealTimers();
  expect(reboot).toHaveBeenCalledTimes(1);
  const updates = JSON.stringify(itemUpdates());
  expect(updates).toMatch(/RouterBOOT 7\.25\.1 was written, but the device didn't restart when asked \(twice\)/);
  expect(updates).not.toMatch(/did not come back/);
});
