jest.mock('../../config/database');
jest.mock('../mikrotik/RouterOSClient');
jest.mock('../../utils/crypto', () => ({ encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1') }));
jest.mock('../deviceCreation', () => ({ loadCredentialPreset: jest.fn() }));
jest.mock('../sshOnly', () => ({ readSshInfo: jest.fn() }));

import { query } from '../../config/database';
import { RouterOSClient } from '../mikrotik/RouterOSClient';
import { loadCredentialPreset } from '../deviceCreation';
import { bulkUpdateCredentials } from '../bulkCredentials';

const device = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id, name, ip_address: `10.0.0.${id}`, site_id: 1, api_port: 8729, api_tls: null, ssh_only: false, ssh_port: 22,
  ssh_username: 'backup', ssh_password_encrypted: 'enc(oldssh)', api_username: 'admin', api_password_encrypted: 'enc(old)', ...over,
});
const caller = { role: 'admin', presetCaller: { role: 'admin', siteRoles: null } as never };
const updates = () => (query as jest.Mock).mock.calls.filter(([sql]: [string]) => /UPDATE devices/.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  (loadCredentialPreset as jest.Mock).mockResolvedValue(null);
});

it('logs in to each device first and updates only those where it works', async () => {
  (query as jest.Mock).mockImplementation(async (sql: string) => (/SELECT/.test(sql) ? [device(1, 'a'), device(2, 'b')] : []));
  (RouterOSClient as unknown as jest.Mock).mockImplementation((host: string) => ({
    connect: jest.fn(async () => { if (host === '10.0.0.2') throw new Error('invalid user name or password (6)'); }),
    execute: jest.fn(async () => [{ name: 'x' }]),
    disconnect: jest.fn(),
  }));
  const r = await bulkUpdateCredentials([1, 2], { api_username: 'mtm', api_password: 'new' }, caller);
  expect(r.map((x) => [x.name, x.ok])).toEqual([['a', true], ['b', false]]);
  expect(updates()).toHaveLength(1);
  const params = updates()[0][1];
  expect(params.slice(0, 3)).toEqual([1, 'mtm', 'enc(new)']);
  // SSH login not given: kept as it was.
  expect(params[3]).toBe(false);
});

it('refuses a preset the account may not use on that device, without logging in', async () => {
  (query as jest.Mock).mockImplementation(async (sql: string) => (/SELECT/.test(sql) ? [device(1, 'a')] : []));
  (loadCredentialPreset as jest.Mock).mockRejectedValue(new Error('This preset belongs to another site.'));
  const r = await bulkUpdateCredentials([1], { credential_preset_id: 9 }, caller);
  expect(r[0]).toMatchObject({ ok: false, error: 'This preset belongs to another site.' });
  expect(RouterOSClient).not.toHaveBeenCalled();
  expect(updates()).toHaveLength(0);
});

it('takes the whole login, SSH included, from a preset', async () => {
  (query as jest.Mock).mockImplementation(async (sql: string) => (/SELECT/.test(sql) ? [device(1, 'a')] : []));
  (loadCredentialPreset as jest.Mock).mockResolvedValue({ api_username: 'mtm', api_password: 'p', api_port: null, ssh_username: null, ssh_password: null, ssh_port: null });
  (RouterOSClient as unknown as jest.Mock).mockImplementation(() => ({ connect: jest.fn(), execute: jest.fn(async () => []), disconnect: jest.fn() }));
  await bulkUpdateCredentials([1], { credential_preset_id: 3 }, caller);
  const params = updates()[0][1];
  expect(params).toEqual([1, 'mtm', 'enc(p)', true, null, null]);
});
