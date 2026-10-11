/**
 * Whether a device's API connection uses TLS (#257).
 *
 * RouterOS runs api-ssl on 8729 by convention, and that used to be the only
 * signal: any other port was assumed to be the plain API. Behind NAT, or where
 * 8729 is blocked, api-ssl runs on other ports too, so a device can now say so
 * explicitly. NULL (devices added before this) keeps the old rule.
 */
export const API_SSL_DEFAULT_PORT = 8729;

export interface ApiTlsFields {
  api_port: number | null | undefined;
  api_tls?: boolean | null;
}

export function usesApiTls(d: ApiTlsFields): boolean {
  if (typeof d.api_tls === 'boolean') return d.api_tls;
  return d.api_port === API_SSL_DEFAULT_PORT;
}

/** The RouterOS service the manager connects to: api-ssl or api. */
export function managementService(d: ApiTlsFields): 'api-ssl' | 'api' {
  return usesApiTls(d) ? 'api-ssl' : 'api';
}

/**
 * An explicit TLS choice from a request body or CSV column, or null when none
 * was given (the port then decides). Unrecognised values count as none.
 */
export function parseApiTls(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'ssl', 'tls', 'api-ssl'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'plain', 'api'].includes(v)) return false;
  return null;
}

/**
 * A port from a request body, checked: null when not given, otherwise a whole
 * number from 1 to 65535. Used to fall back silently to the default for
 * anything unparseable, and accepted negative or out-of-range numbers.
 */
export function checkPort(value: unknown, label: string): { ok: true; port: number | null } | { ok: false; error: string } {
  if (value == null || value === '') return { ok: true, port: null };
  const s = typeof value === 'number' ? String(value) : String(value).trim();
  if (!/^\d{1,5}$/.test(s)) return { ok: false, error: `${label} must be a number from 1 to 65535.` };
  const n = Number(s);
  if (n < 1 || n > 65535) return { ok: false, error: `${label} must be a number from 1 to 65535.` };
  return { ok: true, port: n };
}
