/**
 * User Manager (RouterOS's RADIUS server), read for the Services page (#251).
 *
 * Every menu is read through an allow-list: user passwords, OTP secrets,
 * router shared secrets and the PayPal/web credentials never leave the
 * backend, whatever RouterOS returns. Pure, so it can be tested without a
 * device. Field names are as a CHR on 7.24.5 reports them (#251).
 */

type Row = Record<string, string>;

const pick = (row: Row, keys: string[]): Row => {
  const out: Row = {};
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k];
  return out;
};

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';

export const SETTINGS_FIELDS = ['enabled', 'authentication-port', 'accounting-port', 'certificate', 'radsec-certificate', 'use-profiles', 'require-message-auth'];
export const USER_FIELDS = ['.id', 'name', 'group', 'shared-users', 'caller-id', 'attributes', 'disabled', 'comment'];
export const GROUP_FIELDS = ['.id', 'name', 'default', 'default-name', 'outer-auths', 'inner-auths', 'attributes', 'comment'];
export const ROUTER_FIELDS = ['.id', 'name', 'address', 'protocol', 'coa-port', 'disabled', 'comment'];
export const SESSION_FIELDS = [
  '.id', 'user', 'active', 'status', 'started', 'ended', 'uptime', 'download', 'upload',
  'nas-ip-address', 'nas-identifier', 'nas-port-id', 'nas-port-type', 'calling-station-id',
  'acct-session-id', 'last-accounting-packet', 'terminate-cause',
];

/** Never sent to the browser, even if a release starts returning them in print. */
export const SECRET_FIELDS = ['password', 'otp-secret', 'shared-secret', 'paypal-password', 'paypal-signature', 'web-private-password'];

export const pickSettings = (r: Row | undefined): Row => pick(r ?? {}, SETTINGS_FIELDS);
export const pickUsers = (rows: Row[]): Row[] => rows.map((r) => pick(r, USER_FIELDS));
export const pickGroups = (rows: Row[]): Row[] => rows.map((r) => pick(r, GROUP_FIELDS));
export const pickRouters = (rows: Row[]): Row[] => rows.map((r) => pick(r, ROUTER_FIELDS));

export const RECENT_SESSIONS = 100;

/**
 * Every active session, plus the most recent ended ones. A hotspot can hold
 * thousands of old sessions; the page only needs who's on now and what just
 * happened.
 */
export function pickSessions(rows: Row[], recent = RECENT_SESSIONS): { active: Row[]; recent: Row[] } {
  const sessions = rows.map((r) => pick(r, SESSION_FIELDS));
  const byStart = (a: Row, b: Row) => (b['started'] || '').localeCompare(a['started'] || '');
  return {
    active: sessions.filter((s) => isTrue(s['active'])).sort(byStart),
    recent: sessions.filter((s) => !isTrue(s['active'])).sort(byStart).slice(0, recent),
  };
}

/** A RouterOS item id: `*` and hex digits. */
export function isItemId(id: string): boolean {
  return /^\*[0-9A-Fa-f]{1,8}$/.test(id);
}

/** "Mikrotik-Group:full,Cisco-AVPair:shell:priv-lvl=15" → [["Mikrotik-Group","full"], …] */
export function splitAttributes(v: string | undefined): [string, string][] {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => {
    const i = a.indexOf(':');
    return i < 0 ? [a, ''] : [a.slice(0, i), a.slice(i + 1)];
  });
}

/**
 * Which managed device each authenticating device (NAS) is, by address.
 * `devices` carries every address a managed device has.
 */
export function matchNasToDevices(
  routers: Row[], devices: { id: number; name: string; addresses: string[] }[],
): Map<string, { id: number; name: string }> {
  const byAddress = new Map<string, { id: number; name: string }>();
  for (const d of devices) for (const a of d.addresses) if (a && !byAddress.has(a)) byAddress.set(a, { id: d.id, name: d.name });
  const out = new Map<string, { id: number; name: string }>();
  for (const r of routers) {
    const addr = (r['address'] || '').split('/')[0].trim();
    const hit = byAddress.get(addr);
    if (hit && r['.id']) out.set(r['.id'], hit);
  }
  return out;
}
