// 802.1X on a device (#360): what an edit may set on the authenticator
// (/interface/dot1x/server), the supplicant (/interface/dot1x/client) and the
// RADIUS clients it asks (/radius), checked and turned into RouterOS fields.
// Field names and ranges are from MikroTik's Dot1X and RADIUS pages.
//
// On an update, a field left out is left alone and null clears it (setItem
// unsets an empty value); on an add, defaults are RouterOS's.

import { isSealed } from './sealed';

export const AUTH_TYPES = ['dot1x', 'mac-auth'] as const;
export const MAC_AUTH_MODES = ['mac-as-username', 'mac-as-username-and-password'] as const;
export const RADIUS_MAC_FORMATS = [
  'XX:XX:XX:XX:XX:XX', 'XX-XX-XX-XX-XX-XX', 'XXXXXXXXXXXX',
  'xx:xx:xx:xx:xx:xx', 'xx-xx-xx-xx-xx-xx', 'xxxxxxxxxxxx',
] as const;
export const EAP_METHODS = ['eap-tls', 'eap-ttls', 'eap-peap', 'eap-mschapv2'] as const;
export const RADIUS_SERVICES = ['dot1x', 'login', 'hotspot', 'ppp', 'wireless', 'dhcp', 'ipsec'] as const;

type Fields = Record<string, string>;
type Result = { fields: Fields } | { error: string; field: string };

const has = (b: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const yesNo = (v: boolean) => (v ? 'yes' : 'no');

function name(v: unknown, what: string): string | null {
  if (typeof v !== 'string' || !v || v.length > 64 || [...v].some((c) => c === ',' || c.charCodeAt(0) < 32)) return null;
  void what;
  return v;
}

function comment(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 255 || [...v].some((c) => c.charCodeAt(0) < 32)) return null;
  return v;
}

/** Seconds as a RouterOS time ("30s"), within bounds. */
function seconds(v: unknown, min: number, max: number): string | null {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? `${v}s` : null;
}

function vlan(v: unknown): string | null {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4094 ? String(v) : null;
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function setOf<T extends string>(v: unknown, list: readonly T[]): T[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > list.length) return null;
  const out = v.map((x) => oneOf(x, list));
  if (out.some((x) => x === null) || new Set(out).size !== out.length) return null;
  return out as T[];
}

/** An authenticator on a port: /interface/dot1x/server. */
export function parseDot1xServer(body: Record<string, unknown>, adding: boolean): Result {
  const f: Fields = {};
  if (adding || has(body, 'interface')) {
    const i = name(body.interface, 'interface');
    if (!i) return { error: 'Choose the port (or interface list) to authenticate on.', field: 'interface' };
    f.interface = i;
  }
  if (has(body, 'auth_types')) {
    const t = setOf(body.auth_types, AUTH_TYPES);
    if (!t) return { error: 'Choose dot1x, MAC authentication, or both.', field: 'auth_types' };
    f['auth-types'] = t.join(',');
  }
  if (has(body, 'accounting')) {
    if (typeof body.accounting !== 'boolean') return { error: 'accounting is true or false.', field: 'accounting' };
    f.accounting = yesNo(body.accounting);
  }
  const timers: Array<[string, string, number, number]> = [
    ['interim_update', 'interim-update', 0, 86_400], ['retrans_timeout', 'retrans-timeout', 1, 3600], ['auth_timeout', 'auth-timeout', 1, 3600],
  ];
  for (const [k, ros, min, max] of timers) {
    if (!has(body, k)) continue;
    const s = seconds(body[k], min, max);
    if (!s) return { error: `${k.replace(/_/g, ' ')} is ${min} to ${max} seconds.`, field: k };
    f[ros] = s;
  }
  if (has(body, 'reauth_timeout')) {
    if (body.reauth_timeout === null) f['reauth-timeout'] = '';
    else {
      const s = seconds(body.reauth_timeout, 60, 604_800);
      if (!s) return { error: 'Re-authenticate every 60 seconds to 7 days, or never.', field: 'reauth_timeout' };
      f['reauth-timeout'] = s;
    }
  }
  for (const [k, ros] of [['guest_vlan_id', 'guest-vlan-id'], ['reject_vlan_id', 'reject-vlan-id'], ['server_fail_vlan_id', 'server-fail-vlan-id']] as const) {
    if (!has(body, k)) continue;
    if (body[k] === null) { f[ros] = ''; continue; }
    const v = vlan(body[k]);
    if (!v) return { error: 'A VLAN ID is 1 to 4094.', field: k };
    f[ros] = v;
  }
  if (has(body, 'mac_auth_mode')) {
    const m = oneOf(body.mac_auth_mode, MAC_AUTH_MODES);
    if (!m) return { error: `mac_auth_mode is ${MAC_AUTH_MODES.join(' or ')}.`, field: 'mac_auth_mode' };
    f['mac-auth-mode'] = m;
  }
  if (has(body, 'radius_mac_format')) {
    const m = oneOf(body.radius_mac_format, RADIUS_MAC_FORMATS);
    if (!m) return { error: 'Choose one of the MAC address formats.', field: 'radius_mac_format' };
    f['radius-mac-format'] = m;
  }
  // RouterOS: "guest vlan not supported with mac-auth". A guest VLAN is for
  // devices that can't do 802.1X, which MAC authentication already covers.
  if (f['guest-vlan-id'] && f['auth-types']?.includes('mac-auth')) {
    return { error: 'A guest VLAN only works with dot1x alone: with MAC authentication on, devices without 802.1X use that instead.', field: 'guest_vlan_id' };
  }
  return common(body, f);
}

/** The device authenticating to an upstream switch: /interface/dot1x/client. */
export function parseDot1xClient(body: Record<string, unknown>, adding: boolean): Result {
  const f: Fields = {};
  if (adding || has(body, 'interface')) {
    const i = name(body.interface, 'interface');
    if (!i) return { error: 'Choose the port that connects to the authenticating switch.', field: 'interface' };
    f.interface = i;
  }
  if (adding || has(body, 'eap_methods')) {
    const m = setOf(body.eap_methods, EAP_METHODS);
    if (!m) return { error: 'Choose at least one EAP method.', field: 'eap_methods' };
    f['eap-methods'] = m.join(',');
  }
  for (const [k, ros, max] of [['identity', 'identity', 128], ['anon_identity', 'anon-identity', 128], ['client_certificate', 'client-certificate', 128]] as const) {
    if (!has(body, k)) continue;
    const v = body[k];
    if (typeof v !== 'string' || v.length > max || [...v].some((c) => c.charCodeAt(0) < 32)) return { error: `${k.replace(/_/g, ' ')} is up to ${max} characters.`, field: k };
    f[ros] = v;
  }
  if (has(body, 'password')) {
    const p = body.password;
    if (typeof p !== 'string' || p.length > 128) return { error: 'The password is up to 128 characters.', field: 'password' };
    if (isSealed(p)) return { error: 'Enter the password itself.', field: 'password' };
    f.password = p;
  }
  if (f['eap-methods']?.split(',').includes('eap-tls') && adding && !f['client-certificate']) {
    return { error: 'EAP-TLS needs a client certificate.', field: 'client_certificate' };
  }
  return common(body, f);
}

/** A RADIUS server the device asks: /radius. */
export function parseRadius(body: Record<string, unknown>, adding: boolean): Result {
  const f: Fields = {};
  if (adding || has(body, 'address')) {
    const a = body.address;
    if (typeof a !== 'string' || !/^[0-9A-Fa-f.:]{2,45}$/.test(a)) return { error: 'Enter the RADIUS server\'s IP address.', field: 'address' };
    f.address = a;
  }
  if (adding || has(body, 'service')) {
    const s = setOf(body.service, RADIUS_SERVICES);
    if (!s) return { error: 'Choose what it\'s asked about (802.1X for this page).', field: 'service' };
    f.service = s.join(',');
  }
  if (adding || has(body, 'secret')) {
    const s = body.secret;
    if (typeof s !== 'string' || !s || s.length > 128) return { error: 'Enter the shared secret, up to 128 characters.', field: 'secret' };
    if (isSealed(s)) return { error: 'Enter the secret itself.', field: 'secret' };
    f.secret = s;
  }
  for (const [k, ros] of [['authentication_port', 'authentication-port'], ['accounting_port', 'accounting-port']] as const) {
    if (!has(body, k)) continue;
    const p = body[k];
    if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535) return { error: 'A port is 1 to 65535.', field: k };
    f[ros] = String(p);
  }
  if (has(body, 'timeout')) {
    const v = body.timeout;
    if (!Number.isInteger(v) || (v as number) < 100 || (v as number) > 60_000) return { error: 'The timeout is 100 to 60000 milliseconds.', field: 'timeout' };
    f.timeout = `${v}ms`;
  }
  if (has(body, 'src_address')) {
    const a = body.src_address;
    if (a === null || a === '') f['src-address'] = '';
    else if (typeof a !== 'string' || !/^[0-9A-Fa-f.:]{2,45}$/.test(a)) return { error: 'The source address is an IP address.', field: 'src_address' };
    else f['src-address'] = a;
  }
  return common(body, f);
}

function common(body: Record<string, unknown>, f: Fields): Result {
  if (has(body, 'disabled')) {
    if (typeof body.disabled !== 'boolean') return { error: 'disabled is true or false.', field: 'disabled' };
    f.disabled = yesNo(body.disabled);
  }
  if (has(body, 'comment')) {
    const c = comment(body.comment);
    if (c === null) return { error: 'The comment is up to 255 characters on one line.', field: 'comment' };
    f.comment = c;
  }
  if (Object.keys(f).length === 0) return { error: 'Nothing to change.', field: '' };
  return { fields: f };
}

/** A shared secret for linking a device to User Manager: 32 letters and digits. */
export function newSharedSecret(random: (n: number) => Buffer): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out: string[] = [];
  // Rejection sampling, so every character is equally likely.
  while (out.length < 32) {
    for (const b of random(48)) {
      if (b < 256 - (256 % chars.length) && out.length < 32) out.push(chars[b % chars.length]);
    }
  }
  return out.join('');
}

/**
 * User Manager attributes that put an 802.1X client in a VLAN: the three
 * tunnel attributes RouterOS's dot1x server reads, added to any others.
 */
export function withVlanAttributes(existing: string, vlanId: number | null): string {
  const keep = existing.split(',').map((s) => s.trim()).filter(Boolean)
    .filter((a) => !/^(Tunnel-Type|Tunnel-Medium-Type|Tunnel-Private-Group-ID):/i.test(a));
  if (vlanId !== null) keep.push('Tunnel-Type:13', 'Tunnel-Medium-Type:6', `Tunnel-Private-Group-ID:${vlanId}`);
  return keep.join(',');
}

/** The VLAN a user's attributes assign, if any. */
export function vlanFromAttributes(attributes: string | undefined): number | null {
  const m = /(?:^|,)\s*Tunnel-Private-Group-ID:(\d{1,4})\s*(?:,|$)/i.exec(attributes ?? '');
  return m ? Number(m[1]) : null;
}
