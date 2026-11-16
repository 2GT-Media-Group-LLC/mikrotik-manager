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

// ─── Writes (#360) ───────────────────────────────────────────────────────────

const PRINTABLE_ONE_LINE = (v: string) => ![...v].some((c) => c.charCodeAt(0) < 32);

/** A user as an admin edits it: RouterOS fields, or what's wrong. */
export function parseUmUser(body: Record<string, unknown>, adding: boolean, opts: {
  isSealed: (v: unknown) => boolean;
  withVlanAttributes: (existing: string, vlan: number | null) => string;
}): { fields: Record<string, string> } | { error: string; field: string } {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const f: Record<string, string> = {};
  if (adding || has('name')) {
    const n = body.name;
    if (typeof n !== 'string' || !n.trim() || n.length > 64 || !PRINTABLE_ONE_LINE(n)) return { error: 'The username is 1 to 64 characters.', field: 'name' };
    f.name = n.trim();
  }
  if (adding || (has('password') && body.password !== '')) {
    const p = body.password;
    if (typeof p !== 'string' || !p || p.length > 128) return { error: 'Enter a password, up to 128 characters.', field: 'password' };
    if (opts.isSealed(p)) return { error: 'Enter the password itself.', field: 'password' };
    f.password = p;
  }
  if (has('group')) {
    const g = body.group;
    if (typeof g !== 'string' || !g || g.length > 64 || !PRINTABLE_ONE_LINE(g)) return { error: 'Choose a group.', field: 'group' };
    f.group = g;
  }
  if (has('shared_users')) {
    const n = body.shared_users;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 1000) return { error: 'Sessions at once is 1 to 1000.', field: 'shared_users' };
    f['shared-users'] = String(n);
  }
  if (has('attributes') || has('vlan_id')) {
    const a = body.attributes === undefined || body.attributes === null ? '' : body.attributes;
    if (typeof a !== 'string' || a.length > 1000 || !PRINTABLE_ONE_LINE(a)
      || a.split(',').map((s) => s.trim()).filter(Boolean).some((x) => !/^[A-Za-z][A-Za-z0-9-]*:.+$/.test(x))) {
      return { error: 'Attributes are Name:value pairs separated by commas.', field: 'attributes' };
    }
    let vlan: number | null = null;
    if (body.vlan_id !== undefined && body.vlan_id !== null) {
      if (!Number.isInteger(body.vlan_id) || (body.vlan_id as number) < 1 || (body.vlan_id as number) > 4094) return { error: 'A VLAN ID is 1 to 4094.', field: 'vlan_id' };
      vlan = body.vlan_id as number;
    }
    f.attributes = opts.withVlanAttributes(a, vlan);
  }
  if (has('disabled')) {
    if (typeof body.disabled !== 'boolean') return { error: 'disabled is true or false.', field: 'disabled' };
    f.disabled = body.disabled ? 'yes' : 'no';
  }
  if (has('comment')) {
    const c = body.comment;
    if (typeof c !== 'string' || c.length > 255 || !PRINTABLE_ONE_LINE(c)) return { error: 'The comment is up to 255 characters on one line.', field: 'comment' };
    f.comment = c;
  }
  if (Object.keys(f).length === 0) return { error: 'Nothing to change.', field: '' };
  return { fields: f };
}
