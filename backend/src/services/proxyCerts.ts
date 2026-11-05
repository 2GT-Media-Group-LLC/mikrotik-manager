/**
 * Certificates from the manager's CA for reverse-proxy host names (#358).
 *
 * The same steps as a device certificate (deviceCa.ts), for a name the
 * device serves rather than the device itself: make a key and certificate
 * here for the host name, install the CA certificate if the device lacks it,
 * upload and import the certificate with its key, and point every rule for
 * that host name at it. The previous one goes once nothing uses it. Renewed
 * on the CA's schedule, like device certificates.
 */
import { randomBytes } from 'crypto';
import { query, queryOne } from '../config/database';
import { issueDeviceCert, deviceSans, PkiError } from '../utils/pki';
import { normalizeSni, sniError, rulesFrom } from '../utils/reverseProxy';
import { configuredServices } from '../utils/ipServices';
import {
  caMaterial, loadDevice, apiClient, certs, removeCert, removeUploads, deviceEvent, normFp, putFile,
  MIN_DAYS, MAX_DEVICE_DAYS, type CertResult,
} from './deviceCa';
import { alertService } from './AlertService';
import { logSafe } from '../utils/logSafe';

export interface ProxyCertRow {
  device_id: number;
  sni: string;
  cert_name: string;
  ca_cert_name: string | null;
  serial: string;
  fingerprint: string;
  ca_fingerprint: string;
  days: number;
  not_before: string;
  not_after: string;
  last_error: string | null;
  last_attempt_at: string | null;
  issued_at: string;
  renewed_at: string | null;
}

const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';
const busy = new Set<string>();

/** A RouterOS certificate name for a host name: readable, and unique per issue. */
export function proxyCertName(sni: string, fingerprint: string): string {
  const slug = sni.replace(/[^a-z0-9.-]/g, '-').slice(0, 90);
  return `mtm-proxy-${slug}-${fingerprint.slice(0, 6)}`;
}

export async function issueProxyCert(deviceId: number, rawSni: string, opts: { days?: number } = {}, renewal = false): Promise<CertResult & { cert_name?: string }> {
  const bad = sniError(rawSni);
  if (bad) throw new PkiError(bad);
  const sni = normalizeSni(rawSni);
  const key = `${deviceId}:${sni}`;
  if (busy.has(key)) throw new PkiError(`A certificate for ${sni} is already being issued on this device.`);
  busy.add(key);
  try {
    return await doIssue(deviceId, sni, opts, renewal);
  } finally {
    busy.delete(key);
  }
}

async function doIssue(deviceId: number, sni: string, opts: { days?: number }, renewal: boolean): Promise<CertResult & { cert_name?: string }> {
  const { row: ca, material, info } = await caMaterial();
  const d = await loadDevice(deviceId);
  const existing = await queryOne<ProxyCertRow>(`SELECT * FROM proxy_certs WHERE device_id = $1 AND sni = $2`, [deviceId, sni]);
  const days = opts.days ?? existing?.days ?? ca.default_days;
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DEVICE_DAYS) throw new PkiError(`Certificate lifetime must be ${MIN_DAYS} to ${MAX_DEVICE_DAYS} days.`);
  const steps: string[] = [];
  const prefix = `mtm-cert-${randomBytes(4).toString('hex')}-`;

  const c = apiClient(d);
  await c.connect();
  let certName: string | null = null;
  let importedCaName: string | null = null;
  let applied = false;
  try {
    const issued = await issueDeviceCert({ ca: material, commonName: sni, sans: deviceSans(sni), days });
    steps.push(`Issued a certificate for ${sni}, valid until ${issued.notAfter.toISOString().slice(0, 10)}`);

    let have = await certs(c);
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

    certName = proxyCertName(sni, issued.fingerprint);
    method = await putFile(c, d, `${prefix}proxy.crt`, issued.certPem);
    await putFile(c, d, `${prefix}proxy.key`, issued.keyPemEncrypted);
    await c.execute('/certificate/import', { 'file-name': `${prefix}proxy.crt`, passphrase: '', name: certName });
    const keyResult = (await c.execute('/certificate/import', { 'file-name': `${prefix}proxy.key`, passphrase: issued.passphrase, name: certName }))[0] ?? {};
    have = await certs(c);
    const installed = have.find((r) => normFp(r['fingerprint']) === issued.fingerprint);
    if (!installed || !isTrue(installed['private-key'])) {
      throw new PkiError(`The device imported the certificate but not its key (${JSON.stringify(keyResult)}).`);
    }
    if (installed['name'] !== certName) certName = installed['name'];
    steps.push(`Uploaded${method === 'sftp' ? ' over SFTP' : ''} and imported it as "${certName}" with its key`);

    // Every rule (not a container app's) for this host name serves it.
    const rules = rulesFrom(await c.execute('/ip/reverse-proxy/print', { detail: '' })).filter((r) => r.sni === sni && !r.dynamic);
    for (const r of rules) {
      if (r.certificate === certName) continue;
      await c.execute('/ip/reverse-proxy/set', { numbers: r.id, certificate: certName });
    }
    applied = true;
    if (rules.length) steps.push(`Pointed ${rules.length === 1 ? 'the rule' : `the ${rules.length} rules`} for ${sni} at it`);

    // The previous one, once nothing uses it.
    if (oldName && oldName !== certName) {
      const stillRule = rulesFrom(await c.execute('/ip/reverse-proxy/print', { detail: '' })).some((r) => r.certificate === oldName);
      const stillService = configuredServices(await c.execute('/ip/service/print', { detail: '' })).some((r) => r['certificate'] === oldName);
      if (!stillRule && !stillService) {
        await removeCert(c, oldName).catch(() => {});
        steps.push(`Removed the previous certificate "${oldName}"`);
      }
    }

    await query(
      `INSERT INTO proxy_certs (device_id, sni, cert_name, ca_cert_name, serial, fingerprint, ca_fingerprint, days, not_before, not_after,
         last_error, last_attempt_at, issued_at, renewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NOW(),NOW(),NULL)
       ON CONFLICT (device_id, sni) DO UPDATE SET cert_name = EXCLUDED.cert_name, ca_cert_name = COALESCE(EXCLUDED.ca_cert_name, proxy_certs.ca_cert_name),
         serial = EXCLUDED.serial, fingerprint = EXCLUDED.fingerprint, ca_fingerprint = EXCLUDED.ca_fingerprint, days = EXCLUDED.days,
         not_before = EXCLUDED.not_before, not_after = EXCLUDED.not_after, last_error = NULL, last_attempt_at = NOW(), renewed_at = NOW()`,
      [d.id, sni, certName, importedCaName, issued.serial, issued.fingerprint, info.fingerprint, days, issued.notBefore, issued.notAfter]);
    const until = issued.notAfter.toISOString().slice(0, 10);
    await deviceEvent(d.id, 'info', renewal ? `Reverse proxy certificate for ${sni} renewed by the manager's CA (valid until ${until})`
      : `Reverse proxy certificate for ${sni} issued by the manager's CA (valid until ${until})`);
    return { ok: true, steps, message: `${d.name} has a certificate for ${sni} from ${info.commonName}, valid until ${until}.`, cert_name: certName };
  } catch (e) {
    // Not yet serving anything: take the new certificate (and a CA installed for it) back off.
    if (!applied) {
      if (certName) await removeCert(c, certName).catch(() => {});
      if (importedCaName) await removeCert(c, importedCaName).catch(() => {});
    }
    throw e;
  } finally {
    await removeUploads(c, prefix).catch(() => {});
    c.disconnect();
  }
}

/**
 * Stop managing a host name's certificate. It's taken off the device when no
 * rule or service uses it; otherwise the rules have to move first. `forget`
 * drops the record and leaves the device alone.
 */
export async function removeProxyCert(deviceId: number, rawSni: string, forget = false): Promise<CertResult> {
  const sni = normalizeSni(rawSni);
  const rec = await queryOne<ProxyCertRow>(`SELECT * FROM proxy_certs WHERE device_id = $1 AND sni = $2`, [deviceId, sni]);
  if (!rec) throw new PkiError(`The manager hasn't issued a certificate for ${sni} on this device.`);
  if (forget) {
    await query(`DELETE FROM proxy_certs WHERE device_id = $1 AND sni = $2`, [deviceId, sni]);
    return { ok: true, steps: [], message: `The manager no longer renews the certificate for ${sni}. Nothing was changed on the device.` };
  }
  const d = await loadDevice(deviceId);
  const c = apiClient(d);
  await c.connect();
  try {
    const have = await certs(c);
    const name = have.find((r) => normFp(r['fingerprint']) === rec.fingerprint)?.['name'] ?? rec.cert_name;
    const users = rulesFrom(await c.execute('/ip/reverse-proxy/print', { detail: '' })).filter((r) => r.certificate === name);
    const service = configuredServices(await c.execute('/ip/service/print', { detail: '' })).find((r) => r['certificate'] === name);
    if (users.length || service) {
      const what = [...users.map((r) => `the rule for ${r.sni}`), ...(service ? [`the ${service['name']} service`] : [])].join(', ');
      throw new PkiError(`The certificate is still used by ${what}. Give ${users.length + (service ? 1 : 0) === 1 ? 'it' : 'them'} another certificate first.`);
    }
    await removeCert(c, name);
    await query(`DELETE FROM proxy_certs WHERE device_id = $1 AND sni = $2`, [deviceId, sni]);
    return { ok: true, steps: [`Removed "${name}" from ${d.name}`], message: `Removed the certificate for ${sni}.` };
  } finally {
    c.disconnect();
  }
}

// ─── Renewal ───────────────────────────────────────────────────────────────

let lastTick = 0;
const TICK_EVERY_MS = 30 * 60_000;
const RETRY_AFTER_H = 6;

/** Each poll cycle: renews reverse-proxy certificates that are due, on the CA's settings. */
export async function proxyRenewalTick(): Promise<void> {
  if (Date.now() - lastTick < TICK_EVERY_MS) return;
  lastTick = Date.now();
  const due = await query<{ device_id: number; name: string; sni: string; not_after: string }>(
    `SELECT p.device_id, d.name, p.sni, p.not_after FROM proxy_certs p
       JOIN devices d ON d.id = p.device_id
       JOIN device_ca c ON c.id = 1
      WHERE c.auto_renew AND p.not_after < NOW() + make_interval(days => c.renew_before_days)
        AND (p.last_error IS NULL OR p.last_attempt_at IS NULL OR p.last_attempt_at < NOW() - make_interval(hours => ${RETRY_AFTER_H}))
      ORDER BY p.not_after`).catch(() => []);
  for (const r of due) {
    let error: string | null = null;
    try {
      const res = await issueProxyCert(r.device_id, r.sni, {}, true);
      if (!res.ok) error = res.message;
    } catch (e) {
      error = (e as Error).message;
    }
    if (error) {
      await query(`UPDATE proxy_certs SET last_error = $3, last_attempt_at = NOW() WHERE device_id = $1 AND sni = $2`, [r.device_id, r.sni, error]);
      const message = `The reverse proxy certificate for ${r.sni} on ${r.name} expires ${new Date(r.not_after).toISOString().slice(0, 10)} and couldn't be renewed: ${error}`;
      await deviceEvent(r.device_id, 'warning', message);
      void alertService.dispatch('device_cert_renewal_failed', message, {
        deviceId: r.device_id, deviceName: r.name, cooldownKey: `proxy_cert_renewal_failed:${r.device_id}:${r.sni}`,
      });
      console.warn(`[proxy-certs] renewal failed for ${logSafe(r.sni)} on ${logSafe(r.name)}: ${logSafe(error)}`);
    }
  }
}
