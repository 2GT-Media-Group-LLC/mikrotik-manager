/**
 * Connect to a device's API, preferring API-SSL (outside review P1-4).
 *
 * The plain API (8728) sends the login in the clear on every poll. When no port
 * was chosen, API-SSL (8729) is tried first and the plain API is the fallback,
 * both at once so a device without API-SSL costs no extra wait.
 */
import { RouterOSClient } from './RouterOSClient';

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
  opts: { sslTimeoutMs?: number; plainTimeoutMs?: number } = {},
): Promise<PreferredConnection> {
  const ssl = new RouterOSClient(address, API_SSL_PORT, username, password, opts.sslTimeoutMs ?? 6_000);
  const plain = new RouterOSClient(address, API_PORT, username, password, opts.plainTimeoutMs ?? 10_000);
  const sslAttempt = ssl.connect().then(() => ssl);
  const plainAttempt = plain.connect().then(() => plain);
  // Whichever isn't used must not surface later as an unhandled rejection.
  plainAttempt.catch(() => {});

  try {
    const client = await sslAttempt;
    void plainAttempt.then((c) => c.disconnect(), () => {});
    return { client, port: API_SSL_PORT };
  } catch (sslErr) {
    ssl.disconnect();
    const client = await plainAttempt; // its error is the one worth reporting
    return { client, port: API_PORT, sslError: describeSslFailure(sslErr) };
  }
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
