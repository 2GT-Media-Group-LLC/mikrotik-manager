jest.mock('../../config/redis', () => ({ redis: {}, createRedisConnection: jest.fn() }));
jest.mock('../../config/database');
jest.mock('../../config/influxdb');
jest.mock('../apiCheck', () => ({
  checkApi: jest.fn(),
  recordApiCheck: jest.fn(),
  resolveUnspecifiedApiPort: jest.fn(),
}));
jest.mock('../sshOnly', () => ({
  refreshOverSsh: jest.fn(),
  promoteToApi: jest.fn(),
}));

import { PollerService } from '../PollerService';
import { checkApi, recordApiCheck, resolveUnspecifiedApiPort } from '../apiCheck';
import { promoteToApi, refreshOverSsh } from '../sshOnly';
import type { DeviceRow } from '../mikrotik/DeviceCollector';

type TestPoller = {
  processPollJob(data: { deviceId: number; type: 'full' | 'sshcheck' }): Promise<void>;
  getDevice: jest.Mock;
  getTimestamp: jest.Mock;
  setTimestamp: jest.Mock;
  recordPollSuccess: jest.Mock;
  scheduleDeviceSync: jest.Mock;
  emitForDevice: jest.Mock;
};

const device: DeviceRow = {
  id: 45, name: 'offline', ip_address: '192.168.88.2', api_port: 0,
  api_username: 'admin', api_password_encrypted: 'encrypted',
  ssh_port: 22, ssh_username: 'admin', ssh_password_encrypted: 'encrypted',
  jump_host_id: null, device_type: 'router', status: 'unknown', ssh_only: true,
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
    });
    jest.mocked(refreshOverSsh).mockResolvedValue({
      identity: null, rosVersion: null, model: null, serial: null, firmware: null, architecture: null,
    });
  });

  it('uses SSH first for an unverified SSH-only device, without probing the API', async () => {
    await poller.processPollJob({ deviceId: 45, type: 'full' });

    expect(refreshOverSsh).toHaveBeenCalledWith(device);
    expect(checkApi).not.toHaveBeenCalled();
    expect(resolveUnspecifiedApiPort).not.toHaveBeenCalled();
    expect(poller.recordPollSuccess).toHaveBeenCalledWith(device, 'unknown');
  });

  it('propagates an initial SSH failure without trying the API', async () => {
    jest.mocked(refreshOverSsh).mockRejectedValue(new Error('SSH unavailable'));

    await expect(poller.processPollJob({ deviceId: 45, type: 'full' })).rejects.toThrow('SSH unavailable');
    expect(checkApi).not.toHaveBeenCalled();
    expect(poller.recordPollSuccess).not.toHaveBeenCalled();
  });

  it('retries the API and promotes the device on a later poll', async () => {
    const online = { ...device, status: 'online' };
    poller.getDevice.mockResolvedValue(online);
    jest.mocked(checkApi).mockResolvedValue({ ok: true, port: 8729, tlsFingerprint: null });

    await poller.processPollJob({ deviceId: 45, type: 'sshcheck' });

    expect(checkApi).toHaveBeenCalledWith(online);
    expect(promoteToApi).toHaveBeenCalledWith(online, { ok: true, port: 8729, tlsFingerprint: null });
    expect(poller.scheduleDeviceSync).toHaveBeenCalledWith(45, 'full');
    expect(refreshOverSsh).not.toHaveBeenCalled();
  });

  it('continues over SSH when a later API check fails', async () => {
    const online = { ...device, status: 'online' };
    poller.getDevice.mockResolvedValue(online);
    jest.mocked(checkApi).mockResolvedValue({ ok: false, kind: 'unreachable', message: 'API unavailable' });
    jest.mocked(recordApiCheck).mockResolvedValue(undefined);

    await poller.processPollJob({ deviceId: 45, type: 'sshcheck' });

    expect(recordApiCheck).toHaveBeenCalledWith(45, 'API unavailable');
    expect(refreshOverSsh).toHaveBeenCalledWith(online);
    expect(poller.setTimestamp).toHaveBeenCalled();
  });
});
