/**
 * Reverse proxy form checks (#358), the same the server makes
 * (backend/src/utils/reverseProxy.ts), so the form says what's wrong inline.
 */
import { isValidIPv4, isValidIPv6 } from './deviceAddress';
import type { ProxyCertInfo } from '../services/api';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const normalizeSni = (raw: string) => raw.trim().toLowerCase().replace(/\.$/, '');

export function sniError(raw: string): string | null {
  const s = normalizeSni(raw);
  if (!s) return 'Enter the host name clients will use, like nas.example.com.';
  if (s.includes('*')) return 'RouterOS matches host names exactly, so a wildcard matches nothing. Add a rule per name.';
  if (isValidIPv4(s) || isValidIPv6(s)) return 'Enter a host name, not an IP address: the rule matches the name the browser asks for.';
  if (s.length > 253 || !s.split('.').every((l) => LABEL.test(l))) return 'That isn\'t a valid host name.';
  return null;
}

export function certCovers(sni: string, commonName: string | undefined, subjectAltName: string | undefined): boolean {
  const host = normalizeSni(sni);
  const sans = (subjectAltName ?? '').split(',').map((s) => s.trim())
    .filter((s) => /^DNS:/i.test(s)).map((s) => s.slice(4).trim().toLowerCase());
  const names = sans.length ? sans : [(commonName ?? '').trim().toLowerCase()];
  return names.some((n) => {
    if (!n) return false;
    if (n === host) return true;
    if (n.startsWith('*.')) {
      const dot = host.indexOf('.');
      return dot > 0 && host.slice(dot + 1) === n.slice(2);
    }
    return false;
  });
}

/** The value the certificate menu uses for "issue one from the manager's CA". */
export const ISSUE_FROM_CA = '__issue__';
/** And for "Let's Encrypt": RouterOS requests and renews it (#358). */
export const LETS_ENCRYPT = '__acme__';

export const isAcmeName = (name: string | null | undefined) => /^mtm-le-/.test(name ?? '');

const PRIVATE_SUFFIXES = ['local', 'lan', 'internal', 'intranet', 'home', 'home.arpa', 'corp', 'localdomain', 'localhost',
  'test', 'invalid', 'example', 'private', 'domain', 'arpa'];

/** The server's rule: Let's Encrypt only issues for public names. */
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

export interface RuleForm {
  sni: string;
  ip: string;
  port: string;
  certificate: string;
  vrf: string;
  comment: string;
  enabled: boolean;
}

export function ruleErrors(f: RuleForm, ctx: { certs: ProxyCertInfo[]; vrfs: string[]; others: { sni: string; disabled: boolean }[] }): Record<string, string> {
  const e: Record<string, string> = {};
  const s = sniError(f.sni);
  if (s) e.sni = s;
  else if (f.enabled && ctx.others.some((o) => !o.disabled && o.sni === normalizeSni(f.sni))) e.sni = `There's already a rule for ${normalizeSni(f.sni)}.`;
  const ip = f.ip.trim();
  if (!isValidIPv4(ip) && !isValidIPv6(ip)) e.ip = 'Enter the web server\'s IPv4 or IPv6 address.';
  const p = Number(f.port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = 'Enter the web server\'s port, 1 to 65535.';
  if (f.certificate === LETS_ENCRYPT && !s) {
    const a = acmeNameError(f.sni);
    if (a) e.sni = a;
  }
  if (f.certificate && f.certificate !== 'none' && f.certificate !== ISSUE_FROM_CA && f.certificate !== LETS_ENCRYPT) {
    const c = ctx.certs.find((x) => x.name === f.certificate);
    if (!c) e.certificate = `${f.certificate} isn't on this device any more.`;
    else if (c.expired) e.certificate = `${c.name} has expired.`;
    else if (!s && !certCovers(f.sni, c.commonName, c.subjectAltName)) e.certificate = `${c.name} isn't for ${normalizeSni(f.sni)}, so browsers would refuse it.`;
  }
  if (f.vrf && !ctx.vrfs.includes(f.vrf)) e.vrf = `${f.vrf} isn't a VRF on this device.`;
  if (f.comment.length > 255) e.comment = 'Keep the comment under 255 characters.';
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001f\u007f]/.test(f.comment)) e.comment = 'The comment can\'t contain line breaks or control characters.';
  return e;
}

/** A port to move one of the two services to, free among the enabled ones. */
export function movePortError(services: { name: string; port: number | null; disabled: boolean }[], service: string, port: string, proxyActive = true): string | null {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Enter a port from 1 to 65535.';
  // The reverse proxy only holds its port while it has an enabled rule.
  // An idle proxy and WebFig on one port is RouterOS's default; adding a rule checks it.
  const taken = services.find((s) => s.name !== service && !s.disabled && s.port === n
    && (proxyActive || (s.name !== 'reverse-proxy' && !(service === 'reverse-proxy' && s.name === 'www-ssl'))));
  return taken ? `Port ${n} is already used by ${taken.name}.` : null;
}
