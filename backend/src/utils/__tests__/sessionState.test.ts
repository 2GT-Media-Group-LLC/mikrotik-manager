import { validateSession, endAllSessions, revokeSessionToken, forgetSessionAccount } from '../sessionState';
import { query, queryOne } from '../../config/database';
import { redis } from '../../config/redis';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../config/redis', () => ({ redis: { set: jest.fn(), exists: jest.fn() } }));

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockQuery = query as jest.MockedFunction<typeof query>;
const mockExists = redis.exists as unknown as jest.Mock;
const mockSet = redis.set as unknown as jest.Mock;

const account = (over: Record<string, unknown> = {}) =>
  ({ username: 'alice', role: 'admin', session_version: 2, must_change_password: false, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  forgetSessionAccount(1);
  mockExists.mockResolvedValue(0);
  mockSet.mockResolvedValue('OK');
  mockQuery.mockResolvedValue([] as never); // no site roles: a fleet-wide account
});

// Outside review P2-1.
describe('validateSession', () => {
  const session = { userId: 1, username: 'alice', role: 'admin', sv: 2, jti: 'abc' };

  it('accepts a session on the current version', async () => {
    mockQueryOne.mockResolvedValueOnce(account());
    expect(await validateSession(session)).toMatchObject({ userId: 1, role: 'admin' });
  });

  it('refuses a deleted account', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await validateSession(session)).toBeNull();
  });

  it('refuses a session from before a role or password change', async () => {
    mockQueryOne.mockResolvedValueOnce(account({ session_version: 3 }));
    expect(await validateSession(session)).toBeNull();
  });

  it('treats a token without a version as version 0', async () => {
    mockQueryOne.mockResolvedValueOnce(account({ session_version: 0 }));
    expect(await validateSession({ userId: 1, username: 'alice', role: 'admin' })).not.toBeNull();
  });

  it('uses the role the account has now', async () => {
    mockQueryOne.mockResolvedValueOnce(account({ role: 'viewer' }));
    expect((await validateSession(session))?.role).toBe('viewer');
  });

  it('refuses a logged-out session', async () => {
    mockQueryOne.mockResolvedValueOnce(account());
    mockExists.mockResolvedValueOnce(1);
    expect(await validateSession(session)).toBeNull();
  });

  it('carries the default-password flag from the account', async () => {
    mockQueryOne.mockResolvedValueOnce(account({ must_change_password: true }));
    expect((await validateSession(session))?.mustChangePassword).toBe(true);
    forgetSessionAccount(1);
    mockQueryOne.mockResolvedValueOnce(account());
    expect((await validateSession({ ...session, mustChangePassword: true }))?.mustChangePassword).toBeUndefined();
  });

  // P1-7: site roles come from the account on every request, never the token.
  it('attaches per-site roles for a site-scoped account', async () => {
    mockQueryOne.mockResolvedValueOnce(account());
    mockQuery.mockResolvedValueOnce([{ site_id: 3, role: 'operator' }, { site_id: 5, role: 'viewer' }] as never);
    expect((await validateSession(session))?.siteRoles).toEqual({ 3: 'operator', 5: 'viewer' });
  });

  it('leaves siteRoles off a fleet-wide account, even if the token carried some', async () => {
    mockQueryOne.mockResolvedValueOnce(account());
    const r = await validateSession({ ...session, siteRoles: { 9: 'admin' } });
    expect(r?.siteRoles).toBeUndefined();
  });

  it('passes API tokens through untouched', async () => {
    const token = { userId: -5, username: 'token:ci', role: 'operator', tokenAuth: true };
    expect(await validateSession(token)).toBe(token);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('sees a version change at once, not after the cache expires', async () => {
    mockQueryOne.mockResolvedValueOnce(account());
    expect(await validateSession(session)).not.toBeNull();
    mockQueryOne.mockResolvedValueOnce({ session_version: 3 }); // the UPDATE ... RETURNING
    await endAllSessions(1);
    mockQueryOne.mockResolvedValueOnce(account({ session_version: 3 }));
    expect(await validateSession(session)).toBeNull();
  });
});

describe('revokeSessionToken', () => {
  it('revokes until the token would have expired', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    await revokeSessionToken({ userId: 1, username: 'alice', role: 'admin', jti: 'abc', exp });
    const [key, , , ttl] = mockSet.mock.calls[0];
    expect(key).toBe('auth:revoked:abc');
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('does nothing for a token issued before tokens had an id', async () => {
    await revokeSessionToken({ userId: 1, username: 'alice', role: 'admin' });
    expect(mockSet).not.toHaveBeenCalled();
  });
});
