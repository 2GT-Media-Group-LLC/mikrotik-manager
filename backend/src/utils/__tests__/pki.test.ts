// '../pki' first: it loads the reflect-metadata polyfill @peculiar/x509 needs.
import { createCa, importCa, issueDeviceCert, deviceSans, signedBy, caInfo, PkiError } from '../pki';
import * as x509 from '@peculiar/x509';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'crypto';

jest.setTimeout(30_000);

describe('the manager CA (#200)', () => {
  let ca: { certPem: string; keyPem: string };
  beforeAll(async () => { ca = await createCa({ commonName: 'Test CA', organization: 'Acme, Inc.', days: 3650 }); });

  it('makes a CA that can only sign end certificates, with no name constraints', () => {
    const c = new x509.X509Certificate(ca.certPem);
    const bc = c.getExtension(x509.BasicConstraintsExtension)!;
    expect(bc.ca).toBe(true);
    expect(bc.pathLength).toBe(0);
    expect(c.getExtension(x509.KeyUsagesExtension)!.usages & x509.KeyUsageFlags.keyCertSign).toBeTruthy();
    // RouterOS refuses CAs with critical name constraints.
    expect(c.extensions.find((e) => e.type === '2.5.29.30')).toBeUndefined();
    const info = caInfo(ca.certPem);
    expect(info.commonName).toBe('Test CA');
    expect(info.subject).toContain('O=Acme\\, Inc.');
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issues a device certificate the CA verifies, with the names and usages api-ssl needs', async () => {
    const issued = await issueDeviceCert({ ca, commonName: 'core-sw', sans: deviceSans('192.168.0.51', ['sw1.example.net']), days: 365 });
    const leaf = new X509Certificate(issued.certPem);
    expect(leaf.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
    expect(signedBy(leaf.raw, ca.certPem)).toBe(true);
    expect(leaf.subjectAltName).toContain('IP Address:192.168.0.51');
    expect(leaf.subjectAltName).toContain('DNS:sw1.example.net');
    expect(leaf.checkIP('192.168.0.51')).toBe('192.168.0.51');
    expect(leaf.ca).toBe(false);
    expect(issued.fingerprint).toBe(leaf.fingerprint256.replace(/:/g, '').toLowerCase());
    const days = (new Date(leaf.validTo).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(365);
    // The key is encrypted with the one-time passphrase, and matches the certificate.
    expect(issued.keyPemEncrypted).toContain('ENCRYPTED PRIVATE KEY');
    expect(() => createPrivateKey({ key: issued.keyPemEncrypted, passphrase: 'wrong' })).toThrow();
    expect(leaf.checkPrivateKey(createPrivateKey({ key: issued.keyPemEncrypted, passphrase: issued.passphrase }))).toBe(true);
  });

  it('caps a device certificate at the CA\'s own expiry', async () => {
    const short = await createCa({ commonName: 'Short CA', days: 30 });
    const issued = await issueDeviceCert({ ca: short, commonName: 'x', sans: ['10.0.0.1'], days: 365 });
    expect(issued.notAfter.getTime()).toBeLessThanOrEqual(new X509Certificate(short.certPem).validToDate.getTime());
  });

  it('a certificate from another CA is not signed by this one', async () => {
    const other = await createCa({ commonName: 'Other', days: 365 });
    const issued = await issueDeviceCert({ ca: other, commonName: 'x', sans: ['10.0.0.1'], days: 30 });
    expect(signedBy(new X509Certificate(issued.certPem).raw, ca.certPem)).toBe(false);
  });
});

describe('importing an existing CA', () => {
  it('accepts a CA with its key, encrypted or not, and issues from it', async () => {
    const made = await createCa({ commonName: 'Corp Root', days: 3650 });
    const encrypted = createPrivateKey(made.keyPem).export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 's3cret' }) as string;
    await expect(importCa(made.certPem, encrypted)).rejects.toThrow(/passphrase/);
    const imported = await importCa(made.certPem, encrypted, 's3cret');
    expect(imported.warnings).toEqual([]);
    const issued = await issueDeviceCert({ ca: imported, commonName: 'r1', sans: ['r1.corp'], days: 90 });
    expect(signedBy(new X509Certificate(issued.certPem).raw, made.certPem)).toBe(true);
  });

  it('signs with an ECDSA CA key', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    x509.cryptoProvider.set(crypto as never);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01', name: 'CN=EC Root', notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000 * 365),
      keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)],
    });
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    const keyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }) as string;
    const imported = await importCa(cert.toString('pem'), keyPem);
    const issued = await issueDeviceCert({ ca: imported, commonName: 'r2', sans: ['10.1.1.1'], days: 30 });
    expect(signedBy(new X509Certificate(issued.certPem).raw, imported.certPem)).toBe(true);
  });

  it('refuses a certificate that is not a CA, and a key that does not match', async () => {
    const made = await createCa({ commonName: 'Root', days: 365 });
    const leaf = await issueDeviceCert({ ca: made, commonName: 'leaf', sans: ['10.0.0.9'], days: 30 });
    const leafKey = createPrivateKey({ key: leaf.keyPemEncrypted, passphrase: leaf.passphrase }).export({ format: 'pem', type: 'pkcs8' }) as string;
    await expect(importCa(leaf.certPem, leafKey)).rejects.toThrow(/not a CA/);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(importCa(made.certPem, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string)).rejects.toThrow(/doesn't belong/);
    await expect(importCa('not a cert', made.keyPem)).rejects.toThrow(PkiError);
  });

  it('warns about critical name constraints, which RouterOS may refuse', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 }, true, ['sign', 'verify']);
    x509.cryptoProvider.set(crypto as never);
    // nameConstraints, permitted DNS ".corp" (DER), marked critical.
    const ncValue = Buffer.from('300ba009300786052e636f7270', 'hex');
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '02', name: 'CN=Constrained', notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000 * 365),
      keys, signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.Extension('2.5.29.30', true, ncValue)],
    });
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    const keyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }) as string;
    const imported = await importCa(cert.toString('pem'), keyPem);
    expect(imported.warnings.join(' ')).toMatch(/critical name constraints/);
  });
});

describe('device names', () => {
  it('turns addresses and names into SANs, once each', () => {
    expect(deviceSans('192.168.0.51', ['SW1.example.net', '192.168.0.51', ' fd00::1 '])).toEqual(['192.168.0.51', 'sw1.example.net', 'fd00::1']);
    expect(deviceSans('[fd00::2]')).toEqual(['fd00::2']);
  });
  it('refuses junk', () => {
    expect(() => deviceSans('10.0.0.1', ['not a name'])).toThrow(PkiError);
    expect(() => deviceSans('')).toThrow(PkiError);
  });
});
