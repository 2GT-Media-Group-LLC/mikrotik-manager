import { passwordLoginEnabled, passwordLoginRequestedOff } from '../passwordLogin';
import { loadOidcConfig } from '../../services/oidc/oidcConfig';

jest.mock('../../services/oidc/oidcConfig', () => ({ loadOidcConfig: jest.fn() }));
const mockSso = loadOidcConfig as jest.MockedFunction<typeof loadOidcConfig>;
const ready = { enabled: true, issuer_url: 'https://idp.example', client_id: 'mtm' } as Awaited<ReturnType<typeof loadOidcConfig>>;

describe('PASSWORD_LOGIN (#226)', () => {
  const env = process.env.PASSWORD_LOGIN;
  afterEach(() => { process.env.PASSWORD_LOGIN = env; mockSso.mockReset(); });
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  it('is on unless set to false', async () => {
    delete process.env.PASSWORD_LOGIN;
    expect(passwordLoginRequestedOff()).toBe(false);
    expect(await passwordLoginEnabled()).toBe(true);
    process.env.PASSWORD_LOGIN = 'true';
    expect(await passwordLoginEnabled()).toBe(true);
  });
  it('turns off when set to false and SSO is configured', async () => {
    process.env.PASSWORD_LOGIN = 'false';
    mockSso.mockResolvedValue(ready);
    expect(await passwordLoginEnabled()).toBe(false);
  });
  it('stays on when SSO is not configured, so nobody is locked out', async () => {
    process.env.PASSWORD_LOGIN = 'off';
    mockSso.mockResolvedValue({ ...ready, enabled: false });
    expect(await passwordLoginEnabled()).toBe(true);
    mockSso.mockRejectedValue(new Error('db down'));
    expect(await passwordLoginEnabled()).toBe(true);
  });
});
