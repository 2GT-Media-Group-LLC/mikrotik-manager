import { parseDnsSource, urlError } from '../dnsSourceInput';

const base = { name: 'Home AdGuard', site_id: 1, url: 'http://192.168.88.2:3000/', username: 'admin', password: 'pw' };

describe('AdGuard Home source input (#366 step 3)', () => {
  it('accepts a source and tidies the address', () => {
    expect(parseDnsSource(base)).toEqual({ value: { name: 'Home AdGuard', kind: 'adguard', site_id: 1, url: 'http://192.168.88.2:3000', username: 'admin', password: 'pw', tls_verify: true, enabled: true } });
  });

  it('refuses addresses it shouldn\'t call', () => {
    expect(urlError('ftp://x')).toMatch(/http/);
    expect(urlError('http://user:pw@x')).toMatch(/own fields/);
    expect(urlError('http://x/?a=1')).toMatch(/after \?/);
    expect(urlError('not a url')).toMatch(/valid/);
    expect(urlError('')).toMatch(/Enter/);
  });

  it('refuses a password that arrives already encrypted', () => {
    expect(parseDnsSource({ ...base, password: 'enc:aa:bb:cc' })).toMatchObject({ field: 'password' });
  });

  it('keeps the saved password only while the address and certificate check stay put', () => {
    const saved = { url: 'http://192.168.88.2:3000', tls_verify: true, password: 'enc:sealed' };
    const { password: _omit, ...noPw } = base;
    expect(parseDnsSource({ ...noPw, name: 'Renamed' }, saved)).toMatchObject({ value: { password: undefined } });
    expect(parseDnsSource({ ...noPw, url: 'http://attacker.example' }, saved)).toMatchObject({ field: 'password' });
    expect(parseDnsSource({ ...noPw, url: 'https://192.168.88.2:3000', tls_verify: false }, saved)).toMatchObject({ field: 'password' });
    expect(parseDnsSource({ ...noPw, tls_verify: false }, { ...saved, url: 'https://x', tls_verify: true })).toMatchObject({ field: 'password' });
    expect(parseDnsSource({ ...base, url: 'http://elsewhere' }, saved)).toMatchObject({ value: { password: 'pw' } });
  });

  it('takes Pi-hole too, which logs in with a password alone', () => {
    expect(parseDnsSource({ ...base, kind: 'pihole' })).toMatchObject({ value: { kind: 'pihole', username: '' } });
    expect(parseDnsSource({ ...base, kind: 'bind' })).toMatchObject({ field: 'kind' });
  });

  it('checks the other fields', () => {
    expect(parseDnsSource({ ...base, name: '' })).toMatchObject({ field: 'name' });
    expect(parseDnsSource({ ...base, site_id: 'x' })).toMatchObject({ field: 'site_id' });
    expect(parseDnsSource({ ...base, tls_verify: 'no' })).toMatchObject({ field: 'tls_verify' });
  });
});
