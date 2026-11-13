jest.mock('../../config/redis', () => ({ redis: {}, createRedisConnection: jest.fn() }));
jest.mock('../../config/database');
jest.mock('../../config/influxdb');
jest.mock('../apiCheck', () => ({
  checkApi: jest.fn(),
  recordApiCheck: jest.fn(),
  resolveUnspecifiedApiPort: jest.fn(),
}));
jest.mock('../sshOnly', () => ({
  readSshInfo: jest.fn(),
  refreshOverSsh: jest.fn(),
  promoteToApi: jest.fn(),
}));
jest.mock('../unknownDeviceSerial', () => ({ resolveUnknownDeviceSerial: jest.fn() }));
jest.mock('../mikrotik/DeviceCollector', () => ({ DeviceCollector: jest.fn() }));

import { PollerService } from '../PollerService';
import { checkApi, recordApiCheck, resolveUnspecifiedApiPort } from '../apiCheck';
import { promoteToApi, readSshInfo, refreshOverSsh } from '../sshOnly';
import { resolveUnknownDeviceSerial } from '../unknownDeviceSerial';
import { DeviceCollector, type DeviceRow } from '../mikrotik/DeviceCollector';
import { query } from '../../config/database';

type TestPoller = {
  processPollJob(data: { deviceId: number; type: 'full' | 'fast' | 'sshcheck' }): Promise<void>;
  getDevice: jest.Mock;
  getTimestamp: jest.Mock;
  setTimestamp: jest.Mock;
  recordPollSuccess: jest.Mock;
  scheduleDeviceSync: jest.Mock;
  emitForDevice: jest.Mock;
  getAppSettings: jest.Mock;
  recordDeviceFailure(deviceId: number, message: string): Promise<void>;
  recordPollOutcome(deviceId: number, kind: string, durationMs: number, error: string | null): Promise<void>;
};

const device: DeviceRow = {
  id: 45, name: 'offline', ip_address: '192.168.88.2', api_port: 0,
  api_username: 'admin', api_password_encrypted: 'encrypted',
  ssh_port: 22, ssh_username: 'admin', ssh_password_encrypted: 'encrypted',
  jump_host_id: null, device_type: 'router', status: 'unknown', ssh_only: true, force_add_pending: true,
};

describe('SSH-only polling', () => {
  let poller: TestPoller;

  beforeEach(() => {
    jest.clearAllMocks();
    poller = Object.assign(Object.create(PollerService.prototype) as TestPoller, {
      getDevice: jest.fn().mockResolvedValue(device),
      getTimestamp: jest.fn().mockResolvedValue(0),
      setTimestamp: jest.fn().mockResolvedValue(undefined),
      recordPollSuccess: jest.fn(),
      scheduleDeviceSync: jest.fn().mockResolvedValue(undefined),
      emitForDevice: jest.fn().mockResolvedValue(undefined),
      getAppSettings: jest.fn().mockResolvedValue({}),
      phases: new Map(),
    });
    jest.mocked(readSshInfo).mockResolvedValue({
      identity: null, rosVersion: null, model: null, serial: null, firmware: null, architecture: null,
    });
    jest.mocked(refreshOverSsh).mockResolvedValue({
      identity: null, rosVersion: null, model: null, serial: null, firmware: null, architecture: null,
    });
    jest.mocked(resolveUnknownDeviceSerial).mockResolvedValue({ action: 'continue' });
    jest.mocked(query).mockResolvedValue([]);
  });

  it('uses SSH first for an unverified SSH-only device, without probing the API', async () => {
    await poller.processPollJob({ deviceId: 45, type: 'full' });

    expect(readSshInfo).toHaveBeenCalledWith(device);
    expect(refreshOverSsh).toHaveBeenCalledWith(device, expect.objectContaining({ serial: null }));
    expect(checkApi).not.toHaveBeenCalled();
    expect(resolveUnspecifiedApiPort).not.toHaveBeenCalled();
    expect(poller.recordPollSuccess).toHaveBeenCalledWith(device, 'unknown');
  });

  it('propagates an initial SSH failure without trying the API', async () => {
    jest.mocked(readSshInfo).mockRejectedValue(new Error('SSH unavailable'));

    await expect(poller.processPollJob({ deviceId: 45, type: 'full' })).rejects.toThrow('SSH unavailable');
    expect(checkApi).not.toHaveBeenCalled();
    expect(poller.recordPollSuccess).not.toHaveBeenCalled();
  });

  it('records a failed first attempt but keeps the device unknown for the next poll', async () => {
    await poller.recordPollOutcome(45, 'full', 100, 'SSH unavailable');
    await poller.recordDeviceFailure(45, 'SSH unavailable');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO device_poll_stats'), [45, 'full', 100, 'SSH unavailable']);
    expect(jest.mocked(query).mock.calls.some(([sql]) => sql.includes("status = 'offline'"))).toBe(false);
  });

  it('records failure for a non-pending unknown device', async () => {
    poller.getDevice.mockResolvedValue({ ...device, force_add_pending: false });
    await poller.recordDeviceFailure(45, 'SSH unavailable');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'offline'"), [45],
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('NOT force_add_pending'), [45]);
  });

  it('retries the API and promotes the device on a later poll', async () => {
    const online = { ...device, status: 'online', force_add_pending: false };
    poller.getDevice.mockResolvedValue(online);
    jest.mocked(checkApi).mockResolvedValue({ ok: true, port: 8729, tlsFingerprint: null });

    await poller.processPollJob({ deviceId: 45, type: 'sshcheck' });

    expect(checkApi).toHaveBeenCalledWith(online);
    expect(promoteToApi).toHaveBeenCalledWith(online, { ok: true, port: 8729, tlsFingerprint: null });
    expect(poller.scheduleDeviceSync).toHaveBeenCalledWith(45, 'full');
    expect(refreshOverSsh).not.toHaveBeenCalled();
  });

  it('continues over SSH when a later API check fails', async () => {
    const online = { ...device, status: 'online', force_add_pending: false };
    poller.getDevice.mockResolvedValue(online);
    jest.mocked(checkApi).mockResolvedValue({ ok: false, kind: 'unreachable', message: 'API unavailable' });
    jest.mocked(recordApiCheck).mockResolvedValue(undefined);

    await poller.processPollJob({ deviceId: 45, type: 'sshcheck' });

    expect(recordApiCheck).toHaveBeenCalledWith(45, 'API unavailable');
    expect(refreshOverSsh).toHaveBeenCalledWith(online);
    expect(poller.setTimestamp).toHaveBeenCalled();
  });

  it('retries the API for an unknown SSH-only device that is not pending', async () => {
    const verified = { ...device, force_add_pending: false };
    poller.getDevice.mockResolvedValue(verified);
    jest.mocked(checkApi).mockResolvedValue({ ok: true, port: 8729, tlsFingerprint: null });
    await poller.processPollJob({ deviceId: 45, type: 'sshcheck' });
    expect(checkApi).toHaveBeenCalledWith(verified);
    expect(readSshInfo).not.toHaveBeenCalled();
    expect(resolveUnknownDeviceSerial).not.toHaveBeenCalled();
  });

  it('resolves a force-added SSH device before updating it', async () => {
    const pending = { ...device };
    const info = { identity: 'router', rosVersion: null, model: null, serial: 'AB12', firmware: null, architecture: null };
    poller.getDevice.mockResolvedValue(pending);
    jest.mocked(readSshInfo).mockResolvedValue(info);
    jest.mocked(resolveUnknownDeviceSerial).mockResolvedValue({ action: 'continue' });

    await poller.processPollJob({ deviceId: 45, type: 'full' });

    expect(resolveUnknownDeviceSerial).toHaveBeenCalledWith(pending, 'AB12');
    expect(refreshOverSsh).toHaveBeenCalledWith(pending, info);
    expect(checkApi).not.toHaveBeenCalled();
  });

  it('stops collecting and schedules the retained record when SSH finds a duplicate', async () => {
    const pending = { ...device };
    poller.getDevice.mockResolvedValue(pending);
    jest.mocked(readSshInfo).mockResolvedValue({
      identity: null, rosVersion: null, model: null, serial: 'AB12', firmware: null, architecture: null,
    });
    jest.mocked(resolveUnknownDeviceSerial).mockResolvedValue({ action: 'merged', deviceId: 10, disabled: false });

    await poller.processPollJob({ deviceId: 45, type: 'full' });

    expect(poller.scheduleDeviceSync).toHaveBeenCalledWith(10, 'full');
    expect(poller.emitForDevice).toHaveBeenCalledWith('device:updated', { deviceId: 10 }, 10);
    expect(refreshOverSsh).not.toHaveBeenCalled();
    expect(checkApi).not.toHaveBeenCalled();
  });

  it('resolves an API duplicate before collecting any device data', async () => {
    const pending = { ...device, api_port: 8729, ssh_only: false };
    const collector = {
      connectPooled: jest.fn().mockResolvedValue(undefined),
      reportedSerial: 'AB12',
      collectAll: jest.fn(),
      release: jest.fn(),
    };
    poller.getDevice.mockResolvedValue(pending);
    jest.mocked(DeviceCollector).mockImplementation(() => collector as unknown as DeviceCollector);
    jest.mocked(resolveUnknownDeviceSerial).mockResolvedValue({ action: 'removed', deviceId: 10, disabled: false });

    await poller.processPollJob({ deviceId: 45, type: 'full' });

    expect(collector.connectPooled).toHaveBeenCalledWith('slow', false);
    expect(resolveUnknownDeviceSerial).toHaveBeenCalledWith(pending, 'AB12');
    expect(collector.collectAll).not.toHaveBeenCalled();
    expect(collector.release).toHaveBeenCalledWith(false);
    expect(poller.emitForDevice).toHaveBeenCalledWith('device:updated', { deviceId: 10 }, 10);
  });

  it('does not reconcile an unknown API device that is not pending', async () => {
    const verified = { ...device, api_port: 8729, ssh_only: false, force_add_pending: false };
    const collector = {
      connectPooled: jest.fn().mockResolvedValue(undefined),
      collectFast: jest.fn().mockResolvedValue(undefined),
      timings: { connectMs: 1, reused: false },
      deviceTime: jest.fn().mockReturnValue(0),
      release: jest.fn(),
    };
    poller.getDevice.mockResolvedValue(verified);
    jest.mocked(DeviceCollector).mockImplementation(() => collector as unknown as DeviceCollector);

    await poller.processPollJob({ deviceId: 45, type: 'fast' });

    expect(resolveUnknownDeviceSerial).not.toHaveBeenCalled();
    expect(collector.collectFast).toHaveBeenCalled();
  });
});
