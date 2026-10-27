/**
 * Connect to a device's API, preferring API-SSL (outside review P1-4).
 *
 * The plain API (8728) sends the login in the clear on every poll. When no port
 * was chosen, API-SSL (8729) is tried first, and the plain API only if API-SSL
 * isn't available.
 */
import { RouterOSClient } from './RouterOSClient';
import { IdentityMismatchError } from '../identityPins';
import { classifyApiFailure } from '../../utils/sshOnly';

export const API_PORT = 8728;
export const API_SSL_PORT = 8729;

export interface PreferredConnection {
  client: RouterOSClient;
  port: number;
  /** Why API-SSL wasn't used, when the plain API was the fallback. */
  sslError?: string;
}

export async function connectPreferringSsl(
  address: string, username: string, password: string,
  /** jumpHostId: the device's route (null for direct). Required: a forgotten one would mean "direct". */
  opts: { sslTimeoutMs?: number; plainTimeoutMs?: number; sslOnly?: boolean; jumpHostId: number | null },
): Promise<PreferredConnection> {
  // One after the other, never both at once: the plain API sends the login in
  // the clear as soon as its socket opens, so trying it alongside API-SSL gave
  // the password away even when API-SSL worked (GHSA-63v6-w7qf-349f).
  const via = opts.jumpHostId;
  const ssl = new RouterOSClient(address, API_SSL_PORT, username, password, opts.sslTimeoutMs ?? 6_000, 30_000, true, via);
  let sslErr: unknown;
  try {
    await ssl.connect();
    return { client: ssl, port: API_SSL_PORT };
  } catch (err) {
    ssl.disconnect();
    sslErr = err;
  }
  // The plain API only when API-SSL isn't there to use (off, firewalled, no
  // certificate). A refused login or a changed certificate is the answer, and
  // a device known to have used API-SSL is never moved back to the plain API.
  if (opts.sslOnly || !sslUnavailable(sslErr)) throw sslErr;
  const plain = new RouterOSClient(address, API_PORT, username, password, opts.plainTimeoutMs ?? 10_000, 30_000, false, via);
  await plain.connect();
  return { client: plain, port: API_PORT, sslError: describeSslFailure(sslErr) };
}

/** API-SSL isn't there to use, as opposed to answering and refusing. */
export function sslUnavailable(err: unknown): boolean {
  if (err instanceof IdentityMismatchError) return false;
  const kind = classifyApiFailure(err).kind;
  return kind === 'unreachable' || kind === 'tls';
}

/** Why API-SSL didn't work, in words someone can act on. */
export function describeSslFailure(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const code = (err as NodeJS.ErrnoException)?.code;
  // RouterOS refuses the TLS handshake when api-ssl has no certificate.
  if (/handshake failure|alert number 40|no shared cipher/i.test(msg)) {
    return 'api-ssl is enabled but has no certificate, so it refuses TLS connections.';
  }
  if (code === 'ECONNREFUSED') return 'api-ssl is turned off, or not on port 8729.';
  if (/timeout/i.test(msg)) return 'Nothing answered on port 8729; api-ssl may be off or a firewall may block it.';
  if (/invalid user name or password/i.test(msg)) return 'The login was refused over api-ssl.';
  return msg.split('\n')[0].slice(0, 200);
}
