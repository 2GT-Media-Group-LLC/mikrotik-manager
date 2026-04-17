import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { signToken, verifyToken, requireAuth, requireAdmin, requireWrite, AuthPayload } from '../auth';

const TEST_PAYLOAD: AuthPayload = { userId: 1, username: 'alice', role: 'admin' };

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

  it('calls next and sets req.user for a valid token', () => {
    const token = signToken(TEST_PAYLOAD);
    const req = mockReq(`Bearer ${token}`);
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user?.userId).toBe(TEST_PAYLOAD.userId);
    expect(req.user?.role).toBe('admin');
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
