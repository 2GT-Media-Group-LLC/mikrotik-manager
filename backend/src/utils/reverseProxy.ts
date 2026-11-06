/**
 * RouterOS reverse proxy (#358): /ip/reverse-proxy, RouterOS 7.22 and later,
 * not on SMIPS. Each rule matches a TLS server name (SNI) exactly and
 * forwards HTTPS for it to a web server behind the router over plain HTTP,
 * presenting the rule's certificate (or, with none, the reverse-proxy
 * service's). The proxy listens on the `reverse-proxy` service's port, 443 by
 * default, which is also www-ssl's default: with both on one port, one of
 * them fails to bind. The port only opens once an enabled rule exists.
 *
 * Pure, so every rule is tested without a device.
 */
import { isIP } from 'net';
import { compareRosVersions, parseRosVersion } from './rosVersion';

export const REVERSE_PROXY_MIN_VERSION = '7.22';

type Ros = Record<string, string>;
const yes = (v: string | undefined) => v === 'true' || v === 'yes';

export type ProxySupport = 'supported' | 'too-old' | 'unsupported' | 'unknown';

export function reverseProxySupport(rosVersion: string | null, architecture: string | null): ProxySupport {
  if ((architecture ?? '').toLowerCase() === 'smips') return 'unsupported';
  if (!parseRosVersion(rosVersion)) return 'unknown';
  return compareRosVersions(rosVersion, REVERSE_PROXY_MIN_VERSION) < 0 ? 'too-old' : 'supported';
}

export interface ProxyRule {
  id: string;
  sni: string;
  ipAddress: string | null;
  port: number | null;
  certificate: string | null;
  vrf: string | null;
  comment: string | null;
  disabled: boolean;
  dynamic: boolean;
}

/** Rules as RouterOS prints them, field by field. */
export function rulesFrom(rows: Ros[]): ProxyRule[] {
  return rows.map((r) => ({
    id: r['.id'] ?? '',
    sni: (r.sni ?? '').trim(),
    ipAddress: (r['ip-address'] ?? '').trim() || null,
    port: Number.isInteger(Number(r.port)) && r.port ? Number(r.port) : null,
    certificate: r.certificate && r.certificate !== 'none' ? r.certificate : null,
    vrf: (r.vrf ?? '').trim() || null,
    comment: (r.comment ?? '').trim() || null,
    disabled: yes(r.disabled),
    dynamic: yes(r.dynamic),
  })).filter((r) => r.id && r.sni);
}

export interface ProxyService {
  /** The reverse-proxy service, when the device has one. */
  port: number | null;
  certificate: string | null;
  disabled: boolean;
  invalid: boolean;
  /** www-ssl (WebFig over HTTPS), which defaults to the same port. */
  wwwSslPort: number | null;
  wwwSslDisabled: boolean;
}

const svc = (services: Ros[], name: string) => {
  const rows = services.filter((s) => s.name === name);
  return rows.find((s) => !yes(s.disabled)) ?? rows[0];
};
const portOf = (r: Ros | undefined) => (r?.port && Number.isInteger(Number(r.port)) ? Number(r.port) : null);

export function serviceFrom(services: Ros[]): ProxyService {
  const rp = svc(services, 'reverse-proxy');
  const www = svc(services, 'www-ssl');
  return {
    port: portOf(rp),
    certificate: rp?.certificate && rp.certificate !== 'none' ? rp.certificate : null,
    disabled: rp ? yes(rp.disabled) : true,
    invalid: rp ? yes(rp.invalid) : false,
    wwwSslPort: portOf(www),
    wwwSslDisabled: www ? yes(www.disabled) : true,
  };
}

/** Both services enabled on one port: one of them can't listen. */
export function portClash(s: ProxyService): boolean {
  return !s.disabled && !s.wwwSslDisabled && s.port !== null && s.port === s.wwwSslPort;
}

/**
 * A port to move one of the two services to: free among the device's enabled
 * services (the other one included), so the move doesn't make a new clash.
 * The reverse proxy only holds its port while it has an enabled rule.
 */
export function movePortError(services: Ros[], service: 'www-ssl' | 'reverse-proxy', port: unknown, proxyActive = true): string | null {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Enter a port from 1 to 65535.';
  // An idle proxy and WebFig on one port is RouterOS's default; the clash
  // check catches it when a rule is added.
  const taken = services.find((s) => s.name !== service && !yes(s.disabled) && Number(s.port) === n
    && (proxyActive || (s.name !== 'reverse-proxy' && !(service === 'reverse-proxy' && s.name === 'www-ssl'))));
  if (taken) return `Port ${n} is already used by ${taken.name}.`;
  return null;
}

// ─── Host names and certificates ─────────────────────────────────────────────

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host name a rule can match: exact, so no wildcard; not an IP address. */
export function sniError(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!s) return 'Enter the host name clients will use, like nas.example.com.';
  if (s.includes('*')) return 'RouterOS matches host names exactly, so a wildcard matches nothing. Add a rule per name.';
  if (isIP(s)) return 'Enter a host name, not an IP address: the rule matches the name the browser asks for.';
  if (s.length > 253 || !s.split('.').every((l) => LABEL.test(l))) return 'That isn\'t a valid host name.';
  return null;
}

export const normalizeSni = (raw: string) => raw.trim().toLowerCase().replace(/\.$/, '');

/** Whether a certificate's names cover a host name; a wildcard covers one label. */
export function certCovers(sni: string, commonName: string | undefined, subjectAltName: string | undefined): boolean {
  const host = normalizeSni(sni);
  const sans = (subjectAltName ?? '').split(',').map((s) => s.trim())
    .filter((s) => /^DNS:/i.test(s)).map((s) => s.slice(4).trim().toLowerCase());
  // Browsers ignore the common name when there are DNS names; without any, it's all there is.
  const names = sans.length ? sans : [(commonName ?? '').trim().toLowerCase()];
  return names.some((n) => {
    if (!n) return false;
    if (n === host) return true;
    if (n.startsWith('*.')) {
      const rest = n.slice(2);
      const dot = host.indexOf('.');
      return dot > 0 && host.slice(dot + 1) === rest;
    }
    return false;
  });
}

export interface CertInfo { name: string; commonName?: string; subjectAltName?: string; privateKey: boolean; expired: boolean; invalidAfter?: string }

export function certsFrom(rows: Ros[]): CertInfo[] {
  return rows.filter((r) => r.name).map((r) => ({
    name: r.name,
    commonName: r['common-name'],
    subjectAltName: r['subject-alt-name'],
    privateKey: yes(r['private-key']),
    expired: yes(r.expired),
    invalidAfter: r['invalid-after'],
  }));
}

// ─── Rule form ───────────────────────────────────────────────────────────────

export interface RuleCheck { params: Record<string, string>; errors: Record<string, string> }

const COMMENT_MAX = 255;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Check a rule from the form. `existing` is the rule being edited; what the
 * form leaves out keeps its value. A certificate must be on the device with
 * its key, not expired, and name the host, or the browser refuses it.
 */
export function checkRule(
  body: Record<string, unknown>,
  ctx: { certs: CertInfo[]; vrfs: string[]; existing?: ProxyRule },
): RuleCheck {
  const errors: Record<string, string> = {};
  const params: Record<string, string> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const ex = ctx.existing;

  let sni = ex?.sni ?? '';
  if (has('sni') || !ex) {
    const e = sniError(String(body.sni ?? ''));
    if (e) errors.sni = e; else { sni = normalizeSni(String(body.sni)); params.sni = sni; }
  }
  if (has('ip-address') || !ex) {
    const ip = String(body['ip-address'] ?? '').trim();
    if (!isIP(ip)) errors['ip-address'] = 'Enter the web server\'s IPv4 or IPv6 address.';
    else params['ip-address'] = ip;
  }
  if (has('port') || !ex) {
    const p = Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.port = 'Enter the web server\'s port, 1 to 65535. The router connects to it over plain HTTP.';
    else params.port = String(p);
  }
  if (has('certificate')) {
    const c = String(body.certificate ?? '').trim();
    if (!c || c === 'none') params.certificate = 'none';
    else {
      const cert = ctx.certs.find((x) => x.name === c);
      if (!cert) errors.certificate = `${c} isn't a certificate on this device.`;
      else if (!cert.privateKey) errors.certificate = `${c} has no private key on the device, so it can't be served.`;
      else if (cert.expired) errors.certificate = `${c} has expired.`;
      else if (sni && !errors.sni && !certCovers(sni, cert.commonName, cert.subjectAltName)) {
        errors.certificate = `${c} isn't for ${sni}, so browsers would refuse it. Choose one that names it, or issue one from the CA.`;
      } else params.certificate = c;
    }
  }
  if (has('vrf') && String(body.vrf ?? '').trim()) {
    const v = String(body.vrf).trim();
    if (!ctx.vrfs.includes(v)) errors.vrf = `${v} isn't a VRF on this device.`;
    else params.vrf = v;
  }
  if (has('comment')) {
    const c = String(body.comment ?? '');
    if (c.length > COMMENT_MAX) errors.comment = `Keep the comment under ${COMMENT_MAX} characters.`;
    else if (CONTROL.test(c)) errors.comment = 'The comment can\'t contain line breaks or control characters.';
    else params.comment = c;
  }
  if (has('disabled')) {
    const d = body.disabled;
    if (typeof d !== 'boolean') errors.disabled = 'Must be true or false.';
    else params.disabled = d ? 'yes' : 'no';
  }
  return { params: Object.keys(errors).length ? {} : params, errors };
}

// ─── Let's Encrypt (ACME) ────────────────────────────────────────────────────
//
// RouterOS 7.22 and later requests the certificate itself (/certificate/add-acme)
// with the HTTP-01 challenge, so the name must resolve to the router in public
// DNS and TCP port 80 must reach it from the internet. It renews at 80% of the
// lifetime. The certificate entry exists from the start (acme-managed) and a
// rule can use it before it's issued; a failed request is removed and added
// again to retry. Seen on 7.25.1: acme-status goes "generating private key",
// "requesting validation", then issued, or "http-01 challenge validation
// failed, <reason>".

export const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
export const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

/** The certificate's name on the device: one per host name and server. */
export function acmeCertName(sni: string, staging: boolean): string {
  return `mtm-le-${staging ? 'staging-' : ''}${normalizeSni(sni)}`;
}

export const isAcmeName = (name: string | null | undefined) => /^mtm-le-/.test(name ?? '');

/** Suffixes Let's Encrypt never issues for: names that only exist inside a network. */
const PRIVATE_SUFFIXES = ['local', 'lan', 'internal', 'intranet', 'home', 'home.arpa', 'corp', 'localdomain', 'localhost',
  'test', 'invalid', 'example', 'private', 'domain', 'arpa'];

export function acmeNameError(raw: string): string | null {
  const s = normalizeSni(raw);
  const bad = sniError(s);
  if (bad) return bad;
  if (!s.includes('.')) return 'Let\'s Encrypt needs a full public name, like nas.example.com.';
  if (PRIVATE_SUFFIXES.some((x) => s === x || s.endsWith(`.${x}`))) {
    return `Let's Encrypt only issues certificates for public names, and ${s} is internal. Use the manager's CA for it.`;
  }
  return null;
}

export type AcmePhase = 'pending' | 'issued' | 'failed';

export interface AcmeCert {
  id: string;
  name: string;
  domain: string;
  staging: boolean;
  phase: AcmePhase;
  status: string | null;
  invalidAfter: string | null;
}

export function acmePhase(r: Ros): AcmePhase {
  if (yes(r.issued) && yes(r['private-key'])) return 'issued';
  const status = `${r['acme-status'] ?? ''} ${r['.about'] ?? ''}`;
  return /fail|error|invalid|denied|unauthori[sz]ed|rejected/i.test(status) ? 'failed' : 'pending';
}

/** The device's ACME certificates, as the page and the routes need them. */
export function acmeCertsFrom(rows: Ros[]): AcmeCert[] {
  return rows.filter((r) => yes(r['acme-managed']) && r.name).map((r) => {
    const phase = acmePhase(r);
    return {
      id: r['.id'] ?? '',
      name: r.name,
      domain: (r['domain-names'] ?? '').trim(),
      staging: /staging/i.test(r['directory-url'] ?? ''),
      phase,
      status: (r['acme-status'] ?? '').trim() || null,
      invalidAfter: phase === 'issued' ? r['invalid-after'] ?? null : null,
    };
  });
}
