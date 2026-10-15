import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
process.env.BACKUPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-bk-'));
jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../config/redis', () => ({ redis: { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } }));
jest.mock('../../utils/crypto', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));
jest.mock('../mikrotik/RouterOSClient');
import { query } from '../../config/database';
import { BackupService, describeRestore } from '../BackupService';

// PR #282 review: a restore insists on an armed revert while Change Guard is on,
// but an operator who turned the guard off gets the restore, as with any change.
describe('restore with Change Guard turned off', () => {
  const row = {
    id: 1, name: 'sw1', ip_address: '10.0.0.1', api_port: 8728, ssh_port: 22,
    api_username: 'admin', api_password_encrypted: 'pw', file_path: '/x', encrypted: false, backup_filename: 'b.rsc',
  };

  it('runs the import unprotected and reports it as such', async () => {
    jest.mocked(query).mockImplementation((async (sql: string) => {
      if (sql.includes('FROM backups')) return [row];
      if (sql.includes('change_guard_enabled')) return [{ key: 'change_guard_enabled', value: false }];
      return [];
    }) as never);
    jest.spyOn(BackupService, 'readContent').mockReturnValue('/system identity set name=sw1\n');
    const svc = new BackupService();
    const ssh = jest.spyOn(svc as unknown as { sshImport: () => Promise<unknown> }, 'sshImport')
      .mockResolvedValue({ status: 'applied' });

    const out = await svc.restoreBackup(1);
    expect(ssh).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('applied');
    expect(out.guard).toMatchObject({ protected: false, auto_reverting: false });
    expect(describeRestore(out)).toMatch(/without auto-revert \(Change Guard is disabled/);
  });
});
