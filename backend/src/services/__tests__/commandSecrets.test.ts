jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../../utils/crypto', () => ({ encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1') }));

import { query } from '../../config/database';
import { secretNames, fillSecrets, maskSecrets, generateSecret, missingSecrets, MASK } from '../commandSecrets';
import { refuseSecrets } from '../../utils/secretAccess';

const cmd = '/user add name=mtm group=full password="{{secret:mtm_pw}}" address={{ secret:mgmt_net }}; :log info "{{secret:mtm_pw}}"';

beforeEach(() => jest.clearAllMocks());

describe('commandSecrets (#259)', () => {
  it('finds the names a command uses, once each', () => {
    expect(secretNames(cmd)).toEqual(['mtm_pw', 'mgmt_net']);
    expect(secretNames('/system identity print')).toEqual([]);
  });

  it('fills them in from the encrypted store', async () => {
    (query as jest.Mock).mockResolvedValue([
      { name: 'mtm_pw', value_encrypted: 'enc(s3cretValue)' },
      { name: 'mgmt_net', value_encrypted: 'enc(10.0.0.0/24)' },
    ]);
    const f = await fillSecrets(cmd);
    expect(f.text).toBe('/user add name=mtm group=full password="s3cretValue" address=10.0.0.0/24; :log info "s3cretValue"');
    expect(f.values.sort()).toEqual(['10.0.0.0/24', 's3cretValue']);
  });

  it('refuses to run with a secret that no longer exists', async () => {
    (query as jest.Mock).mockResolvedValue([{ name: 'mtm_pw', value_encrypted: 'enc(x)' }]);
    await expect(fillSecrets(cmd)).rejects.toThrow(/not found: mgmt_net/);
    (query as jest.Mock).mockResolvedValue([{ name: 'mtm_pw' }]);
    expect(await missingSecrets(cmd)).toEqual(['mgmt_net']);
  });

  it('masks a value the device echoes, longest first', () => {
    expect(maskSecrets('failure: bad password s3cretValue', ['s3cret', 's3cretValue'])).toBe(`failure: bad password ${MASK}`);
    expect(maskSecrets(null, ['x'])).toBeNull();
  });

  it('generates values safe inside a quoted RouterOS string', () => {
    const v = generateSecret();
    expect(v).toHaveLength(24);
    expect(v).toMatch(/^[A-Za-z0-9]+$/);
    expect(generateSecret()).not.toBe(v);
  });
});

describe('refuseSecrets', () => {
  const req = (user: unknown) => ({ user }) as never;
  it('lets anyone run a command without secrets', async () => {
    expect(await refuseSecrets(req({ role: 'operator' }), '/system identity print')).toBeNull();
  });
  it('allows only a fleet admin to use them', async () => {
    expect(await refuseSecrets(req({ role: 'operator' }), cmd)).toMatchObject({ status: 403 });
    expect(await refuseSecrets(req({ role: 'admin', siteRoles: { 3: 'admin' } }), cmd)).toMatchObject({ status: 403 });
    (query as jest.Mock).mockResolvedValue([{ name: 'mtm_pw' }, { name: 'mgmt_net' }]);
    expect(await refuseSecrets(req({ role: 'admin' }), cmd)).toBeNull();
  });
  it('names the secrets that are missing', async () => {
    (query as jest.Mock).mockResolvedValue([{ name: 'mtm_pw' }]);
    expect(await refuseSecrets(req({ role: 'admin' }), cmd)).toMatchObject({ status: 400, error: expect.stringMatching(/mgmt_net/) });
  });
});
