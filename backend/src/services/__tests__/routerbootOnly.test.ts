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
  const start = Date.now();
  let rebooted = false;
  const install = jest.fn(async () => { /* written, but the reboot is ignored */ });
  const reboot = jest.fn(async () => { rebooted = true; });
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), checkForUpdates: jest.fn(), installRouterboardUpgrade: install, reboot,
    getUptimeSeconds: jest.fn(async () => (rebooted ? 20 : 86400 + Math.floor((Date.now() - start) / 1000))),
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
  const start = Date.now();
  const reboot = jest.fn(async () => { /* ignored again */ });
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), checkForUpdates: jest.fn(), installRouterboardUpgrade: jest.fn(), reboot,
    getUptimeSeconds: jest.fn(async () => 86400 + Math.floor((Date.now() - start) / 1000)),
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

it('accepts the new RouterBOOT version even when uptime has risen above its short pre-upgrade value', async () => {
  jest.useFakeTimers();
  let rebooted = false;
  const reboot = jest.fn();
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), reboot,
    installRouterboardUpgrade: jest.fn(async () => { rebooted = true; }),
    getUptimeSeconds: jest.fn(async () => (rebooted ? 25 : 10)),
    checkRouterboardUpgrade: jest.fn(async () => (rebooted
      ? { currentFirmware: '7.25.1', upgradeFirmware: '7.25.1', upgradeAvailable: false }
      : { currentFirmware: '7.25', upgradeFirmware: '7.25.1', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(4 * 60_000);
  expect(await done).toBe(true);
  expect(reboot).not.toHaveBeenCalled();
  jest.useRealTimers();
});

it('detects a restart from elapsed uptime even if the bootloader did not change', async () => {
  jest.useFakeTimers();
  let rebooted = false;
  const reboot = jest.fn();
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), reboot,
    installRouterboardUpgrade: jest.fn(async () => { rebooted = true; }),
    getUptimeSeconds: jest.fn(async () => (rebooted ? 20 : 10)),
    checkRouterboardUpgrade: jest.fn(async () => ({ currentFirmware: '7.25', upgradeFirmware: '7.25.1', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(4 * 60_000);
  expect(await done).toBe(false);
  expect(reboot).not.toHaveBeenCalled();
  expect(JSON.stringify(itemUpdates())).toMatch(/device rebooted but RouterBOOT still reports 7\.25/);
  jest.useRealTimers();
});

it('does not mistake a normally increasing short uptime for a restart', async () => {
  jest.useFakeTimers();
  const start = Date.now();
  const reboot = jest.fn();
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), reboot, installRouterboardUpgrade: jest.fn(),
    getUptimeSeconds: jest.fn(async () => 10 + Math.floor((Date.now() - start) / 1000)),
    checkRouterboardUpgrade: jest.fn(async () => ({ currentFirmware: '7.25', upgradeFirmware: '7.25.1', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(13 * 60_000);
  expect(await done).toBe(false);
  expect(reboot).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(itemUpdates())).toMatch(/device didn't restart when asked \(twice\)/);
  jest.useRealTimers();
});

it('does not retry or claim a reboot when uptime and the bootloader version are unavailable', async () => {
  jest.useFakeTimers();
  let installed = false;
  const reboot = jest.fn();
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), reboot,
    installRouterboardUpgrade: jest.fn(async () => { installed = true; }),
    getUptimeSeconds: jest.fn(async () => null),
    checkRouterboardUpgrade: jest.fn(async () => (installed
      ? { currentFirmware: '', upgradeFirmware: '', upgradeAvailable: false }
      : { currentFirmware: '7.25', upgradeFirmware: '7.25.1', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(13 * 60_000);
  expect(await done).toBe(false);
  expect(reboot).not.toHaveBeenCalled();
  expect(JSON.stringify(itemUpdates())).toMatch(/device is reachable, but its reboot and RouterBOOT upgrade could not be confirmed/);
  jest.useRealTimers();
});

it('reports a rejected reboot retry instead of saying the device was asked twice', async () => {
  jest.useFakeTimers();
  const start = Date.now();
  const reboot = jest.fn(async () => { throw new Error('not allowed'); });
  (DeviceCollector as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn(), disconnect: jest.fn(), reboot, installRouterboardUpgrade: jest.fn(),
    getUptimeSeconds: jest.fn(async () => 86400 + Math.floor((Date.now() - start) / 1000)),
    checkRouterboardUpgrade: jest.fn(async () => ({ currentFirmware: '7.25', upgradeFirmware: '7.25.1', upgradeAvailable: true })),
  }));
  const done = upgrade(new FirmwareOrchestrator());
  await jest.advanceTimersByTimeAsync(13 * 60_000);
  expect(await done).toBe(false);
  expect(reboot).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(itemUpdates())).toMatch(/reboot retry failed: not allowed/);
  expect(JSON.stringify(itemUpdates())).not.toMatch(/twice/);
  jest.useRealTimers();
});
