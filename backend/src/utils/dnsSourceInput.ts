// Checking an AdGuard Home source as an admin enters it (#366 step 3).
//
// The password follows the rule the alert channels learned
// (GHSA-qm4w-hmcg-7rq9): left out, it keeps the saved one, but only while the
// address and its TLS check stay as they were. Pointing a source somewhere
// else, or turning the certificate check off, needs the password typed again,
// so a saved one is never sent to a server it wasn't saved for. A value that
// arrives already encrypted is refused.

import { isSealed } from './sealed';

export interface DnsSourceInput {
  name: string;
  kind: 'adguard' | 'pihole';
  site_id: number;
  url: string;
  username: string;
  /** undefined: keep the saved password (an update), '' : none. */
  password?: string;
  tls_verify: boolean;
  enabled: boolean;
}

export interface SavedSource { url: string; tls_verify: boolean; password: string }

/** A base address MikroTik Manager may call: http(s), no credentials, no query or fragment. */
export function urlError(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return 'Enter the server\'s web address, like http://192.168.88.2.';
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'That isn\'t a valid address.'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The address must start with http:// or https://.';
  if (u.username || u.password) return 'Put the username and password in their own fields, not in the address.';
  if (u.search || u.hash) return 'Leave out anything after ? or #.';
  return null;
}

/** The input checked, or what's wrong with it. `saved` is the source being edited. */
export function parseDnsSource(body: Record<string, unknown>, saved?: SavedSource): { value: DnsSourceInput } | { error: string; field: string } {
  const kind = body.kind === undefined ? 'adguard' : body.kind;
  if (kind !== 'adguard' && kind !== 'pihole') return { error: 'Choose AdGuard Home or Pi-hole.', field: 'kind' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) return { error: 'Give the source a name, up to 100 characters.', field: 'name' };
  const siteId = Number(body.site_id);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return { error: 'Choose the site whose clients use this DNS server.', field: 'site_id' };
  const ue = urlError(body.url);
  if (ue) return { error: ue, field: 'url' };
  const url = String(body.url).trim().replace(/\/+$/, '');
  const username = body.username === undefined || body.username === null ? '' : body.username;
  if (typeof username !== 'string' || username.length > 200) return { error: 'The username is up to 200 characters.', field: 'username' };
  const tlsVerify = body.tls_verify === undefined ? true : body.tls_verify;
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof tlsVerify !== 'boolean' || typeof enabled !== 'boolean') return { error: 'tls_verify and enabled are true or false.', field: 'tls_verify' };

  let password: string | undefined;
  if (body.password !== undefined && body.password !== null) {
    if (typeof body.password !== 'string' || body.password.length > 500) return { error: 'The password is up to 500 characters.', field: 'password' };
    if (isSealed(body.password)) return { error: 'Enter the password itself. A value starting with "enc:" isn\'t accepted.', field: 'password' };
    password = body.password;
  }
  if (password === undefined && saved && saved.password) {
    const moved = url !== saved.url || (saved.tls_verify && !tlsVerify);
    if (moved) return { error: 'The address or its certificate check changed, so enter the password again.', field: 'password' };
  }
  // Pi-hole logs in with a password alone.
  return { value: { name, kind, site_id: siteId, url, username: kind === 'pihole' ? '' : username, password, tls_verify: tlsVerify, enabled } };
}
