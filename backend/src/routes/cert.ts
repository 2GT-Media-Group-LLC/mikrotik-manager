import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink } from 'fs/promises';
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
router.get('/', async (_req: Request, res: Response) => {
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
router.post('/regenerate', requireAdmin, async (_req: Request, res: Response) => {
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
router.post('/upload', requireAdmin, async (req: Request, res: Response) => {
  const { certificate, private_key } = req.body as { certificate?: string; private_key?: string };

  if (!certificate || !private_key) {
    return res.status(400).json({ error: 'Both certificate and private_key are required' });
  }

  // Validate PEM format
  if (!certificate.includes('-----BEGIN CERTIFICATE-----')) {
    return res.status(400).json({ error: 'certificate does not appear to be a valid PEM certificate' });
  }
  if (!private_key.includes('-----BEGIN')) {
    return res.status(400).json({ error: 'private_key does not appear to be a valid PEM key' });
  }

  // Parse the certificate
  let certInfo;
  try {
    certInfo = parseCertInfo(certificate);
  } catch {
    return res.status(400).json({ error: 'Failed to parse certificate — ensure it is valid PEM format' });
  }

  // Verify the private key matches the certificate's public key
  try {
    const certObj = new crypto.X509Certificate(certificate);
    const privKey = crypto.createPrivateKey(private_key);
    const certPubKey = certObj.publicKey;

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
    await writeFile(tmpCert, certificate.trim() + '\n', { mode: 0o644 });
    await writeFile(tmpKey,  private_key.trim() + '\n', { mode: 0o600 });

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
