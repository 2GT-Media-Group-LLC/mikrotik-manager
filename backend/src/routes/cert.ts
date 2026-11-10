import { parseCertificateBundle, parsePrivateKey } from '../utils/pemBundle';
import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink, rename } from 'fs/promises';
import { existsSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { requireAuth, requireAdmin } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

const execFileAsync = promisify(execFile);

const CERTS_DIR = '/certs';
const CERT_PATH = path.join(CERTS_DIR, 'server.crt');
const KEY_PATH  = path.join(CERTS_DIR, 'server.key');
const ACME_SETTINGS_PATH = path.join(CERTS_DIR, 'acme-settings.conf');
const ACME_CA_BUNDLE_PATH = path.join(CERTS_DIR, 'acme-ca-bundle.crt');
const ACME_STATUS_PATH = path.join(CERTS_DIR, 'acme-last-attempt');
const DEFAULT_ACME_SERVER = 'https://acme-v02.api.letsencrypt.org/directory';

type AcmeSettings = { domain: string; email: string; server: string };

function acmeEnvironmentLocked(): boolean {
  return [process.env.ACME_DOMAIN, process.env.ACME_EMAIL, process.env.ACME_SERVER]
    .every((value) => !!value?.trim());
}

function environmentAcmeSettings(): AcmeSettings {
  return {
    domain: process.env.ACME_DOMAIN ?? '',
    email: process.env.ACME_EMAIL ?? '',
    server: process.env.ACME_SERVER || DEFAULT_ACME_SERVER,
  };
}

async function readAcmeSettings(): Promise<AcmeSettings & { source: 'web' | 'environment'; readOnly: boolean }> {
  if (acmeEnvironmentLocked()) return { ...environmentAcmeSettings(), source: 'environment', readOnly: true };
  try {
    const lines = (await readFile(ACME_SETTINGS_PATH, 'utf8')).split('\n').filter(Boolean);
    const entries = lines.map((line) => {
      const separator = line.indexOf('=');
      if (separator < 0) throw new Error('Invalid ACME settings file');
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
    const values = new Map(entries);
    if (entries.length !== 3 || values.size !== 3 || !values.has('ACME_DOMAIN') || !values.has('ACME_EMAIL') || !values.has('ACME_SERVER')) {
      throw new Error('Invalid ACME settings file');
    }
    return {
      domain: values.get('ACME_DOMAIN')!,
      email: values.get('ACME_EMAIL')!,
      server: values.get('ACME_SERVER')!,
      source: 'web',
      readOnly: false,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { ...environmentAcmeSettings(), source: 'environment', readOnly: false };
  }
}

function parseAcmeSettings(raw: unknown): AcmeSettings | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'ACME settings must be an object.';
  const input = raw as Record<string, unknown>;
  if (typeof input.domain !== 'string' || (input.email !== undefined && typeof input.email !== 'string') || typeof input.server !== 'string') {
    return 'Domain and ACME directory URL must be strings; email must be a string if provided.';
  }
  const domain = input.domain.trim().toLowerCase();
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const server = input.server.trim() || DEFAULT_ACME_SERVER;

  if (!domain) return 'A domain is required.';
  if ([...server].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return 'The ACME directory URL cannot contain control characters.';
  }
  if (domain) {
    const labels = domain.split('.');
    if (domain.length > 253 || labels.length < 2 || labels.some((label) =>
      label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      return 'Enter a valid DNS name, such as manager.example.com.';
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return 'Enter a valid contact email address.';
    }
  }
  try {
    const url = new URL(server);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
      return 'The ACME directory URL must be an HTTPS URL without credentials or a fragment.';
    }
  } catch {
    return 'Enter a valid HTTPS ACME directory URL.';
  }
  return { domain, email, server };
}

async function writeAcmeSettings(settings: AcmeSettings): Promise<void> {
  const tmp = `${ACME_SETTINGS_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `ACME_DOMAIN=${settings.domain}\nACME_EMAIL=${settings.email}\nACME_SERVER=${settings.server}\n`, { mode: 0o600 });
    await rename(tmp, ACME_SETTINGS_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Certificate writes run one at a time so a cert and its key are always a pair. */
let installChain: Promise<void> = Promise.resolve();
function acquireInstallLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const ready = installChain.then(() => release);
  installChain = installChain.then(() => next);
  return ready;
}
const RELOAD_SIGNAL = path.join(CERTS_DIR, '.reload');

// GET /api/cert/acme — ACME settings for the manager's HTTPS certificate
router.get('/acme', requireAdmin, async (_req, res) => {
  res.json(await readAcmeSettings());
});

// GET /api/cert/acme/status — last completed Certbot attempt
router.get('/acme/status', requireAdmin, async (_req, res) => {
  const settings = await readAcmeSettings();
  if (!settings.domain.trim()) return res.json({ lastAttempt: null });
  let contents: string;
  try {
    contents = await readFile(ACME_STATUS_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.json({ lastAttempt: null });
    throw err;
  }
  const match = contents.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\n(issue|renew)\n(\d+)\n([^\r\n]+)\n([\s\S]*)$/);
  if (!match || Number(match[3]) > 255 || Number.isNaN(Date.parse(match[1]))) {
    throw new Error('Invalid ACME attempt status file');
  }
  return res.json({ lastAttempt: {
    time: match[1], action: match[2], exitCode: Number(match[3]), domain: match[4], output: match[5],
  } });
});

// PUT /api/cert/acme — persist settings in the shared certificate volume
router.put('/acme', requireAdmin, async (req, res) => {
  if (acmeEnvironmentLocked()) {
    return res.status(409).json({ error: 'ACME settings are read-only while all three ACME environment variables are set.' });
  }
  const settings = parseAcmeSettings(req.body);
  if (typeof settings === 'string') return res.status(400).json({ error: settings });
  await writeAcmeSettings(settings);
  return res.json({ message: 'ACME settings updated' });
});

// DELETE /api/cert/acme — return to the deployment's environment variables
router.delete('/acme', requireAdmin, async (_req, res) => {
  if (acmeEnvironmentLocked()) {
    return res.status(409).json({ error: 'ACME settings are read-only while all three ACME environment variables are set.' });
  }
  try {
    await unlink(ACME_SETTINGS_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!process.env.ACME_DOMAIN?.trim()) {
    try {
      await unlink(ACME_STATUS_PATH);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return res.json({ message: 'Using ACME environment settings' });
});

// GET /api/cert/acme/ca-bundle — whether a custom ACME trust bundle is installed
router.get('/acme/ca-bundle', requireAdmin, async (_req, res) => {
  try {
    await readFile(ACME_CA_BUNDLE_PATH);
    return res.json({ installed: true, readOnly: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return res.json({ installed: false, readOnly: false });
    }
    throw err;
  }
});

// PUT /api/cert/acme/ca-bundle — install only validated PEM certificates
router.put('/acme/ca-bundle', requireAdmin, async (req, res) => {
  const certificate = (req.body as { certificate?: unknown } | null)?.certificate;
  if (typeof certificate !== 'string' || Buffer.byteLength(certificate, 'utf8') > 1024 * 1024) {
    return res.status(400).json({ error: 'Provide a PEM certificate bundle no larger than 1 MB.' });
  }
  let pem: string;
  try {
    ({ pem } = parseCertificateBundle(certificate));
  } catch (err) {
    return res.status(400).json({ error: `Invalid CA bundle: ${err instanceof Error ? err.message : String(err)}` });
  }
  const tmp = `${ACME_CA_BUNDLE_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, pem, { mode: 0o644 });
    await rename(tmp, ACME_CA_BUNDLE_PATH);
  } catch (err) {
    await unlink(tmp).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== 'ENOENT') console.error('[acme] Could not remove temporary CA bundle:', cleanupError);
    });
    throw err;
  }
  return res.json({ message: 'ACME CA bundle installed' });
});

// DELETE /api/cert/acme/ca-bundle — return to Certbot's default trust store
router.delete('/acme/ca-bundle', requireAdmin, async (_req, res) => {
  try {
    await unlink(ACME_CA_BUNDLE_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return res.json({ message: 'ACME CA bundle removed' });
});

function parseCertInfo(pem: string) {
  const cert = new crypto.X509Certificate(pem);
  const now = new Date();
  const validTo = new Date(cert.validTo);
  const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86400000);
  const isSelfSigned = cert.subject === cert.issuer;

  // Extract CN from subject string like "CN=Mikrotik Manager, O=Self-Signed"
  const cnMatch = cert.subject.match(/CN=([^,\n]+)/);
  const cn = cnMatch ? cnMatch[1].trim() : cert.subject;

  const issuerCnMatch = cert.issuer.match(/CN=([^,\n]+)/);
  const issuerCn = issuerCnMatch ? issuerCnMatch[1].trim() : cert.issuer;

  return {
    subject: cn,
    subject_full: cert.subject,
    issuer: issuerCn,
    issuer_full: cert.issuer,
    serial_number: cert.serialNumber,
    valid_from: cert.validFrom,
    valid_to: cert.validTo,
    days_remaining: daysLeft,
    is_self_signed: isSelfSigned,
    san: cert.subjectAltName || null,
  };
}

// GET /api/cert — current certificate info
router.get('/', async (_req, res) => {
  if (!existsSync(CERT_PATH)) {
    return res.json({ exists: false });
  }
  try {
    const pem = await readFile(CERT_PATH, 'utf8');
    return res.json({ exists: true, ...parseCertInfo(pem) });
  } catch {
    return res.json({ exists: false });
  }
});

// POST /api/cert/regenerate — generate a fresh self-signed certificate
router.post('/regenerate', requireAdmin, async (_req, res) => {
  // Same lock as upload, so a regenerate can't interleave with an upload.
  const release = await acquireInstallLock();
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-nodes', '-days', '3650',
      '-newkey', 'rsa:2048',
      '-keyout', KEY_PATH,
      '-out', CERT_PATH,
      '-subj', '/CN=Mikrotik Manager/O=Self-Signed/OU=Local/C=US',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ], { timeout: 30000 });

    // Signal nginx to reload
    await writeFile(RELOAD_SIGNAL, '');

    const pem = await readFile(CERT_PATH, 'utf8');
    return res.json({ message: 'Self-signed certificate regenerated', ...parseCertInfo(pem) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to generate certificate: ${msg}` });
  } finally {
    release();
  }
});

// POST /api/cert/upload — install a custom certificate and private key
router.post('/upload', requireAdmin, async (req, res) => {
  const { certificate, private_key } = req.body as { certificate?: string; private_key?: string };

  if (!certificate || !private_key) {
    return res.status(400).json({ error: 'Both certificate and private_key are required' });
  }

  // Every block checked, not just the first (GHSA-28hr-v457-cc6g): the whole
  // field goes into nginx's certificate file.
  let bundle: ReturnType<typeof parseCertificateBundle>;
  let keyPem: string;
  let privKey: crypto.KeyObject;
  try {
    bundle = parseCertificateBundle(certificate);
  } catch (err) {
    return res.status(400).json({ error: `certificate: ${(err as Error).message}` });
  }
  try {
    ({ pem: keyPem, key: privKey } = parsePrivateKey(private_key));
  } catch (err) {
    return res.status(400).json({ error: `private_key: ${(err as Error).message}` });
  }

  // Parse the certificate
  let certInfo;
  try {
    certInfo = parseCertInfo(bundle.pem);
  } catch {
    return res.status(400).json({ error: 'Failed to parse certificate — ensure it is valid PEM format' });
  }

  // Verify the private key matches the certificate's public key (the leaf, first)
  try {
    const certPubKey = bundle.certs[0].publicKey;

    // Sign test data with private key, verify with cert's public key
    const sign = crypto.createSign('SHA256');
    sign.update('mikrotik-manager-cert-verify');
    const signature = sign.sign(privKey);

    const verify = crypto.createVerify('SHA256');
    verify.update('mikrotik-manager-cert-verify');
    const matches = verify.verify(certPubKey, signature);

    if (!matches) {
      return res.status(400).json({ error: 'Private key does not match the certificate' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: `Key/certificate validation failed: ${msg}` });
  }

  // Write files atomically (write to temp, then rename). Installs run one at a
  // time: two uploads sharing the '.tmp' files could put one upload's
  // certificate next to the other's key (outside review S10).
  const tmpCert = CERT_PATH + '.tmp';
  const tmpKey  = KEY_PATH + '.tmp';
  const release = await acquireInstallLock();
  try {
    // Rebuilt from the parsed blocks, never the pasted text as-is.
    await writeFile(tmpCert, bundle.pem, { mode: 0o644 });
    await writeFile(tmpKey,  keyPem, { mode: 0o600 });

    // Rename into place
    const { rename } = await import('fs/promises');
    await rename(tmpCert, CERT_PATH);
    await rename(tmpKey, KEY_PATH);

    // Signal nginx to reload
    await writeFile(RELOAD_SIGNAL, '');

    return res.json({ message: 'Certificate installed successfully', ...certInfo });
  } catch (err) {
    // Clean up temp files if they exist
    await unlink(tmpCert).catch(() => {});
    await unlink(tmpKey).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to write certificate: ${msg}` });
  } finally {
    release();
  }
});

export default router;
