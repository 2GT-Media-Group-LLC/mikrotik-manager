import { createCa } from '../pki';
import { parseCertificateBundle, parsePrivateKey, pemBlocks } from '../pemBundle';

describe('certificate upload parsing (GHSA-28hr-v457-cc6g)', () => {
  let a: { certPem: string; keyPem: string };
  let b: { certPem: string; keyPem: string };
  beforeAll(async () => {
    a = await createCa({ commonName: 'leaf.example', days: 30 });
    b = await createCa({ commonName: 'chain.example', days: 30 });
  });

  it('accepts a leaf, and a leaf with its chain, and rebuilds the text', () => {
    expect(parseCertificateBundle(a.certPem).certs).toHaveLength(1);
    const both = parseCertificateBundle(`\n${a.certPem}\r\n${b.certPem}\n\n`);
    expect(both.certs).toHaveLength(2);
    expect(both.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(both.pem).not.toMatch(/\r/);
  });

  it('refuses anything after the first block that is not a certificate', () => {
    expect(() => parseCertificateBundle(a.certPem + a.keyPem)).toThrow(/private key, not a certificate/);
    expect(() => parseCertificateBundle(a.certPem + 'server { listen 80; }')).toThrow(/text outside/);
    const broken = b.certPem.replace(/\n[A-Za-z0-9+/]{20}/, '\n!!!!!!!!!!!!!!!!!!!!');
    expect(() => parseCertificateBundle(a.certPem + broken)).toThrow(/Block 2 isn't a valid certificate/);
    expect(() => parseCertificateBundle('')).toThrow(/No certificate/);
  });

  it('wants exactly one private key in the key field', () => {
    expect(parsePrivateKey(a.keyPem).key.type).toBe('private');
    expect(() => parsePrivateKey(a.keyPem + b.keyPem)).toThrow(/only the private key/);
    expect(() => parsePrivateKey(a.certPem)).toThrow(/not a private key/);
    expect(() => parsePrivateKey(a.keyPem + 'junk')).toThrow(/text outside/);
  });

  it('lists blocks with their labels', () => {
    expect(pemBlocks(a.certPem + a.keyPem).map((x) => x.label)).toEqual(['CERTIFICATE', 'PRIVATE KEY']);
  });
});
