import { dohServerError } from '../dnsDoh';

describe('dohServerError (#468)', () => {
  it('accepts an https URL or empty to turn DoH off', () => {
    expect(dohServerError('https://cloudflare-dns.com/dns-query')).toBeNull();
    expect(dohServerError('https://1.1.1.1/dns-query')).toBeNull();
    expect(dohServerError('https://dns.example.com:8443/dns-query')).toBeNull();
    expect(dohServerError('')).toBeNull();
  });

  it('refuses anything that is not an https URL', () => {
    expect(dohServerError('http://cloudflare-dns.com/dns-query')).toMatch(/https/);
    expect(dohServerError('cloudflare-dns.com')).toMatch(/https/);
    expect(dohServerError(42)).toMatch(/text/);
    expect(dohServerError('https://a b/dns-query')).toMatch(/spaces/);
    expect(dohServerError('https://a.example/x,https://b.example')).toMatch(/commas/);
    expect(dohServerError('https://' + 'a'.repeat(260))).toMatch(/too long/);
    expect(dohServerError('https://')).not.toBeNull();
  });
});
