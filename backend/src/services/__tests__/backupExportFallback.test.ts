import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
process.env.BACKUPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-bk-'));
jest.mock('../../config/database', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn() }));
jest.mock('../../utils/crypto', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));
import { queryOne } from '../../config/database';
import { BackupService, isAuthRejection } from '../BackupService';

// Discussion #85: a key backup that timed out fell back to the password, which
// RouterOS refuses once a key is installed, hiding the real failure.
describe('backup export key fallback', () => {
  const device = { id: 3, name: 'rtr', ip_address: '10.0.0.3', ssh_port: 22, api_username: 'apimanager', api_password_encrypted: 'pw' };
  const authError = Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });

  beforeEach(() => {
    (queryOne as jest.Mock).mockResolvedValue({ private_key_encrypted: 'KEY', ssh_username: 'apimanager' });
  });

  it('reports a timeout during a key export instead of trying the password', async () => {
    const svc = new BackupService();
    const ssh = jest.spyOn(svc as unknown as { sshExport: () => Promise<string> }, 'sshExport')
      .mockRejectedValueOnce(new Error('the export stopped sending data for 60 seconds'));
    await expect(svc.exportConfig(device)).rejects.toThrow(/stopped sending data/);
    expect(ssh).toHaveBeenCalledTimes(1);
  });

  it('tries the password only when the device refused the key', async () => {
    const svc = new BackupService();
    const ssh = jest.spyOn(svc as unknown as { sshExport: (...a: unknown[]) => Promise<string> }, 'sshExport')
      .mockRejectedValueOnce(authError)
      .mockResolvedValueOnce('# config');
    await expect(svc.exportConfig(device)).resolves.toMatchObject({ text: '# config' });
    expect(ssh).toHaveBeenCalledTimes(2);
    expect(ssh.mock.calls[1][3]).toEqual({ password: 'pw' });
  });

  it('names both refusals when the password fails too', async () => {
    const svc = new BackupService();
    jest.spyOn(svc as unknown as { sshExport: () => Promise<string> }, 'sshExport')
      .mockRejectedValueOnce(authError).mockRejectedValueOnce(authError);
    await expect(svc.exportConfig(device)).rejects.toThrow(/refused the SSH key .* and the password too/);
  });

  it('recognises an authentication rejection, also when wrapped', () => {
    expect(isAuthRejection(authError)).toBe(true);
    expect(isAuthRejection(new Error('wrapped', { cause: authError }))).toBe(true);
    expect(isAuthRejection(new Error('Timed out while waiting for handshake'))).toBe(false);
  });
});
