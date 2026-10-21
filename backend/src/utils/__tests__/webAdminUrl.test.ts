import { webAdminUrl } from '../webAdminUrl';

const svc = (name: string, port: string, disabled: string, extra: Record<string, string> = {}) => ({ name, port, disabled, ...extra });

describe('webAdminUrl', () => {
  it('uses HTTPS when www-ssl is on, even with plain www off (#335)', () => {
    expect(webAdminUrl('192.168.0.51', [svc('www', '80', 'true'), svc('www-ssl', '443', 'false', { certificate: 'webfig' })]))
      .toEqual({ url: 'https://192.168.0.51/', note: null });
  });

  it('prefers HTTPS when both are on', () => {
    expect(webAdminUrl('10.0.0.1', [svc('www', '80', 'false'), svc('www-ssl', '443', 'false', { certificate: 'c' })]).url)
      .toBe('https://10.0.0.1/');
  });

  it('keeps a non-standard port', () => {
    expect(webAdminUrl('10.0.0.1', [svc('www', '80', 'true'), svc('www-ssl', '8443', 'false', { certificate: 'c' })]).url)
      .toBe('https://10.0.0.1:8443/');
    expect(webAdminUrl('10.0.0.1', [svc('www', '8080', 'false'), svc('www-ssl', '443', 'true')]).url)
      .toBe('http://10.0.0.1:8080/');
  });

  it('falls back to plain HTTP when only www is on', () => {
    expect(webAdminUrl('10.0.0.1', [svc('www', '80', 'false'), svc('www-ssl', '443', 'true')]))
      .toEqual({ url: 'http://10.0.0.1/', note: null });
  });

  it('notes a www-ssl without a certificate', () => {
    const r = webAdminUrl('10.0.0.1', [svc('www-ssl', '443', 'false', { certificate: 'none' })]);
    expect(r.url).toBe('https://10.0.0.1/');
    expect(r.note).toMatch(/no certificate/);
  });

  it('says so when both are off', () => {
    expect(webAdminUrl('10.0.0.1', [svc('www', '80', 'true'), svc('www-ssl', '443', 'true')]))
      .toEqual({ url: null, note: expect.stringMatching(/turned off/) });
  });

  it('brackets an IPv6 address', () => {
    expect(webAdminUrl('2001:db8::1', [svc('www-ssl', '8443', 'false', { certificate: 'c' })]).url).toBe('https://[2001:db8::1]:8443/');
  });

  it('uses the enabled row when a service is listed twice', () => {
    expect(webAdminUrl('10.0.0.1', [svc('www-ssl', '443', 'true'), svc('www-ssl', '9443', 'false', { certificate: 'c' })]).url)
      .toBe('https://10.0.0.1:9443/');
  });
});
