/**
 * Move a device's management connection to API-SSL (outside review P1-4).
 *
 * The plain API (8728) carries the device's admin password in the clear on
 * every poll. This turns on the device's api-ssl service and, only once the
 * manager has actually logged in over it, moves the stored connection to 8729.
 *
 *   1. api-ssl needs a certificate. One already assigned is kept; otherwise a
 *      self-signed one named "mtm-api-ssl" is created and signed on the device.
 *   2. api-ssl is enabled on 8729 with that certificate. The plain API is left
 *      running, so nothing is lost if the next step fails.
 *   3. A fresh login over 8729 has to succeed before the device's stored port
 *      changes. The usual reason it doesn't is a firewall rule that lets 8728
 *      in but not 8729; the device then stays on 8728 and the reason is shown.
 *
 * The certificate is self-signed and the manager does not verify it, so this
 * protects against someone reading the traffic, not yet against one who can
 * intercept and answer it.
 */
import { query } from '../config/database';
import { decrypt } from '../utils/crypto';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import { API_SSL_PORT } from './mikrotik/apiConnect';
import { forgetIdentity } from './identityPins';
import { configuredServices, allowedFrom, allowedFromKey } from '../utils/ipServices';

export const MTM_CERT_NAME = 'mtm-api-ssl';

export interface ApiSslDevice {
  id: number;
  name: string;
  ip_address: string;
  api_port: number;
  api_username: string;
  api_password_encrypted: string;
}

export interface ApiSslResult {
  switched: boolean;
  /** What was done on the device, in order, for the UI. */
  steps: string[];
  message: string;
}

const SIGN_TIMEOUT_MS = 120_000;
const SIGN_WAIT_MS = 90_000;

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A certificate api-ssl can use: present, with its private key, not expired or revoked. */
function usable(cert: Record<string, string> | undefined): boolean {
  if (!cert) return false;
  return isTrue(cert['private-key']) && !isTrue(cert['expired']) && !isTrue(cert['revoked']) && !isTrue(cert['invalid']);
}

async function certByName(client: RouterOSClient, name: string): Promise<Record<string, string> | undefined> {
  const rows = await client.execute('/certificate/print', { detail: '' }, [`?name=${name}`]);
  return rows[0];
}

/** Create and sign the manager's self-signed certificate, replacing an unusable one. */
async function ensureCertificate(client: RouterOSClient, device: ApiSslDevice, steps: string[]): Promise<string> {
  const existing = await certByName(client, MTM_CERT_NAME);
  if (usable(existing)) {
    steps.push(`Reused the certificate "${MTM_CERT_NAME}" already on the device`);
    return MTM_CERT_NAME;
  }
  if (existing?.['.id']) {
    await client.execute('/certificate/remove', { '.id': existing['.id'] });
    steps.push(`Removed an unusable "${MTM_CERT_NAME}" certificate`);
  }
  const identity = (await client.execute('/system/identity/print').catch(() => []))[0]?.['name'] || device.name;
  await client.execute('/certificate/add', {
    name: MTM_CERT_NAME,
    'common-name': identity.slice(0, 64),
    'key-size': '2048',
    'days-valid': '3650',
    // key-cert-sign is needed for a certificate to sign itself; without it
    // RouterOS refuses with "CA not found".
    'key-usage': 'digital-signature,key-encipherment,key-cert-sign,tls-server',
  });
  steps.push(`Created a self-signed certificate "${MTM_CERT_NAME}" (valid 10 years)`);

  // Signing generates the key, which takes a while on small devices. The
  // command can return before it finishes, so wait for the private key to appear.
  const added = await certByName(client, MTM_CERT_NAME);
  if (!added?.['.id']) throw new Error('The certificate was created but could not be found to sign it.');
  // By .id: the API's /certificate/sign refuses `numbers`.
  await client.execute('/certificate/sign', { '.id': added['.id'] }, [], { timeoutMs: SIGN_TIMEOUT_MS });
  const deadline = Date.now() + SIGN_WAIT_MS;
  while (Date.now() < deadline) {
    if (usable(await certByName(client, MTM_CERT_NAME))) {
      steps.push('Signed it on the device');
      return MTM_CERT_NAME;
    }
    await sleep(2_000);
  }
  throw new Error('The device did not finish signing the certificate in time. Try again in a minute.');
}

/** Can the manager log in over API-SSL right now? Resolves with the error text if not. */
async function tryApiSsl(device: ApiSslDevice): Promise<string | null> {
  const client = new RouterOSClient(
    device.ip_address, API_SSL_PORT, device.api_username, decrypt(device.api_password_encrypted), 10_000);
  try {
    await client.connect();
    await client.execute('/system/identity/print');
    return null;
  } catch (err) {
    return (err as Error).message;
  } finally {
    client.disconnect();
  }
}

export async function enableApiSsl(device: ApiSslDevice): Promise<ApiSslResult> {
  if (device.api_port === API_SSL_PORT) {
    return { switched: false, steps: [], message: `${device.name} is already managed over API-SSL.` };
  }
  const steps: string[] = [];
  const client = new RouterOSClient(
    device.ip_address, device.api_port, device.api_username, decrypt(device.api_password_encrypted), 15_000, 30_000);
  try {
    await client.connect();
    // Configured rows only: a live api-ssl session is printed as another
    // "api-ssl" row (#192).
    const services = configuredServices(await client.execute('/ip/service/print', { detail: '' }));
    const svc = services.find((r) => r['name'] === 'api-ssl');
    if (!svc?.['.id']) throw new Error('This device has no api-ssl service.');
    const plainApi = services.find((r) => r['name'] === 'api');

    // Keep a certificate that is already assigned and usable; otherwise make one.
    const assigned = svc['certificate'] && svc['certificate'] !== 'none' ? svc['certificate'] : null;
    let certName: string;
    if (assigned && usable(await certByName(client, assigned))) {
      certName = assigned;
      steps.push(`Kept api-ssl's existing certificate "${assigned}"`);
    } else {
      certName = await ensureCertificate(client, device, steps);
    }

    const changes: Record<string, string> = {};
    if (svc['certificate'] !== certName) {
      changes['certificate'] = certName;
      // The manager is replacing the certificate itself, so the old pin is
      // expected to stop matching; the login below pins the new one.
      await forgetIdentity(device.id, 'api-tls');
    }
    if (isTrue(svc['disabled'])) changes['disabled'] = 'no';
    if (svc['port'] !== String(API_SSL_PORT)) changes['port'] = String(API_SSL_PORT);
    // api-ssl takes over api's job, so it gets api's allowed addresses too
    // (#192). Left alone, a device whose api was limited to a management
    // subnet ended up with api-ssl open to any address. A list already set
    // on api-ssl is the operator's own choice and is kept.
    const apiList = plainApi ? allowedFrom(plainApi) : [];
    if (apiList.length > 0 && allowedFrom(svc).length === 0) {
      changes[allowedFromKey(svc)] = apiList.join(',');
    }
    if (Object.keys(changes).length > 0) {
      await client.execute('/ip/service/set', { '.id': svc['.id'], ...changes });
      if (changes['disabled']) steps.push('Enabled the api-ssl service');
      if (changes['certificate']) steps.push(`Assigned "${certName}" to the api-ssl service`);
      if (changes['port']) steps.push(`Moved api-ssl to port ${API_SSL_PORT} (it was on ${svc['port']})`);
      if (changes[allowedFromKey(svc)] !== undefined) {
        steps.push(`Limited api-ssl to the addresses api allows: ${apiList.join(', ')}`);
      }
    } else {
      steps.push(`api-ssl was already enabled on port ${API_SSL_PORT}`);
    }
  } finally {
    client.disconnect();
  }

  // The deciding step: a real login over TLS, on a new connection.
  const failure = await tryApiSsl(device);
  if (failure) {
    return {
      switched: false,
      steps,
      message: `API-SSL is enabled on ${device.name}, but the manager could not log in over it on port ${API_SSL_PORT} ` +
        `(${failure}). The device is still managed over the plain API. The usual cause is a firewall rule, or ` +
        `the api-ssl service's "available from" list, allowing 8728 but not 8729.`,
    };
  }
  await query(`UPDATE devices SET api_port = $1 WHERE id = $2`, [API_SSL_PORT, device.id]);
  steps.push(`Logged in over API-SSL and moved the manager's connection to port ${API_SSL_PORT}`);
  return {
    switched: true,
    steps,
    message: `${device.name} is now managed over API-SSL. The plain API service is still on; ` +
      `turn it off from the device's Security tab once nothing else needs it.`,
  };
}
