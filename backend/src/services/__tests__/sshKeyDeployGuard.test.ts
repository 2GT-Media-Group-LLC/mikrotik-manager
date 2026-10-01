jest.mock('../../config/database', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../../utils/crypto', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));
jest.mock('../sshHostCheck', () => ({ sshHostCheck: jest.fn(), explainSshError: (e: Error) => e.message }));
jest.mock('ssh2', () => ({ Client: jest.fn(() => { throw new Error('SSH must not be touched'); }) }));
const mockConnect = jest.fn();
jest.mock('../mikrotik/RouterOSClient', () => ({
  RouterOSClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect, execute: jest.fn().mockResolvedValue([]), disconnect: jest.fn(),
  })),
}));

import { SshKeyService, type SshTarget } from '../SshKeyService';

// Outside review P2-31: a key the manager could never take back off.
describe('SSH key deploy guard', () => {
  const target = {
    id: 7, name: 'sw', ip_address: '10.0.0.7', api_port: 8728, api_username: 'mtm', api_password_encrypted: 'pw',
    ssh_port: 22, ssh_username: null, ssh_password_encrypted: null,
  } as unknown as SshTarget;

  beforeEach(() => mockConnect.mockReset());

  it('refuses before touching SSH when the API login fails', async () => {
    mockConnect.mockRejectedValue(new Error('invalid user name or password'));
    await expect(new SshKeyService().deploy(target)).rejects.toThrow(/can't log in to this device over the API/);
  });

  it('refuses a device with no API login at all', async () => {
    await expect(new SshKeyService().deploy({ ...target, api_username: null } as SshTarget)).rejects.toThrow(/no API login/);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
