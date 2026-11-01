/**
 * openid-client 6 is stricter than 5 was in two ways that would have broken
 * working setups on upgrade: it refuses http:// and compares the issuer
 * exactly. discoverProvider keeps the old behaviour where it is safe.
 */
jest.mock('../../../config/redis', () => ({ redis: { set: jest.fn(), get: jest.fn(), del: jest.fn() } }));
jest.mock('../../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../../utils/sessionState', () => ({ endAllSessions: jest.fn() }));
jest.mock('../oidcConfig', () => ({ loadOidcConfig: jest.fn(), getClientSecret: () => null }));

const mockDiscovery = jest.fn();
jest.mock('openid-client', () => ({
  discovery: (...a: unknown[]) => mockDiscovery(...a),
  ClientSecretBasic: (s: string) => `basic:${s}`,
  None: () => 'none',
  allowInsecureRequests: 'insecure',
}));

import { discoverProvider, oidcErrorMessage } from '../OidcService';

const mismatch = (issuer: string) =>
  Object.assign(new Error('discovered metadata issuer does not match the expected issuer'), {
    cause: { attribute: 'issuer', body: { issuer } },
  });

beforeEach(() => mockDiscovery.mockReset());

describe('discoverProvider', () => {
  it('accepts an issuer entered without the trailing slash the provider uses', async () => {
    mockDiscovery
      .mockRejectedValueOnce(mismatch('https://auth.corp/application/o/mtm/'))
      .mockResolvedValueOnce('config');
    await expect(discoverProvider('https://auth.corp/application/o/mtm', 'mtm')).resolves.toBe('config');
    expect((mockDiscovery.mock.calls[1][0] as URL).href).toBe('https://auth.corp/application/o/mtm/');
  });

  it('refuses a different issuer, naming the one the provider gave', async () => {
    mockDiscovery.mockRejectedValueOnce(mismatch('https://evil.example/'));
    await expect(discoverProvider('https://auth.corp/', 'mtm')).rejects.toThrow(/issuer is https:\/\/evil\.example\//);
    expect(mockDiscovery).toHaveBeenCalledTimes(1);
  });

  it('still allows a plain-HTTP issuer, and only then', async () => {
    mockDiscovery.mockResolvedValue('config');
    await discoverProvider('http://keycloak.lan:8080/realms/mtm', 'mtm');
    expect(mockDiscovery.mock.calls[0][4]).toEqual({ execute: ['insecure'] });
    await discoverProvider('https://keycloak.lan/realms/mtm', 'mtm');
    expect(mockDiscovery.mock.calls[1][4]).toBeUndefined();
  });

  it('uses client_secret_basic with a secret and no client auth without one', async () => {
    mockDiscovery.mockResolvedValue('config');
    await discoverProvider('https://idp/', 'mtm', 's3cret');
    await discoverProvider('https://idp/', 'mtm', null);
    expect(mockDiscovery.mock.calls[0][3]).toBe('basic:s3cret');
    expect(mockDiscovery.mock.calls[1][3]).toBe('none');
  });

  it('passes other errors through', async () => {
    mockDiscovery.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(discoverProvider('https://idp/', 'mtm')).rejects.toThrow('fetch failed');
  });
});

describe('oidcErrorMessage', () => {
  it('adds the underlying reason', () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(oidcErrorMessage(e)).toBe('fetch failed (ECONNREFUSED)');
  });
  it('names the OAuth error the provider returned', () => {
    const e = Object.assign(new Error('server responded with an error in the response body'), {
      error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials',
    });
    expect(oidcErrorMessage(e)).toBe(
      'server responded with an error in the response body (unauthorized_client: Invalid client or Invalid client credentials)');
  });
  it('leaves a plain error alone', () => {
    expect(oidcErrorMessage(new Error('nope'))).toBe('nope');
  });
});
