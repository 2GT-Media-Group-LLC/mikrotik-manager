/** Ids are read one way everywhere (GHSA-j9x4-qwcj-p8v8). */
jest.mock('../../config/database', () => ({ query: jest.fn(async () => []), queryOne: jest.fn() }));

import type { Request } from 'express';
import { strictId, strictIdList, deviceIdQuery, deviceIdParam, devicesDenied } from '../siteAccess';

const req = (over: Partial<Request> & { path?: string } = {}) =>
  ({ query: {}, body: undefined, url: over.path ?? '/', originalUrl: over.path ?? '/', ...over }) as unknown as Request;

describe('strictId', () => {
  it.each([[20, 20], ['20', 20], ['2147483647', 2147483647]])('reads %p', (v, n) => expect(strictId(v)).toBe(n));
  it.each([' 20', '+20', '-20', '0x14', '20x', '1e3', '', '0', 0, -1, 20.5, '2147483648', ['20'], null, undefined])(
    'refuses %p', (v) => expect(strictId(v)).toBeNull());
});

describe('strictIdList', () => {
  it('reads a list of ids', () => expect(strictIdList([1, '2'])).toEqual([1, 2]));
  it('refuses the whole list for one bad entry', () => expect(strictIdList([1, '0x2'])).toBeNull());
  it('refuses a non-list', () => expect(strictIdList('1,2')).toBeNull());
});

describe('deviceIdQuery', () => {
  it('is null when no device is named', () => {
    expect(deviceIdQuery(req())).toBeNull();
    expect(deviceIdQuery(req({ query: { deviceId: '' } as never }))).toBeNull();
  });
  it('reads ?deviceId= or body.deviceId', () => {
    expect(deviceIdQuery(req({ query: { deviceId: '20' } as never }))).toBe(20);
    expect(deviceIdQuery(req({ body: { deviceId: 20 } }))).toBe(20);
  });
  it('refuses a malformed id instead of reading it as no device', () => {
    for (const v of ['0x14', '+20', '20x', ['20', '21']]) expect(deviceIdQuery(req({ query: { deviceId: v } as never }))).toBeNaN();
  });
  it('refuses two different ids', () => {
    expect(deviceIdQuery(req({ query: { deviceId: '1' } as never, body: { deviceId: 20 } }))).toBeNaN();
    expect(deviceIdQuery(req({ query: { deviceId: '20' } as never, body: { deviceId: 20 } }))).toBe(20);
  });
});

describe('deviceIdParam', () => {
  it('reads a plain id and ignores named routes', () => {
    expect(deviceIdParam(req({ path: '/20/interfaces' }))).toBe(20);
    expect(deviceIdParam(req({ path: '/security/suppressions' }))).toBeNull();
  });
  it('refuses an id-like segment that is not plain', () => {
    for (const p of ['/0x14', '/+20/x', '/20x', '/-1']) expect(deviceIdParam(req({ path: p }))).toBeNaN();
  });
});

describe('devicesDenied', () => {
  it('denies malformed entries instead of dropping them', async () => {
    const user = { userId: 1, username: 'u', role: 'operator', siteRoles: { 1: 'operator' } };
    expect(await devicesDenied(user as never, ['0x14'], 'operator')).toEqual(['0x14']);
  });
});
