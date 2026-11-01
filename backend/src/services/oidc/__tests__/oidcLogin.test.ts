const store = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  redis: {
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
  },
}));
const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
jest.mock('../../../config/database', () => ({ query: (...a: unknown[]) => mockQuery(...a), queryOne: (...a: unknown[]) => mockQueryOne(...a) }));
jest.mock('../../../utils/sessionState', () => ({ endAllSessions: jest.fn() }));
let config: Record<string, unknown>;
jest.mock('../oidcConfig', () => ({ loadOidcConfig: async () => config, getClientSecret: () => null }));
let claims: Record<string, unknown>;
const mockGrant = jest.fn();
jest.mock('openid-client', () => ({
  randomState: () => 'st', randomNonce: () => 'n', randomPKCECodeVerifier: () => 'v',
  calculatePKCECodeChallenge: async () => 'c',
  ClientSecretBasic: () => 'basic', None: () => 'none', allowInsecureRequests: 'insecure',
  discovery: async () => ({}),
  buildAuthorizationUrl: () => new URL('https://idp/authorize'),
  authorizationCodeGrant: (...a: unknown[]) => mockGrant(...a),
  fetchUserInfo: async () => ({}),
}));

import { beginLogin, completeLogin, resetOidcClientCache } from '../OidcService';

const baseConfig = {
  enabled: true, issuer_url: 'https://idp', client_id: 'mtm', client_secret_encrypted: null, scopes: 'openid',
  username_claim: 'preferred_username', email_claim: 'email', groups_claim: 'groups',
  group_role_map: {}, default_role: 'viewer', auto_provision: true, link_by_verified_email: false,
  allowed_email_domains: [], button_label: 'SSO', public_base_url: '',
};

beforeEach(() => {
  store.clear();
  mockQuery.mockReset().mockResolvedValue([]);
  mockQueryOne.mockReset().mockResolvedValue(null);
  config = { ...baseConfig };
  claims = { sub: 'u1', iss: 'https://idp', email: 'a@corp.com', email_verified: true, preferred_username: 'alice' };
  resetOidcClientCache();
  mockGrant.mockReset().mockImplementation(async () => ({ claims: () => claims }));
});

const start = (binding = 'B') => beginLogin('https://mtm/api/auth/oidc/callback', '/dashboard', binding);

// Outside review S2.
describe('browser binding', () => {
  it('refuses a callback from a browser that did not start the login', async () => {
    await start('mine');
    await expect(completeLogin({ state: 'st', code: 'x' }, 'someone-else')).rejects.toThrow(/different browser/);
  });

  it('refuses a callback with no binding cookie at all', async () => {
    await start();
    await expect(completeLogin({ state: 'st', code: 'x' }, null)).rejects.toThrow(/different browser/);
  });

  it('refuses to finish once SSO has been turned off', async () => {
    await start('B');
    config = { ...config, enabled: false };
    await expect(completeLogin({ state: 'st', code: 'x' }, 'B')).rejects.toThrow(/turned off/);
  });
});

// Outside review S3.
describe('accounts and roles', () => {
  it('does not admit an unverified email by its domain', async () => {
    config = { ...config, allowed_email_domains: ['corp.com'] };
    claims = { ...claims, email_verified: false };
    await start('B');
    await expect(completeLogin({ state: 'st', code: 'x' }, 'B')).rejects.toThrow(/verified/);
  });

  it('admits a verified email on an allowed domain', async () => {
    config = { ...config, allowed_email_domains: ['corp.com'] };
    mockQueryOne.mockImplementation(async (sql: string) =>
      /INSERT INTO users/.test(sql) ? { id: 9, username: 'alice', role: 'viewer' } : null);
    await start('B');
    await expect(completeLogin({ state: 'st', code: 'x' }, 'B')).resolves.toMatchObject({ user: { id: 9 } });
  });

  it('drops a linked admin to the default role when the mapped group is gone', async () => {
    config = { ...config, group_role_map: { 'mtm-admins': 'admin' } };
    claims = { ...claims, groups: ['staff'] };
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (/oidc_subject = \$2/.test(sql)) return { id: 5, username: 'alice', role: 'admin' };
      if (/role = 'admin'/.test(sql)) return { n: '1' }; // another admin exists
      return null;
    });
    await start('B');
    const { user } = await completeLogin({ state: 'st', code: 'x' }, 'B');
    expect(user.role).toBe('viewer');
  });

  it('never demotes the last admin', async () => {
    config = { ...config, group_role_map: { 'mtm-admins': 'admin' } };
    claims = { ...claims, groups: [] };
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (/oidc_subject = \$2/.test(sql)) return { id: 5, username: 'alice', role: 'admin' };
      if (/role = 'admin'/.test(sql)) return { n: '0' };
      return null;
    });
    await start('B');
    expect((await completeLogin({ state: 'st', code: 'x' }, 'B')).user.role).toBe('admin');
  });

  it('leaves roles alone when no group mapping is configured', async () => {
    mockQueryOne.mockImplementation(async (sql: string) =>
      /oidc_subject = \$2/.test(sql) ? { id: 5, username: 'alice', role: 'operator' } : null);
    await start('B');
    expect((await completeLogin({ state: 'st', code: 'x' }, 'B')).user.role).toBe('operator');
  });
});

describe('the token exchange', () => {
  it('rebuilds the callback URL and checks state, nonce and PKCE', async () => {
    mockQueryOne.mockImplementation(async (sql: string) =>
      /INSERT INTO users/.test(sql) ? { id: 9, username: 'alice', role: 'viewer' } : null);
    await start('B');
    await completeLogin({ state: 'st', code: 'abc', iss: 'https://idp' }, 'B');
    const [, url, checks] = mockGrant.mock.calls[0] as [unknown, URL, Record<string, unknown>];
    expect(url.origin + url.pathname).toBe('https://mtm/api/auth/oidc/callback');
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: 'st', code: 'abc', iss: 'https://idp' });
    expect(checks).toEqual({ pkceCodeVerifier: 'v', expectedState: 'st', expectedNonce: 'n', idTokenExpected: true });
  });

  it('refuses a repeated response parameter', async () => {
    await start('B');
    await expect(completeLogin({ state: 'st', code: ['a', 'b'] }, 'B')).rejects.toThrow(/Unexpected code/);
    expect(mockGrant).not.toHaveBeenCalled();
  });
});
