/**
 * Device certificates from the manager's own CA (#200).
 *
 * Optional: nothing happens until an admin sets up a CA, and each device is
 * enrolled on purpose. An enrolled device's api-ssl (and, if chosen, www-ssl)
 * serves a certificate the CA issued for its address, so the manager, scripts
 * and browsers that trust the CA can check it properly.
 *
 * Issuing to a device, in order:
 *   1. Make a key and certificate here; the key leaves once, encrypted with a
 *      one-time passphrase, and isn't kept.
 *   2. Upload the CA certificate (if the device doesn't have it), the device
 *      certificate and the key: over the API (`/file/add contents=`, RouterOS
 *      7.9 and later), or over SFTP where that isn't available. RouterOS
 *      removes the files once it has imported them.
 *   3. Import them, and confirm the certificate arrived with its key.
 *   4. Point api-ssl at it (moving a device still on the plain API to api-ssl
 *      at the same time), then prove it: a fresh login must succeed and the
 *      device must present exactly the certificate just issued. If not, api-ssl
 *      goes back to the certificate it had and the new one is removed.
 *   5. Point www-ssl at it too, if chosen; pin it; record it.
 *
 * While the switch happens, polls accept the new certificate as well as the
 * old one (expectTlsCertificate), so it doesn't raise a changed-identity alert.
 */
import { Client as SSHClient } from 'ssh2';
import { randomBytes, X509Certificate } from 'crypto';
import { isIP } from 'net';
import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import { API_SSL_PORT } from './mikrotik/apiConnect';
import { usesApiTls } from '../utils/apiTls';
import { configuredServices, allowedFrom, allowedFromKey } from '../utils/ipServices';
import { ensureCertificate } from './apiSsl';
import {
  createCa, importCa, issueDeviceCert, deviceSans, caInfo, signedBy, PkiError, type CaMaterial, type CaInfo,
} from '../utils/pki';
import { expectTlsCertificate, clearTlsExpectation, forgetIdentity, pinIdentity, IdentityMismatchError } from './identityPins';
import { resolveAuth } from './sshExec';
import { sshHostCheck, explainSshError } from './sshHostCheck';
import { alertService } from './AlertService';
import { logSafe } from '../utils/logSafe';


export const MIN_DAYS = 1;
export const MAX_DEVICE_DAYS = 3650;
export const CA_DAY_CHOICES = [1825, 3650, 7300] as const;

const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';
const normFp = (v: string | undefined) => (v ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();

export interface CaRow {
  cert_pem: string;
  key_encrypted: string;
  imported: boolean;
  default_days: number;
  renew_before_days: number;
  auto_renew: boolean;
  default_www: boolean;
  created_by: string | null;
  created_at: string;
}

export interface ManagedRow {
  device_id: number;
  cert_name: string;
  ca_cert_name: string | null;
  serial: string;
  fingerprint: string;
  ca_fingerprint: string;
  sans: string[];
  extra_names: string[];
  days: number;
  apply_www: boolean;
  not_before: string;
  not_after: string;
  previous_api_cert: string | null;
  previous_www_cert: string | null;
  last_error: string | null;
  last_attempt_at: string | null;
  issued_at: string;
  renewed_at: string | null;
}

export interface CaDevice {
  id: number;
  name: string;
  ip_address: string;
  api_port: number;
  api_tls: boolean | null;
  api_username: string;
  api_password_encrypted: string;
  ssh_port: number | null;
  ssh_username: string | null;
  ssh_password_encrypted: string | null;
}

export interface CertResult {
  ok: boolean;
  steps: string[];
  message: string;
}

// ─── The CA ────────────────────────────────────────────────────────────────

let caCache: { pem: string; info: CaInfo; at: number } | null = null;
/** How long the CA certificate is cached for connection checks. */
const CA_CACHE_MS = 60_000;
/** Drop the cached CA certificate (tests, and anything that changes device_ca directly). */
export function forgetCachedCa(): void { caCache = null; }

export async function loadCa(): Promise<CaRow | null> {
  return queryOne<CaRow>(`SELECT * FROM device_ca WHERE id = 1`);
}

async function caMaterial(): Promise<{ row: CaRow; material: CaMaterial; info: CaInfo }> {
  const row = await loadCa();
  if (!row) throw new PkiError('Set up a certificate authority first (Operations → Certificates).');
  return { row, material: { certPem: row.cert_pem, keyPem: decrypt(row.key_encrypted) }, info: caInfo(row.cert_pem) };
}

async function storeCa(m: CaMaterial, imported: boolean, by: string | null): Promise<void> {
  await query(
    `INSERT INTO device_ca (id, cert_pem, key_encrypted, imported, created_by) VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET cert_pem = EXCLUDED.cert_pem, key_encrypted = EXCLUDED.key_encrypted,
       imported = EXCLUDED.imported, created_by = EXCLUDED.created_by, created_at = NOW(), updated_at = NOW()`,
    [m.certPem, encrypt(m.keyPem), imported, by]);
  caCache = null;
}

async function assertNoEnrolled(action: string): Promise<void> {
  const n = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM managed_device_certs`);
  if (Number(n?.n ?? 0) > 0) {
    throw new PkiError(`${n!.n} device(s) carry certificates from the current CA. Remove them first, then ${action}.`);
  }
}

export async function setUpCa(opts: { commonName: string; organization?: string; days: number }, by: string | null): Promise<void> {
  if (await loadCa()) throw new PkiError('A certificate authority is already set up.');
  if (!(CA_DAY_CHOICES as readonly number[]).includes(opts.days)) throw new PkiError('Choose a CA lifetime of 5, 10 or 20 years.');
  await storeCa(await createCa(opts), false, by);
}

export async function importExistingCa(certPem: string, keyPem: string, passphrase: string | undefined, by: string | null): Promise<string[]> {
  if (await loadCa()) throw new PkiError('A certificate authority is already set up. Delete it first.');
  const imported = await importCa(certPem, keyPem, passphrase || undefined);
  await storeCa(imported, true, by);
  return imported.warnings;
}

export async function deleteCa(): Promise<void> {
  await assertNoEnrolled('delete the CA');
  await query(`DELETE FROM device_ca WHERE id = 1`);
  caCache = null;
}

export async function updateSettings(s: { default_days?: number; renew_before_days?: number; auto_renew?: boolean; default_www?: boolean }): Promise<void> {
  const ca = await loadCa();
  if (!ca) throw new PkiError('Set up a certificate authority first.');
  const days = s.default_days ?? ca.default_days;
  const before = s.renew_before_days ?? ca.renew_before_days;
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DEVICE_DAYS) throw new PkiError(`Certificate lifetime must be ${MIN_DAYS} to ${MAX_DEVICE_DAYS} days.`);
  if (!Number.isInteger(before) || before < 1 || before >= days) throw new PkiError('Renew-before must be at least 1 day and shorter than the certificate lifetime.');
  await query(
    `UPDATE device_ca SET default_days = $1, renew_before_days = $2, auto_renew = $3, default_www = $4, updated_at = NOW() WHERE id = 1`,
    [days, before, s.auto_renew ?? ca.auto_renew, s.default_www ?? ca.default_www]);
}

/** The CA certificate for checking, cached: read on every enrolled device's connection. */
async function caCertPem(): Promise<string | null> {
  if (caCache && Date.now() - caCache.at < CA_CACHE_MS) return caCache.pem;
  const row = await loadCa();
  if (!row) { caCache = null; return null; }
  caCache = { pem: row.cert_pem, info: caInfo(row.cert_pem), at: Date.now() };
  return row.cert_pem;
}

/**
 * Connection check for enrolled devices, after the pin check: the certificate
 * must also be signed by the CA. Devices that aren't enrolled are unaffected.
 */
export async function verifyManagedCertificate(host: string, port: number, raw: Buffer): Promise<void> {
  const row = await queryOne<{ device_id: number; name: string; fingerprint: string }>(
    `SELECT m.device_id, d.name, m.fingerprint FROM managed_device_certs m JOIN devices d ON d.id = m.device_id
      WHERE d.ip_address = $1 AND d.api_port = $2 LIMIT 1`, [host, port]);
  if (!row) return;
  const pem = await caCertPem();
  if (!pem) return;
  const presented = new X509Certificate(raw).fingerprint256.replace(/:/g, '').toLowerCase();
  // Mid-switch (issuing, renewing, removing) the device may present the old
  // or the new certificate; the pin check already vouched for it.
  if (presented !== row.fingerprint) return;
  if (!signedBy(raw, pem)) throw new IdentityMismatchError('api-tls', row.name);
}

/**
 * Accept a certificate the manager's CA issued that the manager has no record
 * of, before the pin check would call it a changed identity (#200).
 *
 * This happens after restoring a platform backup made before a renewal (the
 * device serves the renewed certificate, the restored pin and record name the
 * old one), after restoring one made before the device was enrolled, or when
 * the manager stopped between installing a certificate and saving it. A
 * certificate is adopted only if the CA signed it, it's within its validity,
 * and its names cover the device's management address; anything else is left
 * to the usual changed-identity handling.
 */
export async function adoptCaCertificate(host: string, port: number, raw: Buffer): Promise<void> {
  const row = await queryOne<{
    device_id: number; name: string; ip_address: string; managed_fp: string | null; pinned: string | null;
  }>(
    `SELECT d.id AS device_id, d.name, d.ip_address, m.fingerprint AS managed_fp, p.fingerprint AS pinned
       FROM devices d
       LEFT JOIN managed_device_certs m ON m.device_id = d.id
       LEFT JOIN device_identity_pins p ON p.device_id = d.id AND p.kind = 'api-tls'
      WHERE d.ip_address = $1 AND d.api_port = $2 LIMIT 1`, [host, port]);
  if (!row || busy.has(row.device_id)) return; // our own change in progress has its own allowance
  let leaf: X509Certificate;
  try { leaf = new X509Certificate(raw); } catch { return; }
  const fp = leaf.fingerprint256.replace(/:/g, '').toLowerCase();
  if (fp === row.managed_fp && (fp === row.pinned || row.pinned === null)) return; // nothing to do
  if (!row.managed_fp && fp === row.pinned) return; // an ordinary pinned device
  const pem = await caCertPem();
  if (!pem || !signedBy(raw, pem)) return;
  const now = Date.now();
  if (now < leaf.validFromDate.getTime() || now > leaf.validToDate.getTime()) return;
  const address = row.ip_address.replace(/^\[|\]$/g, '');
  const covers = isIP(address) ? leaf.checkIP(address) !== undefined : leaf.checkHost(address) !== undefined;
  if (!covers) return;

  const sans = (leaf.subjectAltName ?? '').split(/,\s*/).map((e) => e.replace(/^(DNS|IP Address):/, '').toLowerCase()).filter(Boolean);
  const days = Math.max(1, Math.round((leaf.validToDate.getTime() - leaf.validFromDate.getTime()) / 86_400_000));
  const serial = leaf.serialNumber.toLowerCase();
  const ca = await loadCa();
  const caFp = caInfo(pem).fingerprint;
  if (row.managed_fp) {
    await query(
      `UPDATE managed_device_certs SET fingerprint = $2, serial = $3, not_before = $4, not_after = $5, sans = $6,
         ca_fingerprint = $7, last_error = NULL WHERE device_id = $1`,
      [row.device_id, fp, serial, leaf.validFromDate, leaf.validToDate, sans, caFp]);
  } else {
    // Enrolled after the backup that was restored: what it had before isn't
    // known, so Remove falls back to the manager's self-signed certificate.
    await query(
      `INSERT INTO managed_device_certs (device_id, cert_name, serial, fingerprint, ca_fingerprint, sans, extra_names, days,
         apply_www, not_before, not_after, last_attempt_at, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $10)
       ON CONFLICT (device_id) DO NOTHING`,
      [row.device_id, `mtm-${fp.slice(0, 6)}`, serial, fp, caFp, sans, sans.filter((n) => n !== address.toLowerCase()), days,
        ca?.default_www ?? true, leaf.validFromDate, leaf.validToDate]);
  }
  await query(
    `INSERT INTO device_identity_pins (device_id, kind, fingerprint) VALUES ($1, 'api-tls', $2)
     ON CONFLICT (device_id, kind) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, pinned_at = NOW(),
       seen_fingerprint = NULL, mismatch_at = NULL`,
    [row.device_id, fp]);
  await deviceEvent(row.device_id, 'info',
    `Accepted a certificate from the manager's CA that wasn't on record (valid until ${leaf.validToDate.toISOString().slice(0, 10)}), ` +
    'probably after restoring an older platform backup');
}

// ─── Talking to the device ─────────────────────────────────────────────────

const busy = new Set<number>();

async function loadDevice(id: number): Promise<CaDevice> {
  const d = await queryOne<CaDevice>(
    `SELECT id, name, ip_address, api_port, api_tls, api_username, api_password_encrypted, ssh_port, ssh_username, ssh_password_encrypted
       FROM devices WHERE id = $1`, [id]);
  if (!d) throw new PkiError('Device not found.');
  if (!d.api_username || !d.api_password_encrypted) throw new PkiError(`${d.name} has no API login.`);
  return d;
}

function apiClient(d: CaDevice, port = d.api_port, tls = usesApiTls(d)): RouterOSClient {
  return new RouterOSClient(d.ip_address, port, d.api_username, decrypt(d.api_password_encrypted), 15_000, 60_000, tls);
}

/** Upload over SFTP: the fallback where `/file/add contents=` isn't available. */
export async function sftpPut(d: CaDevice, name: string, contents: string): Promise<void> {
  const { username, auth } = await resolveAuth(d);
  const port = d.ssh_port || 22;
  await new Promise<void>((resolve, reject) => {
    const conn = new SSHClient();
    let done = false;
    const finish = (e?: Error) => { if (done) return; done = true; clearTimeout(t); try { conn.end(); } catch { /* closing */ } if (e) reject(e); else resolve(); };
    const t = setTimeout(() => finish(new Error('The SFTP upload timed out')), 60_000);
    conn.on('ready', () => conn.sftp((err, sftp) => {
      if (err) return finish(err);
      const ws = sftp.createWriteStream(name);
      ws.on('close', () => finish());
      ws.on('error', (e: Error) => finish(e));
      ws.end(contents);
    }));
    conn.on('error', (e) => finish(explainSshError(e, d.ip_address, port)));
    conn.connect({ host: d.ip_address, port, username, ...sshHostCheck(d.ip_address, port), ...auth, readyTimeout: 15_000 });
  });
}

/** Put a file on the device: over the API if it can, otherwise SFTP. Returns how. */
export async function putFile(c: RouterOSClient, d: CaDevice, name: string, contents: string): Promise<"api" | "sftp"> {
  try {
    await c.execute('/file/add', { name, contents });
    return 'api';
  } catch (e) {
    const msg = (e as Error).message;
    if (!/unknown parameter|no such command|bad command|expected end of command/i.test(msg)) throw e;
  }
  try {
    await sftpPut(d, name, contents);
    return 'sftp';
  } catch (e) {
    throw new PkiError(
      `This RouterOS can't take files over the API (that needs 7.9 or later), and the SFTP upload failed too ` +
      `(${(e as Error).message}). Give the device SSH access or update RouterOS.`);
  }
}

async function certs(c: RouterOSClient): Promise<Record<string, string>[]> {
  return c.execute('/certificate/print', { detail: '' });
}

async function removeCert(c: RouterOSClient, name: string): Promise<void> {
  const row = (await certs(c)).find((r) => r['name'] === name);
  if (row?.['.id']) await c.execute('/certificate/remove', { '.id': row['.id'] });
}

async function removeUploads(c: RouterOSClient, prefix: string): Promise<void> {
  const files = await c.execute('/file/print', {}).catch(() => [] as Record<string, string>[]);
  for (const f of files) if (String(f['name'] ?? '').replace(/^.*\//, '').startsWith(prefix)) await c.execute('/file/remove', { '.id': f['.id'] }).catch(() => {});
}

/** Log in afresh over TLS and report the certificate the device presented. */
async function proveLogin(d: CaDevice, port: number): Promise<{ fingerprint: string | null; error: string | null }> {
  const t = apiClient(d, port, true);
  try {
    await t.connect();
    await t.execute('/system/identity/print');
    return { fingerprint: t.tlsFingerprint, error: null };
  } catch (e) {
    return { fingerprint: t.tlsFingerprint, error: (e as Error).message };
  } finally {
    t.disconnect();
  }
}

async function deviceEvent(deviceId: number, severity: 'info' | 'warning', message: string): Promise<void> {
  await query(`INSERT INTO events (device_id, event_time, severity, topic, message) VALUES ($1, NOW(), $2, 'manager,certificate', $3)`,
    [deviceId, severity, message]).catch(() => {});
}

// ─── Issue / renew ─────────────────────────────────────────────────────────

export interface IssueOptions { days?: number; extraNames?: string[]; applyWww?: boolean }

export async function issueCertificate(deviceId: number, opts: IssueOptions = {}, renewal = false): Promise<CertResult> {
  if (busy.has(deviceId)) throw new PkiError('A certificate change is already running on this device.');
  busy.add(deviceId);
  try {
    return await doIssue(deviceId, opts, renewal);
  } finally {
    busy.delete(deviceId);
    clearTlsExpectation(deviceId);
  }
}

async function doIssue(deviceId: number, opts: IssueOptions, renewal: boolean): Promise<CertResult> {
  const { row: ca, material, info } = await caMaterial();
  const d = await loadDevice(deviceId);
  const existing = await queryOne<ManagedRow>(`SELECT * FROM managed_device_certs WHERE device_id = $1`, [deviceId]);
  const days = opts.days ?? existing?.days ?? ca.default_days;
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DEVICE_DAYS) throw new PkiError(`Certificate lifetime must be ${MIN_DAYS} to ${MAX_DEVICE_DAYS} days.`);
  const applyWww = opts.applyWww ?? existing?.apply_www ?? ca.default_www;
  const extraNames = opts.extraNames ?? existing?.extra_names ?? [];
  const sans = deviceSans(d.ip_address, extraNames);
  const steps: string[] = [];
  const prefix = `mtm-cert-${randomBytes(4).toString('hex')}-`;
  const onPlainApi = !usesApiTls(d);

  const c = apiClient(d);
  await c.connect();
  let certName: string | null = null;
  let importedCaName: string | null = null;
  // Once api-ssl is proved on the new certificate it must never be removed.
  let inUse = false;
  try {
    const identity = (await c.execute('/system/identity/print').catch(() => []))[0]?.['name'] || d.name;
    const services = configuredServices(await c.execute('/ip/service/print', { detail: '' }));
    const apiSsl = services.find((r) => r['name'] === 'api-ssl');
    const wwwSsl = services.find((r) => r['name'] === 'www-ssl');
    const plainApi = services.find((r) => r['name'] === 'api');
    if (!apiSsl?.['.id']) throw new PkiError(`${d.name} has no api-ssl service.`);

    const issued = await issueDeviceCert({ ca: material, commonName: identity, sans, days });
    steps.push(`Issued a certificate for ${sans.join(', ')}, valid until ${issued.notAfter.toISOString().slice(0, 10)}`);

    // The CA certificate, unless the device already has it.
    let have = await certs(c);
    // The current managed certificate, found by fingerprint: a record adopted
    // after a restore may not know its name on the device.
    const oldName = existing ? (have.find((r) => normFp(r['fingerprint']) === existing.fingerprint)?.['name'] ?? existing.cert_name) : null;
    let caName = have.find((r) => normFp(r['fingerprint']) === info.fingerprint)?.['name'] ?? null;
    let method: 'api' | 'sftp' = 'api';
    if (!caName) {
      caName = have.some((r) => r['name'] === 'mtm-ca') ? `mtm-ca-${info.fingerprint.slice(0, 8)}` : 'mtm-ca';
      method = await putFile(c, d, `${prefix}ca.crt`, material.certPem);
      await c.execute('/certificate/import', { 'file-name': `${prefix}ca.crt`, passphrase: '', name: caName, trusted: 'yes' });
      importedCaName = caName;
      steps.push(`Installed the CA certificate as "${caName}"`);
    }

    certName = `mtm-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${issued.fingerprint.slice(0, 6)}`;
    method = await putFile(c, d, `${prefix}dev.crt`, issued.certPem);
    await putFile(c, d, `${prefix}dev.key`, issued.keyPemEncrypted);
    await c.execute('/certificate/import', { 'file-name': `${prefix}dev.crt`, passphrase: '', name: certName });
    const keyResult = (await c.execute('/certificate/import', { 'file-name': `${prefix}dev.key`, passphrase: issued.passphrase, name: certName }))[0] ?? {};
    have = await certs(c);
    const installed = have.find((r) => normFp(r['fingerprint']) === issued.fingerprint);
    if (!installed || !isTrue(installed['private-key'])) {
      throw new PkiError(`The device imported the certificate but not its key (${JSON.stringify(keyResult)}).`);
    }
    if (installed['name'] !== certName) certName = installed['name'];
    steps.push(`Uploaded${method === 'sftp' ? ' over SFTP' : ''} and imported it as "${certName}" with its key`);

    // Switch api-ssl, keeping what it had for a revert (and, first time, for Remove).
    const currentApi = apiSsl['certificate'] && apiSsl['certificate'] !== 'none' ? apiSsl['certificate'] : null;
    const previousApi = existing ? existing.previous_api_cert : currentApi;
    const currentWww = wwwSsl?.['certificate'] && wwwSsl['certificate'] !== 'none' ? wwwSsl['certificate'] : null;
    const previousWww = existing ? existing.previous_www_cert : currentWww;
    const changes: Record<string, string> = { certificate: certName };
    const revert: Record<string, string> = { certificate: currentApi ?? 'none' };
    if (onPlainApi) {
      if (isTrue(apiSsl['disabled'])) { changes['disabled'] = 'no'; revert['disabled'] = 'yes'; }
      if (apiSsl['port'] !== String(API_SSL_PORT)) { changes['port'] = String(API_SSL_PORT); revert['port'] = apiSsl['port']; }
      const apiList = plainApi ? allowedFrom(plainApi) : [];
      if (apiList.length > 0 && allowedFrom(apiSsl).length === 0) {
        changes[allowedFromKey(apiSsl)] = apiList.join(',');
        revert[allowedFromKey(apiSsl)] = '';
      }
    }
    expectTlsCertificate(d.id, issued.fingerprint);
    await c.execute('/ip/service/set', { '.id': apiSsl['.id'], ...changes });
    steps.push(onPlainApi ? `Enabled api-ssl on port ${API_SSL_PORT} with the new certificate` : 'Pointed api-ssl at the new certificate');

    const port = onPlainApi ? API_SSL_PORT : d.api_port;
    const proof = await proveLogin(d, port);
    if (proof.error || proof.fingerprint !== issued.fingerprint) {
      await c.execute('/ip/service/set', { '.id': apiSsl['.id'], ...revert }).catch(() => {});
      await removeCert(c, certName).catch(() => {});
      if (importedCaName) await removeCert(c, importedCaName).catch(() => {});
      const why = proof.error ?? 'the device presented a different certificate';
      return {
        ok: false, steps: [...steps, 'Put api-ssl back as it was and removed the new certificate'],
        message: `The manager couldn't log in over api-ssl with the new certificate (${why}), so nothing was changed` +
          `${onPlainApi ? `. ${d.name} is still managed over the plain API; the usual cause is a firewall rule, or api-ssl's "available from" list, allowing 8728 but not 8729` : ''}.`,
      };
    }
    inUse = true;
    steps.push('Logged in afresh over api-ssl and saw the new certificate');
    if (onPlainApi) {
      await query(`UPDATE devices SET api_port = $1, api_tls = NULL WHERE id = $2`, [API_SSL_PORT, d.id]);
      steps.push(`Moved the manager's connection to api-ssl on port ${API_SSL_PORT}`);
    }

    // From here api-ssl is on the new certificate, so problems are reported,
    // not rolled back. www-ssl follows the choice, and never points at a
    // certificate about to be removed.
    try {
      if (wwwSsl?.['.id']) {
        if (applyWww && currentWww !== certName) {
          await c.execute('/ip/service/set', { '.id': wwwSsl['.id'], certificate: certName });
          steps.push('Pointed www-ssl (WebFig) at the new certificate');
        } else if (!applyWww && oldName && currentWww === oldName) {
          // Back to what it had: none, or its old certificate if that still exists.
          const back = previousWww === null ? 'none' : have.some((r) => r['name'] === previousWww) ? previousWww : certName;
          await c.execute('/ip/service/set', { '.id': wwwSsl['.id'], certificate: back });
          if (back !== certName) steps.push(`Put www-ssl back on ${back === 'none' ? 'no certificate' : `"${back}"`}`);
        }
      }
      // The old managed certificate, now unused.
      if (oldName && oldName !== certName) {
        const stillUsed = configuredServices(await c.execute('/ip/service/print', { detail: '' })).some((r) => r['certificate'] === oldName);
        if (!stillUsed) {
          await removeCert(c, oldName);
          steps.push(`Removed the previous certificate "${oldName}"`);
        }
      }
    } catch (e) {
      steps.push(`Warning: ${(e as Error).message}`);
    }

    await forgetIdentity(d.id, 'api-tls');
    await pinIdentity(d.id, 'api-tls', issued.fingerprint);
    await query(
      `INSERT INTO managed_device_certs (device_id, cert_name, ca_cert_name, serial, fingerprint, ca_fingerprint, sans, extra_names, days,
         apply_www, not_before, not_after, previous_api_cert, previous_www_cert, last_error, last_attempt_at, issued_at, renewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NOW(),NOW(),NULL)
       ON CONFLICT (device_id) DO UPDATE SET cert_name = EXCLUDED.cert_name, ca_cert_name = EXCLUDED.ca_cert_name,
         serial = EXCLUDED.serial, fingerprint = EXCLUDED.fingerprint, ca_fingerprint = EXCLUDED.ca_fingerprint,
         sans = EXCLUDED.sans, extra_names = EXCLUDED.extra_names, days = EXCLUDED.days, apply_www = EXCLUDED.apply_www,
         not_before = EXCLUDED.not_before, not_after = EXCLUDED.not_after, last_error = NULL, last_attempt_at = NOW(),
         renewed_at = NOW()`,
      // Only a CA certificate the manager installed is removed again later.
      [d.id, certName, importedCaName ?? existing?.ca_cert_name ?? null, issued.serial, issued.fingerprint, info.fingerprint, sans, sans.slice(1),
        days, applyWww, issued.notBefore, issued.notAfter, previousApi, previousWww]);
    const message = `${d.name} now has a certificate from ${info.commonName}, valid until ${issued.notAfter.toISOString().slice(0, 10)}.`;
    await deviceEvent(d.id, 'info', renewal ? `Certificate renewed by the manager's CA (valid until ${issued.notAfter.toISOString().slice(0, 10)})` : message);
    return { ok: true, steps, message };
  } catch (e) {
    // Anything left half-done before the switch: the new certificate goes.
    if (!inUse) {
      if (certName) await removeCert(c, certName).catch(() => {});
      if (importedCaName) await removeCert(c, importedCaName).catch(() => {});
    }
    throw e;
  } finally {
    await removeUploads(c, prefix).catch(() => {});
    c.disconnect();
  }
}

// ─── Remove ────────────────────────────────────────────────────────────────

/**
 * Take the manager's certificate off a device: api-ssl and www-ssl go back to
 * what they had before enrolment (or the manager's self-signed one), proved
 * by a fresh login, and the device returns to ordinary pinning. `forget`
 * drops the record without touching the device (it was reset or is gone).
 */
export async function removeCertificate(deviceId: number, forget = false): Promise<CertResult> {
  const rec = await queryOne<ManagedRow>(`SELECT * FROM managed_device_certs WHERE device_id = $1`, [deviceId]);
  if (!rec) throw new PkiError('This device has no certificate from the manager.');
  if (forget) {
    await query(`DELETE FROM managed_device_certs WHERE device_id = $1`, [deviceId]);
    await forgetIdentity(deviceId, 'api-tls');
    return { ok: true, steps: [], message: 'Forgot the certificate. The device was not changed; its next connection is pinned afresh.' };
  }
  if (busy.has(deviceId)) throw new PkiError('A certificate change is already running on this device.');
  const d = await loadDevice(deviceId);
  busy.add(deviceId);
  const steps: string[] = [];
  const c = apiClient(d);
  try {
    await c.connect();
    const services = configuredServices(await c.execute('/ip/service/print', { detail: '' }));
    const apiSsl = services.find((r) => r['name'] === 'api-ssl');
    const wwwSsl = services.find((r) => r['name'] === 'www-ssl');
    let have = await certs(c);
    const curName = have.find((r) => normFp(r['fingerprint']) === rec.fingerprint)?.['name'] ?? rec.cert_name;
    const usable = (name: string | null) => {
      const r = name ? have.find((x) => x['name'] === name) : undefined;
      return !!r && isTrue(r['private-key']) && !isTrue(r['expired']) && !isTrue(r['revoked']);
    };
    const target = usable(rec.previous_api_cert) ? rec.previous_api_cert! : await ensureCertificate(c, d, steps);
    have = await certs(c);
    const targetFp = normFp(have.find((r) => r['name'] === target)?.['fingerprint']);
    if (apiSsl?.['.id'] && apiSsl['certificate'] === curName) {
      expectTlsCertificate(d.id, targetFp);
      await c.execute('/ip/service/set', { '.id': apiSsl['.id'], certificate: target });
      const proof = usesApiTls(d) ? await proveLogin(d, d.api_port) : { fingerprint: targetFp, error: null };
      if (proof.error || (targetFp && proof.fingerprint !== targetFp)) {
        await c.execute('/ip/service/set', { '.id': apiSsl['.id'], certificate: curName }).catch(() => {});
        return { ok: false, steps, message: `The manager couldn't log in with "${target}" (${proof.error ?? 'a different certificate was presented'}), so the certificate was left in place.` };
      }
      steps.push(`Put api-ssl back on "${target}"`);
    }
    if (wwwSsl?.['.id'] && wwwSsl['certificate'] === curName) {
      // What it had before enrolment: none, its old certificate, or (if that's gone) api-ssl's.
      const back = rec.previous_www_cert === null ? 'none' : usable(rec.previous_www_cert) ? rec.previous_www_cert : target;
      await c.execute('/ip/service/set', { '.id': wwwSsl['.id'], certificate: back });
      steps.push(`Put www-ssl back on ${back === 'none' ? 'no certificate' : `"${back}"`}`);
    }
    await removeCert(c, curName);
    steps.push(`Removed "${curName}"`);
    if (rec.ca_cert_name) {
      await removeCert(c, rec.ca_cert_name).catch(() => {});
      steps.push(`Removed the CA certificate "${rec.ca_cert_name}"`);
    }
    await forgetIdentity(d.id, 'api-tls');
    if (targetFp) await pinIdentity(d.id, 'api-tls', targetFp);
    await query(`DELETE FROM managed_device_certs WHERE device_id = $1`, [deviceId]);
    await deviceEvent(d.id, 'info', 'The manager\'s certificate was removed; api-ssl is back on its previous certificate');
    return { ok: true, steps, message: `${d.name} no longer uses the manager's certificate.` };
  } finally {
    c.disconnect();
    busy.delete(deviceId);
    clearTlsExpectation(deviceId);
  }
}

// ─── Renewal ───────────────────────────────────────────────────────────────

let lastTick = 0;
const TICK_EVERY_MS = 30 * 60_000;
const RETRY_AFTER_H = 6;

/** Called each poll cycle: renews certificates that are due, one at a time. */
export async function renewalTick(): Promise<void> {
  if (Date.now() - lastTick < TICK_EVERY_MS) return;
  lastTick = Date.now();
  const due = await query<{ device_id: number; name: string; not_after: string }>(
    `SELECT m.device_id, d.name, m.not_after FROM managed_device_certs m
       JOIN devices d ON d.id = m.device_id
       JOIN device_ca c ON c.id = 1
      WHERE c.auto_renew AND m.not_after < NOW() + make_interval(days => c.renew_before_days)
        -- After a failure, wait before trying again; a success never holds it back.
        AND (m.last_error IS NULL OR m.last_attempt_at IS NULL OR m.last_attempt_at < NOW() - make_interval(hours => ${RETRY_AFTER_H}))
      ORDER BY m.not_after`).catch(() => []);
  for (const r of due) {
    let error: string | null = null;
    try {
      const res = await issueCertificate(r.device_id, {}, true);
      if (!res.ok) error = res.message;
    } catch (e) {
      error = (e as Error).message;
    }
    if (error) {
      await query(`UPDATE managed_device_certs SET last_error = $2, last_attempt_at = NOW() WHERE device_id = $1`, [r.device_id, error]);
      const message = `The certificate on ${r.name} expires ${new Date(r.not_after).toISOString().slice(0, 10)} and couldn't be renewed: ${error}`;
      await deviceEvent(r.device_id, 'warning', message);
      void alertService.dispatch('device_cert_renewal_failed', message, {
        deviceId: r.device_id, deviceName: r.name, cooldownKey: `device_cert_renewal_failed:${r.device_id}`,
      });
      console.warn(`[device-ca] renewal failed for ${logSafe(r.name)}: ${logSafe(error)}`);
    }
  }
}
