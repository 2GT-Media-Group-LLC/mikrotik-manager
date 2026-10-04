/**
 * Move a device's WebFig from plain HTTP (www) to HTTPS (www-ssl) (#234).
 *
 * Plain WebFig sends whoever signs in to it, and everything they do, in the
 * clear. The manager never uses WebFig itself, so this is about people:
 * technicians leave www on because turning on www-ssl means making and signing
 * a certificate first. This does that part, the same way the API-SSL switch
 * does:
 *
 *   1. www-ssl needs a certificate. A usable one already assigned to www-ssl is
 *      kept; otherwise the one api-ssl uses is shared; otherwise the manager's
 *      self-signed "mtm-api-ssl" is created and signed on the device.
 *   2. www-ssl is enabled with it, on the port it already has (443 by default),
 *      and gets www's allowed addresses if it has none of its own.
 *   3. Only once HTTPS actually answers is plain www turned off. If it doesn't
 *      (a firewall allowing 80 but not 443, usually), www stays on and the
 *      reason is shown, so nobody is locked out of WebFig.
 *
 * The certificate is self-signed, so browsers warn on first visit; it protects
 * against someone reading the traffic. A certificate from your own CA can be
 * assigned on the device instead and is kept from then on.
 */
import https from 'https';
import { queryOne } from '../config/database';
import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import { ensureCertificate, certByName, usable } from './apiSsl';
import { allowedFrom, allowedFromKey } from '../utils/ipServices';

export interface WwwSslResult {
  /** True once www-ssl answers and plain www is off. */
  switched: boolean;
  /** What was done on the device, in order, for the UI. */
  steps: string[];
  message: string;
  /** Where WebFig now answers, when it does. */
  url?: string;
}

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';
const CHECK_TIMEOUT_MS = 8_000;
const CHECK_ATTEMPTS = 3;

/**
 * Does the device answer HTTPS on this port? Any HTTP status counts: WebFig
 * answers / with a page or a redirect. The certificate isn't verified, since
 * it's self-signed; this only proves the service is up and reachable.
 */
export function httpsAnswers(host: string, port: number, timeoutMs = CHECK_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.request(
      { host, port, path: '/', method: 'GET', rejectUnauthorized: false, timeout: timeoutMs },
      (res) => { res.resume(); resolve(null); },
    );
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', (e) => resolve((e as Error).message || 'no answer'));
    req.end();
  });
}

const webfigUrl = (host: string, port: number) => {
  const h = host.includes(':') ? `[${host}]` : host;
  return port === 443 ? `https://${h}/` : `https://${h}:${port}/`;
};

export async function enableWwwSsl(deviceId: number): Promise<WwwSslResult> {
  const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
  if (!device) throw new Error('Device not found');
  const name = device.name.trim();
  const steps: string[] = [];
  let port: number;

  const c = new DeviceCollector(device);
  try {
    await c.connect();
    const services = await c.getServices();
    const ssl = services.find((r) => r['name'] === 'www-ssl');
    const www = services.find((r) => r['name'] === 'www');
    if (!ssl?.['.id']) throw new Error('This device has no www-ssl service.');
    port = Number(ssl['port']) || 443;
    const run = c.commandRunner();

    // Keep a usable certificate www-ssl already has; else share api-ssl's;
    // else make the manager's own.
    const assigned = ssl['certificate'] && ssl['certificate'] !== 'none' ? ssl['certificate'] : null;
    const apiSsl = services.find((r) => r['name'] === 'api-ssl');
    const apiCert = apiSsl?.['certificate'] && apiSsl['certificate'] !== 'none' ? apiSsl['certificate'] : null;
    let certName: string;
    if (assigned && usable(await certByName(run, assigned))) {
      certName = assigned;
      steps.push(`Kept www-ssl's existing certificate "${assigned}"`);
    } else if (apiCert && usable(await certByName(run, apiCert))) {
      certName = apiCert;
      steps.push(`Used api-ssl's certificate "${apiCert}"`);
    } else {
      certName = await ensureCertificate(run, device, steps);
    }

    const changes: Record<string, string> = {};
    if (ssl['certificate'] !== certName) changes['certificate'] = certName;
    if (isTrue(ssl['disabled'])) changes['disabled'] = 'no';
    // www-ssl takes over www's job, so it inherits www's allowed addresses
    // when it has none of its own (as api-ssl does from api, #192).
    const wwwList = www ? allowedFrom(www) : [];
    if (wwwList.length > 0 && allowedFrom(ssl).length === 0) changes[allowedFromKey(ssl)] = wwwList.join(',');

    if (Object.keys(changes).length > 0) {
      await run.execute('/ip/service/set', { '.id': ssl['.id'], ...changes });
      if (changes['certificate']) steps.push(`Assigned "${certName}" to www-ssl`);
      if (changes['disabled']) steps.push(`Enabled www-ssl on port ${port}`);
      if (changes[allowedFromKey(ssl)] !== undefined) steps.push(`Limited www-ssl to the addresses www allows: ${wwwList.join(', ')}`);
    } else {
      steps.push(`www-ssl was already enabled on port ${port} with "${certName}"`);
    }

    // The deciding step: HTTPS has to answer before plain www goes.
    let failure: string | null = 'not checked';
    for (let i = 0; i < CHECK_ATTEMPTS && failure; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2_000));
      failure = await httpsAnswers(device.ip_address, port);
    }
    const url = webfigUrl(device.ip_address, port);
    if (failure) {
      return {
        switched: false,
        steps,
        message: `www-ssl is on, but WebFig didn't answer at ${url} (${failure}), so plain www was left on. ` +
          `The usual cause is a firewall rule, or www-ssl's "available from" list, allowing port 80 but not ${port}.`,
      };
    }
    steps.push(`WebFig answers at ${url}`);

    if (www?.['.id'] && !isTrue(www['disabled'])) {
      await run.execute('/ip/service/set', { '.id': www['.id'], disabled: 'yes' });
      steps.push('Turned off plain www (HTTP)');
    }
    return {
      switched: true,
      steps,
      url,
      message: `${name}'s WebFig is now HTTPS only, at ${url}. The certificate is self-signed, so browsers ` +
        `warn the first time.`,
    };
  } finally {
    c.disconnect();
  }
}
