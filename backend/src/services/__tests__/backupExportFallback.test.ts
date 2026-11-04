import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
process.env.BACKUPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-bk-'));
jest.mock('../../config/database', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn() }));
jest.mock('../../utils/crypto', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));
import { queryOne } from '../../config/database';
import { query } from '../../config/database';
import { BackupService, isAuthRejection, isHostKeyRefusal } from '../BackupService';

// Discussion #85: a key backup that timed out fell back to the password, which
// RouterOS refuses once a key is installed, hiding the real failure.
describe('backup export key fallback', () => {
  const device = { id: 3, name: 'rtr', ip_address: '10.0.0.3', ssh_port: 22, api_username: 'apimanager', api_password_encrypted: 'pw', jump_host_id: null };
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

// Ron's devices have SSH off (#392): the same export over the API, on RouterOS 7.13+.
describe('backup export over the API when SSH is off', () => {
  const dev = (id: number) => ({ id, name: `r${id}`, ip_address: `10.0.1.${id}`, ssh_port: 22, api_username: 'apimanager', api_password_encrypted: 'pw', jump_host_id: null });
  const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.1.1:22'), { code: 'ECONNREFUSED' });
  const version = (v: string | null) => (query as jest.Mock).mockImplementation(async (sql: string) => sql.includes('ros_version') ? [{ ros_version: v }] : []);
  type Spy = { sshExport: () => Promise<string>; apiExportFor: () => Promise<{ text: string; containsSecrets: boolean }> };
  const spies = (svc: BackupService) => ({
    ssh: jest.spyOn(svc as unknown as Spy, 'sshExport'),
    api: jest.spyOn(svc as unknown as Spy, 'apiExportFor'),
  });
  beforeEach(() => { (queryOne as jest.Mock).mockResolvedValue(null); });

  it('exports over the API when SSH is refused, then tries the API first', async () => {
    version('7.25');
    const svc = new BackupService();
    const { ssh, api } = spies(svc);
    ssh.mockRejectedValue(refused);
    api.mockResolvedValue({ text: '# via api', containsSecrets: false });
    await expect(svc.exportConfig(dev(11))).resolves.toMatchObject({ text: '# via api' });
    expect(ssh).toHaveBeenCalledTimes(1);
    await svc.exportConfig(dev(11));
    expect(ssh).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('never goes round a host key that does not match', async () => {
    version('7.25');
    const svc = new BackupService();
    const { ssh, api } = spies(svc);
    ssh.mockRejectedValue(new Error('The SSH host key changed', { cause: new Error('All configured authentication methods failed: host denied') }));
    await expect(svc.exportConfig(dev(12))).rejects.toThrow(/host key changed/);
    expect(api).not.toHaveBeenCalled();
    expect(isHostKeyRefusal(new Error('x', { cause: new Error('host denied (verification failed)') }))).toBe(true);
    expect(isHostKeyRefusal(refused)).toBe(false);
  });

  it('says why a device before 7.13 can\'t be backed up without SSH', async () => {
    version('7.12.1');
    const svc = new BackupService();
    const { ssh, api } = spies(svc);
    ssh.mockRejectedValue(refused);
    await expect(svc.exportConfig(dev(13))).rejects.toThrow(/ECONNREFUSED.*needs RouterOS 7\.13 or later/);
    expect(api).not.toHaveBeenCalled();
  });

  it('names both failures', async () => {
    version('7.25');
    const svc = new BackupService();
    const { ssh, api } = spies(svc);
    ssh.mockRejectedValue(refused);
    api.mockRejectedValue(new Error('Not exported over the API: only 900 KiB of storage is free'));
    await expect(svc.exportConfig(dev(14))).rejects.toThrow(/^over SSH: connect ECONNREFUSED.*; over the API: Not exported over the API: only 900 KiB/);
  });

  it('asks the API export for passwords and keys exactly when SSH would', async () => {
    version('7.25');
    const svc = new BackupService();
    const { ssh, api } = spies(svc);
    ssh.mockRejectedValue(refused);
    api.mockResolvedValue({ text: '#', containsSecrets: true });
    await svc.exportConfig(dev(15), { includeSecrets: true });
    expect((api.mock.calls[0] as unknown[])[1]).toEqual({ command: '/export compact show-sensitive', containsSecrets: true });
  });
});
