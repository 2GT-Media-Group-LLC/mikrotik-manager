/**
 * Whether a device's API connection uses TLS (#257). Mirrors the backend:
 * an explicit choice wins; without one, api-ssl means port 8729.
 */
export const API_SSL_PORT = 8729;

export function usesApiTls(d: { api_port?: number | null; api_tls?: boolean | null } | null | undefined): boolean {
  if (!d) return false;
  if (typeof d.api_tls === 'boolean') return d.api_tls;
  return d.api_port === API_SSL_PORT;
}

/** A port typed into a form: '' is fine (default), otherwise 1 to 65535. */
export function portFieldError(value: string, label: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) return `${label} must be a number from 1 to 65535.`;
  return null;
}
