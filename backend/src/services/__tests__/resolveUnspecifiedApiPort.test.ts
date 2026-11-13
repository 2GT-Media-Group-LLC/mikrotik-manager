jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../../utils/crypto', () => ({ decrypt: (value: string) => value }));
jest.mock('../mikrotik/RouterOSClient');
jest.mock('../mikrotik/apiConnect', () => ({
  API_PORT: 8728,
  API_SSL_PORT: 8729,
  connectPreferringSsl: jest.fn(),
}));
jest.mock('../identityPins', () => ({ hasPin: jest.fn(), pinIdentity: jest.fn() }));

import { query } from '../../config/database';
import { runPollJob } from '../../utils/pollJobContext';
import { RouterOSClient } from '../mikrotik/RouterOSClient';
import { connectPreferringSsl } from '../mikrotik/apiConnect';
import { hasPin } from '../identityPins';
import { recordApiCheck, resolveUnspecifiedApiPort, type ApiCheckDevice } from '../apiCheck';

const device: ApiCheckDevice = {
  id: 1, ip_address: '192.168.1.1', api_port: 0, api_tls: null,
  api_username: 'admin', api_password_encrypted: 'password', jump_host_id: 7,
};

describe('recordApiCheck', () => {
  it('stores the check timestamp and error for the specified device', async () => {
    (query as jest.Mock).mockResolvedValueOnce([]);
    await recordApiCheck(1, 'API unavailable');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('api_checked_at = NOW(), api_check_error = $2'),
      [1, 'API unavailable'],
    );
  });
});

describe('resolveUnspecifiedApiPort', () => {
  const disconnect = jest.fn();
  const connect = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (hasPin as jest.Mock).mockResolvedValue(false);
    (connectPreferringSsl as jest.Mock).mockResolvedValue({ client: { disconnect }, port: 8729 });
    jest.mocked(RouterOSClient.prototype.connect).mockImplementation(connect);
    jest.mocked(RouterOSClient.prototype.disconnect).mockImplementation(disconnect);
    connect.mockResolvedValue(undefined);
    (query as jest.Mock).mockResolvedValue([{ api_port: 8729 }]);
  });

  it.each([8729, 8728])('stores the detected port %i and uses the device route', async (port) => {
    (connectPreferringSsl as jest.Mock).mockResolvedValue({ client: { disconnect }, port });
    (query as jest.Mock).mockResolvedValue([{ api_port: port }]);
    await expect(resolveUnspecifiedApiPort(device)).resolves.toBe(port);
    expect(connectPreferringSsl).toHaveBeenCalledWith(device.ip_address, 'admin', 'password',
      expect.objectContaining({ jumpHostId: 7, sslOnly: false }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('api_port = 0'),
      [1, port, device.ip_address, 'admin', 'password', null, 7]);
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not fall back to plaintext if an API-SSL certificate was already pinned', async () => {
    (hasPin as jest.Mock).mockResolvedValue(true);
    await resolveUnspecifiedApiPort(device);
    expect(connectPreferringSsl).toHaveBeenCalledWith(device.ip_address, 'admin', 'password',
      expect.objectContaining({ sslOnly: true }));
  });

  it.each([[true, 8729], [false, 8728]])('honors explicit TLS %s on port %i', async (tls, port) => {
    (query as jest.Mock).mockResolvedValue([{ api_port: port }]);
    await expect(resolveUnspecifiedApiPort({ ...device, api_tls: tls })).resolves.toBe(port);
    expect(RouterOSClient).toHaveBeenCalledWith(device.ip_address, port, 'admin', 'password', 6000, 30000, tls, 7);
    expect(connectPreferringSsl).not.toHaveBeenCalled();
  });

  it('does not save a port when detection fails', async () => {
    (connectPreferringSsl as jest.Mock).mockRejectedValue(new Error('Connection refused'));
    await expect(resolveUnspecifiedApiPort(device)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not continue with stale connection settings', async () => {
    (query as jest.Mock).mockResolvedValue([]);
    await expect(resolveUnspecifiedApiPort(device)).rejects.toThrow(/settings changed/);
  });

  it('uses the port resolved by a concurrent poll when connection settings are unchanged', async () => {
    (query as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ api_port: 8728 }]);
    await expect(resolveUnspecifiedApiPort(device)).resolves.toBe(8728);
  });

  it('does not save a port after a poll has been cancelled', async () => {
    let finish!: (value: unknown) => void;
    (connectPreferringSsl as jest.Mock).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const job = runPollJob(() => resolveUnspecifiedApiPort(device));
    await Promise.resolve();
    job.abortJob();
    finish({ client: { disconnect }, port: 8729 });
    await expect(job.promise).rejects.toThrow(/Poll cancelled/);
    expect(query).not.toHaveBeenCalled();
  });
});
