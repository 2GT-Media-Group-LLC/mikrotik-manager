/**
 * The manager's own certificate authority (#200): making or importing a CA,
 * and issuing device certificates from it. Pure apart from key generation, so
 * it is tested without a device.
 *
 * Choices, and why:
 * - RSA 2048 for device keys: every RouterOS version imports it, and api-ssl
 *   and www-ssl serve it. An imported CA may be RSA or ECDSA; device
 *   certificates are signed with whatever key the CA has.
 * - No name constraints on a CA the manager makes: RouterOS 7 silently refuses
 *   to import a CA with critical name constraints (reported fixed in 7.11 and
 *   seen again in 7.24). An imported CA that has them gets a warning.
 * - pathLen 0: the manager's CA signs device certificates only, never another CA.
 * - The device key leaves the manager once, encrypted with a one-time
 *   passphrase, and is not kept: renewal makes a new key.
 */
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto, createPrivateKey, randomBytes, X509Certificate, KeyObject } from 'crypto';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
import { isIP } from 'net';

x509.cryptoProvider.set(webcrypto as never);

const subtle = webcrypto.subtle;
const RSA_GEN = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as const;
const DAY_MS = 86_400_000;
/** Back-dated a little so a device whose clock is slightly behind still accepts it. */
const BACKDATE_MS = 10 * 60_000;

export interface CaMaterial {
  certPem: string;
  /** PKCS#8 PEM, unencrypted: callers encrypt it before storing. */
  keyPem: string;
}

export interface CaInfo {
  subject: string;
  commonName: string;
  /** SHA-256, lowercase hex, no separators (as RouterOS prints it). */
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
  keyType: string;
}

export interface IssuedCert {
  certPem: string;
  /** PKCS#8 PEM encrypted with `passphrase` (AES-256-CBC). */
  keyPemEncrypted: string;
  passphrase: string;
  serial: string;
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
  sans: string[];
}

export class PkiError extends Error {}

/** A positive serial: 16 random bytes with the top bit clear. */
function serial(): string {
  const b = randomBytes(16);
  b[0] &= 0x7f;
  if (b[0] === 0) b[0] = 1;
  return b.toString('hex');
}

const fp = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

/** X.500 name escaping for a value in "CN=…, O=…". */
function rdn(v: string): string {
  return v.trim().replace(/([,+"\\<>;=#])/g, '\\$1');
}

function signingAlgorithm(key: CryptoKey): webcrypto.RsaHashedImportParams | webcrypto.EcdsaParams {
  return key.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
}

/** Import a PEM private key (PKCS#8, PKCS#1 or SEC1, optionally encrypted) for signing. */
async function importSigningKey(keyPem: string, passphrase?: string): Promise<CryptoKey> {
  let ko: KeyObject;
  try {
    ko = createPrivateKey(passphrase ? { key: keyPem, passphrase } : { key: keyPem });
  } catch (e) {
    const msg = (e as Error).message;
    // Without a passphrase OpenSSL reports an encrypted key as "interrupted or cancelled".
    if (/passphrase|decrypt|interrupted|cancelled/i.test(msg) || /ENCRYPTED/.test(keyPem)) {
      throw new PkiError('The private key is encrypted and the passphrase is missing or wrong.');
    }
    throw new PkiError(`The private key could not be read (${msg}).`);
  }
  const der = ko.export({ format: 'der', type: 'pkcs8' });
  const type = ko.asymmetricKeyType;
  if (type === 'rsa') return subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  if (type === 'ec') {
    const curve = ko.asymmetricKeyDetails?.namedCurve;
    const named = curve === 'prime256v1' ? 'P-256' : curve === 'secp384r1' ? 'P-384' : curve === 'secp521r1' ? 'P-521' : null;
    if (!named) throw new PkiError(`The CA key uses the curve ${curve}, which isn't supported. Use P-256, P-384, P-521 or RSA.`);
    return subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: named }, false, ['sign']);
  }
  throw new PkiError(`The CA key is ${type}; only RSA and ECDSA CA keys are supported.`);
}

export function caInfo(certPem: string): CaInfo {
  const c = new X509Certificate(certPem);
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(c.subject)?.[1] ?? c.subject;
  return {
    subject: c.subject.replace(/\n/g, ', '),
    commonName: cn,
    fingerprint: fp(certPem),
    notBefore: new Date(c.validFrom),
    notAfter: new Date(c.validTo),
    keyType: c.publicKey.asymmetricKeyType === 'ec' ? 'ECDSA' : `RSA ${c.publicKey.asymmetricKeyDetails?.modulusLength ?? ''}`.trim(),
  };
}

/** Create a CA. */
export async function createCa(opts: { commonName: string; organization?: string; days: number }): Promise<CaMaterial> {
  const cn = opts.commonName.trim();
  if (!cn) throw new PkiError('The CA needs a name.');
  const keys = await subtle.generateKey(RSA_GEN, true, ['sign', 'verify']) as CryptoKeyPair;
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=${rdn(cn)}${opts.organization?.trim() ? `, O=${rdn(opts.organization)}` : ''}`,
    notBefore: new Date(now - BACKDATE_MS),
    notAfter: new Date(now + opts.days * DAY_MS),
    keys,
    signingAlgorithm: RSA_GEN,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', keys.privateKey));
  return {
    certPem: `${cert.toString('pem')}\n`,
    keyPem: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }) as string,
  };
}

export interface ImportedCa extends CaMaterial {
  warnings: string[];
}

/**
 * Check an existing CA (an organisation's root or intermediate) and return it
 * with an unencrypted PKCS#8 key. Refuses anything that can't sign device
 * certificates; warns about what RouterOS or clients may trip on.
 */
export async function importCa(certPem: string, keyPem: string, passphrase?: string): Promise<ImportedCa> {
  const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(certPem)?.[0];
  if (!pem) throw new PkiError('That isn\'t a PEM certificate (it should start with -----BEGIN CERTIFICATE-----).');
  let cert: x509.X509Certificate;
  let node: X509Certificate;
  try {
    cert = new x509.X509Certificate(pem);
    node = new X509Certificate(pem);
  } catch (e) {
    throw new PkiError(`The certificate could not be read (${(e as Error).message}).`);
  }
  const bc = cert.getExtension(x509.BasicConstraintsExtension);
  if (!bc?.ca) throw new PkiError('That certificate is not a CA (its basic constraints don\'t allow signing certificates).');
  const ku = cert.getExtension(x509.KeyUsagesExtension);
  if (ku && !(ku.usages & x509.KeyUsageFlags.keyCertSign)) throw new PkiError('That CA\'s key usage doesn\'t include certificate signing.');
  if (new Date(node.validTo).getTime() < Date.now()) throw new PkiError('That CA has expired.');

  const signingKey = await importSigningKey(keyPem, passphrase);
  const ko = createPrivateKey(passphrase ? { key: keyPem, passphrase } : { key: keyPem });
  if (!node.checkPrivateKey(ko)) throw new PkiError('The private key doesn\'t belong to that certificate.');
  void signingKey;

  const warnings: string[] = [];
  const nc = cert.extensions.find((e) => e.type === '2.5.29.30');
  if (nc) {
    warnings.push(nc.critical
      ? 'This CA has critical name constraints. RouterOS 7 has been seen refusing to import such a CA, so issuing may fail on some devices.'
      : 'This CA has name constraints; device certificates must fall within them or clients will reject them.');
  }
  if (bc.pathLength !== undefined && bc.pathLength < 0) warnings.push('This CA has an unusual path length constraint.');
  const daysLeft = (new Date(node.validTo).getTime() - Date.now()) / DAY_MS;
  if (daysLeft < 90) warnings.push(`This CA expires in ${Math.floor(daysLeft)} days; device certificates can't outlive it.`);
  return {
    certPem: `${pem}\n`,
    keyPem: ko.export({ format: 'pem', type: 'pkcs8' }) as string,
    warnings,
  };
}

/**
 * Subject alternative names for a device: its management address, plus any
 * extra names given. IPs become IP entries, anything else DNS entries.
 */
export function deviceSans(address: string, extra: string[] = []): string[] {
  const out: string[] = [];
  for (const raw of [address, ...extra]) {
    const v = raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (!v || out.includes(v)) continue;
    if (!isIP(v) && !/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v)) {
      throw new PkiError(`"${raw.trim()}" isn't an IP address or a DNS name.`);
    }
    out.push(v);
  }
  if (!out.length) throw new PkiError('A device certificate needs at least one name.');
  return out;
}

/** Issue a device certificate from the CA. Its validity is capped at the CA's own expiry. */
export async function issueDeviceCert(opts: {
  ca: CaMaterial; commonName: string; sans: string[]; days: number;
}): Promise<IssuedCert> {
  const caCert = new x509.X509Certificate(opts.ca.certPem);
  const caKey = await importSigningKey(opts.ca.keyPem);
  const keys = await subtle.generateKey(RSA_GEN, true, ['sign', 'verify']) as CryptoKeyPair;
  const now = Date.now();
  const caEnd = caCert.notAfter.getTime();
  const notAfter = new Date(Math.min(now + opts.days * DAY_MS, caEnd));
  if (notAfter.getTime() <= now) throw new PkiError('The CA has expired, so it can\'t issue certificates.');
  const cn = opts.commonName.trim().slice(0, 64) || opts.sans[0];
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${rdn(cn)}`,
    issuer: caCert.subject,
    notBefore: new Date(now - BACKDATE_MS),
    notAfter,
    publicKey: keys.publicKey,
    signingKey: caKey,
    signingAlgorithm: signingAlgorithm(caKey),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(opts.sans.map((v) => (isIP(v) ? { type: 'ip' as const, value: v } : { type: 'dns' as const, value: v }))),
      // The CA's own key identifier when it has one: an imported CA may not
      // compute it the usual way, and clients match on the exact bytes.
      caCert.getExtension(x509.SubjectKeyIdentifierExtension)
        ? new x509.AuthorityKeyIdentifierExtension(caCert.getExtension(x509.SubjectKeyIdentifierExtension)!.keyId)
        : await x509.AuthorityKeyIdentifierExtension.create(caCert, false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const certPem = `${cert.toString('pem')}\n`;
  const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', keys.privateKey));
  const passphrase = randomBytes(24).toString('base64url');
  return {
    certPem,
    keyPemEncrypted: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
      .export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase }) as string,
    passphrase,
    serial: cert.serialNumber,
    fingerprint: fp(certPem),
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    sans: opts.sans,
  };
}

/** Was `leafDer` (a certificate a device presented) signed by this CA? */
export function signedBy(leafDer: Buffer, caCertPem: string): boolean {
  try {
    const leaf = new X509Certificate(leafDer);
    const ca = new X509Certificate(caCertPem);
    return leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
  } catch {
    return false;
  }
}
