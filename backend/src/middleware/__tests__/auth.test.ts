import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { signToken, signRawToken, verifyToken, requireAuth, requireAdmin, requireWrite, AuthPayload } from '../auth';
import { validateSession } from '../../utils/sessionState';

// The account check hits the database; each test says what the account looks like.
jest.mock('../../utils/sessionState', () => ({ validateSession: jest.fn() }));
const mockValidate = validateSession as jest.MockedFunction<typeof validateSession>;

const TEST_PAYLOAD: AuthPayload & { sv: number } = { userId: 1, username: 'alice', role: 'admin', sv: 0 };

/** Let requireAuth's account check settle. */
const settle = () => new Promise((r) => setImmediate(r));

// Minimal Express mock helpers
function mockReq(authHeader?: string): Request {
  return { headers: { authorization: authHeader } } as unknown as Request;
}

function mockRes() {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ── signToken / verifyToken ─────────────────────────────────────────────────

describe('signToken / verifyToken', () => {
  it('round-trips a payload', () => {
    const token = signToken(TEST_PAYLOAD);
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe(TEST_PAYLOAD.userId);
    expect(decoded.username).toBe(TEST_PAYLOAD.username);
    expect(decoded.role).toBe(TEST_PAYLOAD.role);
  });

  it('throws on an expired token', () => {
    const expired = jwt.sign(TEST_PAYLOAD, 'changeme', { expiresIn: '-1s' });
    expect(() => verifyToken(expired)).toThrow();
  });

  it('throws on a tampered token', () => {
    const token = signToken(TEST_PAYLOAD);
    const tampered = token.slice(0, -4) + 'xxxx';
    expect(() => verifyToken(tampered)).toThrow();
  });
});

// ── requireAuth ─────────────────────────────────────────────────────────────

describe('requireAuth', () => {
  it('returns 401 when Authorization header is missing', () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for non-Bearer scheme', () => {
    const req = mockReq('Basic dXNlcjpwYXNz');
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', () => {
    const req = mockReq('Bearer not.a.valid.jwt');
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next and sets req.user for a valid token on a current account', async () => {
    mockValidate.mockImplementation(async (p) => p);
    const token = signToken(TEST_PAYLOAD);
    const req = mockReq(`Bearer ${token}`);
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    await settle();
    expect(next).toHaveBeenCalled();
    expect(req.user?.userId).toBe(TEST_PAYLOAD.userId);
    expect(req.user?.role).toBe('admin');
  });

  // P2-1: a validly signed token for a deleted account, an older session
  // version or a logged-out session is refused.
  it('refuses a signed token whose session has ended', async () => {
    mockValidate.mockResolvedValue(null);
    const req = mockReq(`Bearer ${signToken(TEST_PAYLOAD)}`);
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    await settle();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_ended' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('uses the role the account has now, not the one in the token', async () => {
    mockValidate.mockImplementation(async (p) => ({ ...p, role: 'viewer' }));
    const req = mockReq(`Bearer ${signToken(TEST_PAYLOAD)}`);
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    await settle();
    expect(req.user?.role).toBe('viewer');
  });

  it('gives each session its own id and the session version it was issued with', () => {
    const a = verifyToken(signToken(TEST_PAYLOAD));
    const b = verifyToken(signToken({ ...TEST_PAYLOAD, sv: 3 }));
    expect(a.jti).toBeTruthy();
    expect(a.jti).not.toBe(b.jti);
    expect(b.sv).toBe(3);
  });
});

// ── requireAdmin ─────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
  it('returns 403 when req.user is not set', () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin role', () => {
    const req = mockReq();
    (req as Request & { user: AuthPayload }).user = { userId: 2, username: 'bob', role: 'operator' };
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('calls next for admin role', () => {
    const req = mockReq();
    (req as Request & { user: AuthPayload }).user = TEST_PAYLOAD;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ── requireWrite ─────────────────────────────────────────────────────────────

describe('requireWrite', () => {
  it('returns 403 for viewer role', () => {
    const req = mockReq();
    (req as Request & { user: AuthPayload }).user = { userId: 3, username: 'carol', role: 'viewer' };
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireWrite(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next for admin role', () => {
    const req = mockReq();
    (req as Request & { user: AuthPayload }).user = TEST_PAYLOAD;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireWrite(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next for operator role', () => {
    const req = mockReq();
    (req as Request & { user: AuthPayload }).user = { userId: 4, username: 'dave', role: 'operator' };
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireWrite(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ── Tokens that are signed correctly but are not sessions ───────────────────

describe('non-session tokens', () => {
  it('rejects the partial two-factor token as a session', () => {
    // Issued after the password, before the code. It shares the signing secret,
    // so only its shape tells it apart.
    const partial = signRawToken({ userId: 1, partial: true }, { expiresIn: '5m' });
    expect(() => verifyToken(partial)).toThrow();

    const req = mockReq(`Bearer ${partial}`);
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a signed token with no role or an unknown role', () => {
    expect(() => verifyToken(signRawToken({ userId: 1, username: 'x' }, { expiresIn: '5m' }))).toThrow();
    expect(() => verifyToken(signRawToken({ userId: 1, username: 'x', role: 'root' }, { expiresIn: '5m' }))).toThrow();
  });

  it('requireWrite refuses a user with no recognised role', () => {
    const req = mockReq();
    (req as Request & { user: AuthPayload }).user = { userId: 9 } as AuthPayload;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireWrite(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('requireWrite lets an operator through', () => {
    const req = mockReq();
    (req as Request & { user: AuthPayload }).user = { userId: 2, username: 'op', role: 'operator' };
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireWrite(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ── Default password must be changed first (P1-3) ───────────────────────────

describe('must-change-password sessions', () => {
  // The flag comes from the account now; the account still has the default password.
  beforeEach(() => mockValidate.mockImplementation(async (p) => ({ ...p, mustChangePassword: true })));
  const restricted = () => signToken({ userId: 1, username: 'admin', role: 'admin', sv: 0 });
  const reqFor = (path: string) =>
    ({ headers: { authorization: `Bearer ${restricted()}` }, originalUrl: path } as unknown as Request);

  it('can reach the password change endpoint', async () => {
    const next = jest.fn() as unknown as NextFunction;
    const res = mockRes();
    requireAuth(reqFor('/api/auth/password'), res, next);
    await settle();
    expect(next).toHaveBeenCalled();
  });

  it('is refused everywhere else, even as an admin', async () => {
    for (const path of ['/api/devices', '/api/settings/users', '/api/devices/8/reboot?x=1']) {
      const next = jest.fn() as unknown as NextFunction;
      const res = mockRes();
      requireAuth(reqFor(path), res, next);
      await settle();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
});

// ── site-scoped accounts (P1-7) ─────────────────────────────────────────────

describe('site-scoped sessions', () => {
  const scoped = { ...TEST_PAYLOAD, userId: 11, siteRoles: { 3: 'admin' } };

  async function run(url: string, siteId: number | number[] | undefined) {
    mockValidate.mockResolvedValueOnce({ ...scoped, siteRoles: { ...scoped.siteRoles } });
    const req = { headers: { authorization: `Bearer ${signToken(scoped)}` }, originalUrl: url, siteId } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    await settle();
    return { req, res, next };
  }

  it("refuses a site the account doesn't have", async () => {
    const { res, next } = await run('/api/devices', 1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'site_forbidden' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('uses the role held in the requested site', async () => {
    const { req, next } = await run('/api/devices', 3);
    expect(next).toHaveBeenCalled();
    expect(req.user?.role).toBe('admin');
  });

  // A site left selected in the browser by another account must not lock this
  // one out of /auth/me, which the interface uses to notice and drop it.
  it.each(['/api/auth/me', '/api/auth/logout', '/api/auth/password'])('ignores a stale site on %s', async (url) => {
    const { req, res, next } = await run(url, 1);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(req.siteId).toEqual([3]);
  });
});
