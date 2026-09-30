import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reencryptAll, encryptionStatus } from '../encryptedData';
import { query } from '../../config/database';

jest.mock('../../config/database', () => ({ query: jest.fn() }));
// Two known keys: "C:" values are under the current one, "O:" under an older
// one, anything else under none. Encrypting always produces "C:".
jest.mock('../../utils/crypto', () => ({
  ciphertextKeyState: (v: string) => (v.startsWith('C:') ? 'current' : v.startsWith('O:') ? 'old' : 'none'),
  decrypt: (v: string) => v.slice(2),
  encrypt: (v: string) => `C:${v}`,
}));

const mockQuery = query as jest.MockedFunction<typeof query>;

// Outside review P2-29: the sweep must cover every encrypted value, not only
// device and preset passwords.
describe('reencryptAll', () => {
  let dir: string;
  let backupOld: string;
  let backupCurrent: string;

  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-enc-'));
    backupOld = path.join(dir, 'old.rsc');
    backupCurrent = path.join(dir, 'cur.rsc');
    fs.writeFileSync(backupOld, 'O:backup-body');
    fs.writeFileSync(backupCurrent, 'C:backup-body');

    mockQuery.mockImplementation((async (sql: string) => {
      if (/FROM devices WHERE api_password_encrypted/.test(sql)) return [{ id: 1, value: 'O:pw1' }, { id: 2, value: 'C:pw2' }];
      if (/FROM devices WHERE ssh_password_encrypted/.test(sql)) return [{ id: 1, value: 'garbage' }];
      if (/FROM credential_presets/.test(sql)) return [];
      if (/FROM device_ssh_keys/.test(sql)) return [{ id: 5, value: 'O:private-key' }];
      if (/FROM app_settings/.test(sql)) return [{ value: { issuer: 'x', client_secret_encrypted: 'O:oidc' } }];
      if (/FROM backups/.test(sql)) return [{ id: 9, file_path: backupOld }, { id: 10, file_path: backupCurrent }];
      return [];
    }) as never);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('re-encrypts old values everywhere and leaves unreadable ones alone', async () => {
    const r = await reencryptAll();
    expect(r).toEqual({ rewritten: 4, unreadable: 1 });

    const updates = mockQuery.mock.calls.filter((c) => /^UPDATE/.test(String(c[0])));
    expect(updates).toEqual(expect.arrayContaining([
      [expect.stringMatching(/UPDATE devices SET api_password_encrypted/), ['C:pw1', 1]],
      [expect.stringMatching(/UPDATE device_ssh_keys SET private_key_encrypted = \$1 WHERE device_id/), ['C:private-key', 5]],
      [expect.stringMatching(/UPDATE app_settings/), [{ issuer: 'x', client_secret_encrypted: 'C:oidc' }, 'oidc_config']],
    ]));
    // The unreadable SSH password was not overwritten.
    expect(updates.some((c) => /ssh_password_encrypted/.test(String(c[0])))).toBe(false);
    // Backup files: the old one rewritten in place, the current one untouched.
    expect(fs.readFileSync(backupOld, 'utf8')).toBe('C:backup-body');
    expect(fs.readFileSync(backupCurrent, 'utf8')).toBe('C:backup-body');
    expect(fs.existsSync(`${backupOld}.reencrypt`)).toBe(false);
  });

  it('reports which key opens what, by location', async () => {
    const status = await encryptionStatus(true);
    const byName = Object.fromEntries(status.map((l) => [l.location, l]));
    expect(byName['Device API passwords']).toMatchObject({ current: 1, old: 1, unreadable: 0 });
    expect(byName['Device SSH passwords']).toMatchObject({ unreadable: 1 });
    expect(byName['SSO client secret']).toMatchObject({ old: 1 });
    expect(byName['Encrypted backups']).toMatchObject({ current: 1, old: 1 });
    expect(byName['Credential preset API passwords']).toBeUndefined(); // nothing stored there
  });
});
