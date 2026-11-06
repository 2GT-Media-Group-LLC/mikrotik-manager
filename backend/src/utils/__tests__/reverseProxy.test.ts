import {
  reverseProxySupport, rulesFrom, serviceFrom, portClash, movePortError, sniError, certCovers, certsFrom, checkRule,
  acmeCertName, acmeNameError, acmePhase, acmeCertsFrom,
} from '../reverseProxy';

const services: Record<string, string>[] = [
  { '.id': '*6', name: 'www-ssl', port: '443', certificate: 'mtm-20261029-54c09b', disabled: 'false' },
  { '.id': '*A', name: 'reverse-proxy', port: '443', certificate: 'none', disabled: 'false', invalid: 'false' },
  { '.id': '*1', name: 'api-ssl', port: '8729', disabled: 'false' },
  { '.id': '*2', name: 'www', port: '80', disabled: 'true' },
];

describe('support', () => {
  it('needs 7.22 and not SMIPS', () => {
    expect(reverseProxySupport('7.25.1', 'arm')).toBe('supported');
    expect(reverseProxySupport('7.22', 'arm64')).toBe('supported');
    expect(reverseProxySupport('7.21.3', 'arm')).toBe('too-old');
    expect(reverseProxySupport('7.25', 'smips')).toBe('unsupported');
    expect(reverseProxySupport(null, 'arm')).toBe('unknown');
  });
});

describe('services', () => {
  it('finds the clash with WebFig on 443', () => {
    const s = serviceFrom(services);
    expect(s).toMatchObject({ port: 443, certificate: null, disabled: false, wwwSslPort: 443, wwwSslDisabled: false });
    expect(portClash(s)).toBe(true);
    expect(portClash(serviceFrom(services.map((x) => (x.name === 'www-ssl' ? { ...x, port: '8443' } : x))))).toBe(false);
    expect(portClash(serviceFrom(services.map((x) => (x.name === 'www-ssl' ? { ...x, disabled: 'true' } : x))))).toBe(false);
  });

  it('picks a free port for a move', () => {
    expect(movePortError(services, 'www-ssl', 8443)).toBeNull();
    expect(movePortError(services, 'www-ssl', 443)).toMatch(/reverse-proxy/);
    expect(movePortError(services, 'reverse-proxy', 8729)).toMatch(/api-ssl/);
    // A disabled service doesn't hold its port.
    expect(movePortError(services, 'www-ssl', 80)).toBeNull();
    expect(movePortError(services, 'www-ssl', 70000)).toMatch(/1 to 65535/);
    // With no enabled rule the proxy isn't listening, so WebFig can have 443 back.
    expect(movePortError(services, 'www-ssl', 443, false)).toBeNull();
    expect(movePortError(services, 'reverse-proxy', 443, false)).toBeNull();
    expect(movePortError(services, 'reverse-proxy', 443, true)).toMatch(/www-ssl/);
    expect(movePortError(services, 'reverse-proxy', 8729, false)).toMatch(/api-ssl/);
  });
});

describe('host names and certificates', () => {
  it('takes exact host names only', () => {
    expect(sniError('nas.example.com')).toBeNull();
    expect(sniError('NAS.Example.com.')).toBeNull();
    expect(sniError('*.example.com')).toMatch(/exactly/);
    expect(sniError('192.168.88.10')).toMatch(/not an IP/);
    expect(sniError('bad_name.example.com')).toMatch(/valid/);
    expect(sniError('')).toMatch(/Enter/);
  });

  it('matches certificate names as browsers do', () => {
    expect(certCovers('nas.example.com', 'x', 'DNS:nas.example.com,IP:10.0.0.1')).toBe(true);
    expect(certCovers('nas.example.com', 'x', 'DNS:*.example.com')).toBe(true);
    expect(certCovers('a.b.example.com', 'x', 'DNS:*.example.com')).toBe(false);
    expect(certCovers('nas.example.com', 'nas.example.com', '')).toBe(true);
    // With DNS names present, the common name doesn't count.
    expect(certCovers('nas.example.com', 'nas.example.com', 'DNS:other.example.com')).toBe(false);
    expect(certCovers('nas.example.com', '192.168.0.51', 'IP:192.168.0.51')).toBe(false);
  });
});

describe('rules', () => {
  const certs = certsFrom([
    { name: 'nas', 'common-name': 'nas.example.com', 'subject-alt-name': 'DNS:nas.example.com', 'private-key': 'true', expired: 'false' },
    { name: 'mtm-ca', 'common-name': 'MikroTik Manager CA', 'private-key': 'false' },
    { name: 'old', 'common-name': 'nas.example.com', 'private-key': 'true', expired: 'true' },
  ]);
  const ctx = { certs, vrfs: ['main'] };

  it('reads rules field by field', () => {
    expect(rulesFrom([{ '.id': '*1', sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: '8080', certificate: 'none', disabled: 'false' },
      { '.id': '*2', sni: 'app.local', 'ip-address': '172.17.0.2', port: '80', dynamic: 'true' }]))
      .toEqual([
        { id: '*1', sni: 'nas.example.com', ipAddress: '192.168.88.10', port: 8080, certificate: null, vrf: null, comment: null, disabled: false, dynamic: false },
        { id: '*2', sni: 'app.local', ipAddress: '172.17.0.2', port: 80, certificate: null, vrf: null, comment: null, disabled: false, dynamic: true },
      ]);
  });

  it('builds a rule', () => {
    expect(checkRule({ sni: 'NAS.example.com', 'ip-address': '192.168.88.10', port: 8080, certificate: 'nas', comment: 'Synology' }, ctx))
      .toEqual({ params: { sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: '8080', certificate: 'nas', comment: 'Synology' }, errors: {} });
    expect(checkRule({ sni: 'nas.example.com', 'ip-address': 'fd00::10', port: 80, certificate: '' }, ctx).params.certificate).toBe('none');
  });

  it('refuses a certificate the browser would refuse', () => {
    const e = (c: string) => checkRule({ sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: 8080, certificate: c }, ctx).errors.certificate;
    expect(e('mtm-ca')).toMatch(/no private key/);
    expect(e('old')).toMatch(/expired/);
    expect(e('missing')).toMatch(/isn't a certificate/);
    expect(checkRule({ sni: 'cam.example.com', 'ip-address': '192.168.88.11', port: 80, certificate: 'nas' }, ctx).errors.certificate).toMatch(/isn't for cam/);
  });

  it('checks every field, and an edit keeps what it leaves out', () => {
    const r = checkRule({ sni: '*.x.com', 'ip-address': 'nas', port: 0, vrf: 'red', comment: 'a\nb', disabled: 'maybe' }, ctx);
    expect(Object.keys(r.errors).sort()).toEqual(['comment', 'disabled', 'ip-address', 'port', 'sni', 'vrf']);
    const existing = rulesFrom([{ '.id': '*1', sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: '8080' }])[0];
    expect(checkRule({ disabled: true }, { ...ctx, existing })).toEqual({ params: { disabled: 'yes' }, errors: {} });
    // The certificate is checked against the rule's own name when only it changes.
    expect(checkRule({ certificate: 'nas' }, { ...ctx, existing }).params).toEqual({ certificate: 'nas' });
  });
});

describe('Let\'s Encrypt (#358)', () => {
  // Captured from RouterOS 7.25.1 against the staging server.
  const failed = { '.id': '*7', name: 'mtm-le-staging-nas.example.org', 'domain-names': 'nas.example.org', 'acme-managed': 'true', issued: 'false', 'private-key': 'false',
    'directory-url': 'https://acme-staging-v02.api.letsencrypt.org/directory', 'acme-status': 'http-01 challenge validation failed, urn:ietf:params:acme:error:dns - no valid A records found for nas.example.org' };
  it('names certificates per host name and server', () => {
    expect(acmeCertName('NAS.example.org', true)).toBe('mtm-le-staging-nas.example.org');
    expect(acmeCertName('nas.example.org', false)).toBe('mtm-le-nas.example.org');
  });
  it('only takes public names', () => {
    expect(acmeNameError('nas.example.org')).toBeNull();
    expect(acmeNameError('nas.lan')).toMatch(/internal/);
    expect(acmeNameError('nas.home.arpa')).toMatch(/internal/);
    expect(acmeNameError('nas')).toMatch(/full public name/);
    expect(acmeNameError('*.example.org')).toMatch(/exactly/);
  });
  it('reads the request\'s progress', () => {
    expect(acmePhase({ ...failed, 'acme-status': 'generating private key' })).toBe('pending');
    expect(acmePhase({ ...failed, 'acme-status': 'requesting validation' })).toBe('pending');
    expect(acmePhase(failed)).toBe('failed');
    expect(acmePhase({ ...failed, issued: 'true', 'private-key': 'true', 'acme-status': '' })).toBe('issued');
    expect(acmeCertsFrom([failed, { name: 'other', 'private-key': 'true' }])).toEqual([
      { id: '*7', name: 'mtm-le-staging-nas.example.org', domain: 'nas.example.org', staging: true, phase: 'failed', status: failed['acme-status'], invalidAfter: null },
    ]);
  });
});
