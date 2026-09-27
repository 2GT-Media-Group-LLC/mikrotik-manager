import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-backups-'));
process.env.BACKUPS_DIR = dir;

const inserted: unknown[][] = [];
jest.mock('../../config/database', () => ({
  query: jest.fn((_sql: string, params: unknown[]) => { inserted.push(params); return Promise.resolve([{ id: 1 }]); }),
  queryOne: jest.fn(() => Promise.resolve(null)),
}));

import { BackupService } from '../BackupService';

const device = { id: 7, name: 'wAP ax', ip_address: '10.0.0.2', ssh_port: 22, api_username: 'admin', api_password_encrypted: 'x' };
const rsc = '/interface wifi security\nadd name=home passphrase="hunter2-wifi-key"\n';

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('BackupService storage (#172)', () => {
  it('never writes a backup with secrets in plain text, and reads it back intact', async () => {
    const svc = new BackupService();
    await svc.createBackupFromContent(device, rsc, 'test', 'manual', true);
    const filePath = inserted.at(-1)![2] as string;
    const onDisk = fs.readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain('hunter2');
    expect(onDisk).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(BackupService.readContent({ file_path: filePath, encrypted: true })).toBe(rsc);
    // Recorded as containing secrets and encrypted; size is the readable size.
    expect(inserted.at(-1)!.slice(3)).toEqual([Buffer.byteLength(rsc), 'manual', 'test', true]);
    expect((fs.statSync(filePath).mode & 0o777).toString(8)).toBe('600');
  });

  it('keeps an ordinary backup as plain RouterOS script', async () => {
    const svc = new BackupService();
    await svc.createBackupFromContent(device, '/system identity set name=x\n', 'plain', 'manual', false);
    const filePath = inserted.at(-1)![2] as string;
    expect(fs.readFileSync(filePath, 'utf8')).toBe('/system identity set name=x\n');
    expect(inserted.at(-1)![6]).toBe(false);
  });
});
