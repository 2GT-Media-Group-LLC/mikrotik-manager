import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeBackup, readHeader, readRecords, unlock, WrongPassphraseError, DamagedBackupError, type BackupRecord } from '../format';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-pb-'));
const PASS = 'correct horse battery staple';

async function* records(n: number): AsyncGenerator<BackupRecord> {
  yield { type: 'manifest', app_version: '0.62.0-beta', contents: 'config', tables: ['devices'] };
  yield { type: 'table', name: 'devices', columns: ['id', 'name'] };
  for (let i = 0; i < n; i++) yield { type: 'row', raw: JSON.stringify({ id: i, name: `dev-${i}`, note: 'ünïcødé ✓\nline 2' }) };
  yield { type: 'end' };
}

async function readAll(file: string, pass: string): Promise<BackupRecord[]> {
  const out: BackupRecord[] = [];
  for await (const r of readRecords(file, pass)) out.push(r);
  return out;
}

describe('platform backup file', () => {
  const file = path.join(dir, 'a.mtmbackup');

  beforeAll(async () => {
    await writeBackup(file, PASS, { appVersion: '0.62.0-beta', contents: 'config' }, records(5000));
  });

  it('round-trips every record, in order', async () => {
    const all = await readAll(file, PASS);
    expect(all).toHaveLength(5003);
    expect(all[0]).toMatchObject({ type: 'manifest' });
    expect(all[2]).toEqual({ type: 'row', raw: '{"id":0,"name":"dev-0","note":"ünïcødé ✓\\nline 2"}' });
    expect(all[all.length - 1]).toEqual({ type: 'end' });
  });

  it('keeps row JSON exactly as written, so big numbers keep every digit', async () => {
    const f = path.join(dir, 'big.mtmbackup');
    const raw = '{"id":1,"bytes":12345678901234567890,"price":0.10000000000000000001,"j":null}';
    async function* one(): AsyncGenerator<BackupRecord> { yield { type: 'row', raw }; yield { type: 'end' }; }
    await writeBackup(f, PASS, { appVersion: '0.62.0-beta', contents: 'config+database' }, one());
    const all = await readAll(f, PASS);
    expect(all[0]).toEqual({ type: 'row', raw });
  });

  it('keeps the header readable without the passphrase', async () => {
    const { header } = await readHeader(file);
    expect(header).toMatchObject({ format: 1, app_version: '0.62.0-beta', contents: 'config' });
    expect(JSON.stringify(header)).not.toContain('dev-0');
  });

  it('is unreadable without the passphrase', async () => {
    expect(fs.readFileSync(file).includes(Buffer.from('dev-0'))).toBe(false);
  });

  it('refuses a wrong passphrase straight away', async () => {
    const { header } = await readHeader(file);
    expect(() => unlock(header, 'wrong passphrase!!')).toThrow(WrongPassphraseError);
    await expect(readAll(file, 'wrong passphrase!!')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('detects a file altered after it was written', async () => {
    const bad = path.join(dir, 'tampered.mtmbackup');
    const buf = fs.readFileSync(file);
    buf[buf.length - 40] ^= 0xff;  // inside the ciphertext
    fs.writeFileSync(bad, buf);
    await expect(readAll(bad, PASS)).rejects.toThrow(DamagedBackupError);
  });

  it('rejects something that isn’t a backup', async () => {
    const junk = path.join(dir, 'junk.mtmbackup');
    fs.writeFileSync(junk, 'not a backup at all');
    await expect(readHeader(junk)).rejects.toThrow(/isn’t a MikroTik Manager backup/);
  });
});
