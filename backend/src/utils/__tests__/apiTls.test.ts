import { usesApiTls, managementService, parseApiTls, checkPort } from '../apiTls';

describe('usesApiTls', () => {
  it('keeps the 8729 rule for devices without a choice', () => {
    expect(usesApiTls({ api_port: 8729 })).toBe(true);
    expect(usesApiTls({ api_port: 8728, api_tls: null })).toBe(false);
  });
  it('follows an explicit choice on any port (#257)', () => {
    expect(usesApiTls({ api_port: 18729, api_tls: true })).toBe(true);
    expect(usesApiTls({ api_port: 8729, api_tls: false })).toBe(false);
    expect(managementService({ api_port: 50001, api_tls: true })).toBe('api-ssl');
  });
});

describe('parseApiTls', () => {
  it('reads form and CSV values', () => {
    expect(parseApiTls(true)).toBe(true);
    expect(parseApiTls('yes')).toBe(true);
    expect(parseApiTls('api-ssl')).toBe(true);
    expect(parseApiTls('0')).toBe(false);
    expect(parseApiTls(false)).toBe(false);
  });
  it('treats missing or unknown values as no choice', () => {
    expect(parseApiTls(undefined)).toBeNull();
    expect(parseApiTls('')).toBeNull();
    expect(parseApiTls('maybe')).toBeNull();
  });
});

describe('checkPort', () => {
  it('accepts 1 to 65535', () => {
    expect(checkPort('8729', 'API port')).toEqual({ ok: true, port: 8729 });
    expect(checkPort(1, 'API port')).toEqual({ ok: true, port: 1 });
    expect(checkPort(65535, 'API port')).toEqual({ ok: true, port: 65535 });
    expect(checkPort('', 'API port')).toEqual({ ok: true, port: null });
  });
  it('refuses negative, zero, too large and non-numbers', () => {
    for (const v of ['-1', 0, '65536', 70000, '12ab', '8.5', 'abc']) {
      expect(checkPort(v, 'API port').ok).toBe(false);
    }
  });
});
