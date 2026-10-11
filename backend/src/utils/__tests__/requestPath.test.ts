import type { Request, Response, NextFunction } from 'express';
import { decodedPath } from '../requestPath';
import { deviceIdParam, deviceSiteAccess } from '../siteAccess';
import { deviceIdFromPath } from '../../services/changeGuard/deviceLock';

// GHSA-6xq3-q9m5-7hxp: access checks must read the same id the route handler
// receives, which Express decodes.
const req = (path: string, extra: Partial<Request> = {}) => ({ path, ...extra }) as unknown as Request;

describe('decodedPath', () => {
  it('decodes each segment as Express decodes route parameters', () => {
    expect(decodedPath(req('/%31%32/system-config'))).toBe('/12/system-config');
    expect(decodedPath(req('/12/ports/ether1'))).toBe('/12/ports/ether1');
  });
  it('returns null for a path that cannot be decoded', () => {
    expect(decodedPath(req('/%E0%A4%A/x'))).toBeNull();
  });
});

describe('device id helpers read the decoded id', () => {
  it('finds the device in an encoded path', () => {
    expect(deviceIdParam(req('/%31%32/system-config'))).toBe(12);
    expect(deviceIdFromPath(req('/%31%32/system-config'))).toBe(12);
  });
  it('reports a malformed path so it can be refused', () => {
    expect(deviceIdParam(req('/%E0%A4%A/system-config'))).toBeNaN();
  });
  it('is unchanged for ordinary paths', () => {
    expect(deviceIdParam(req('/7/vlans'))).toBe(7);
    expect(deviceIdParam(req('/bulk-add/jobs'))).toBeNull();
  });
});

describe('deviceSiteAccess', () => {
  const run = async (path: string) => {
    const r = req(path, { user: { userId: 9, username: 'op', role: 'operator', siteRoles: { 3: 'operator' } } } as Partial<Request>);
    const res = { statusCode: 200, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    let passed = false;
    await deviceSiteAccess(() => deviceIdParam(r))(r, res as unknown as Response, (() => { passed = true; }) as NextFunction);
    return { passed, status: res.statusCode };
  };
  it('refuses a malformed path for a site-scoped account rather than letting it through', async () => {
    expect(await run('/%E0%A4%A/system-config')).toEqual({ passed: false, status: 400 });
  });
});
