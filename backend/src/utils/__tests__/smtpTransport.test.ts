import { smtpTransportOptions } from '../smtpTransport';

const base = { smtp_host: 'mail.example', smtp_user: 'u', smtp_pass: 'p' };

// GHSA-63v6-w7qf-349f: alert email didn't check the server's certificate.
describe('smtpTransportOptions', () => {
  it('checks the certificate, and requires STARTTLS before sending a login, by default', () => {
    const o = smtpTransportOptions(base);
    expect(o.tls).toEqual({ rejectUnauthorized: true });
    expect(o.requireTLS).toBe(true);
    expect(o.port).toBe(587);
    expect(o.auth).toEqual({ user: 'u', pass: 'p' });
  });

  it('does not ask for STARTTLS on port 465 (TLS from the start) or without a login', () => {
    expect(smtpTransportOptions({ ...base, smtp_secure: true, smtp_port: 465 }).requireTLS).toBe(false);
    expect(smtpTransportOptions({ smtp_host: 'relay.lan', smtp_port: 25 }).requireTLS).toBe(false);
  });

  it('lets a channel turn the check off for a self-signed server', () => {
    const o = smtpTransportOptions({ ...base, smtp_tls_verify: false });
    expect(o.tls).toEqual({ rejectUnauthorized: false });
    expect(o.requireTLS).toBe(false);
  });
});
