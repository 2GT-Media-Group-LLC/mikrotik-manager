import { resolveProxyQuery } from '../proxyQuery';

describe('resolveProxyQuery', () => {
  it('defaults to clients over 24h', () => {
    const r = resolveProxyQuery(undefined, undefined);
    expect(r).toMatchObject({ interval: '24 hours', group: { key: 'client_ip' } });
  });

  it('accepts every documented by and range', () => {
    for (const by of ['client', 'user', 'destination', 'denied']) {
      for (const range of ['1h', '24h', '7d', '30d']) {
        expect('error' in resolveProxyQuery(by, range)).toBe(false);
      }
    }
  });

  it('rejects unknown and inherited property names', () => {
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope']) {
      expect(resolveProxyQuery(bad, '24h')).toEqual({ error: 'Invalid "by" value' });
      expect(resolveProxyQuery('client', bad)).toEqual({ error: 'Invalid "range" value' });
    }
  });
});
