/**
 * DNS over HTTPS server for /ip/dns use-doh-server (#468): empty to turn it
 * off, otherwise an https:// URL such as https://cloudflare-dns.com/dns-query.
 * Returns why it can't be used, or null when it can.
 */
export function dohServerError(raw: unknown): string | null {
  if (raw === '') return null;
  if (typeof raw !== 'string') return 'The DoH server must be text.';
  if (raw.length > 255) return 'The DoH server URL is too long.';
  if (!/^https:\/\//i.test(raw)) return 'The DoH server must be an https:// URL.';
  if (/[\s,;"'\\]/.test(raw)) return 'The DoH server URL can\u2019t contain spaces, commas, quotes or semicolons.';
  try {
    const u = new URL(raw);
    if (!u.hostname) return 'The DoH server URL needs a host name.';
  } catch {
    return 'The DoH server isn\u2019t a valid URL.';
  }
  return null;
}
