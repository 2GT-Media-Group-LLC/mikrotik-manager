/**
 * SSH host key pinning for every SSH connection the manager makes (outside
 * review P1-4). Spread into ssh2's connect options:
 *
 *   conn.connect({ host, port, username, ...sshHostCheck(host, port), ...auth });
 *
 * The first host key seen for a device is pinned; a different one refuses the
 * connection before authentication. ssh2 then reports only "Host denied", so
 * explainSshError() swaps that for what actually happened.
 */
import { verifyDeviceIdentity, sshHostKeyFingerprint, IdentityMismatchError } from './identityPins';

const lastRefusal = new Map<string, string>();
const key = (host: string, port: number): string => `${host}:${port}`;

export function sshHostCheck(host: string, port: number): {
  hostVerifier: (hostKey: Buffer, verify: (ok: boolean) => void) => void;
} {
  return {
    hostVerifier: (hostKey, verify) => {
      verifyDeviceIdentity('ssh-host', host, port, sshHostKeyFingerprint(hostKey))
        .then(() => { lastRefusal.delete(key(host, port)); verify(true); })
        .catch((err: unknown) => {
          lastRefusal.set(key(host, port), err instanceof IdentityMismatchError
            ? err.message
            : `The SSH host key could not be checked: ${(err as Error).message}`);
          verify(false);
        });
    },
  };
}

/** The real reason behind ssh2's "Host denied (verification failed)", when there is one. */
export function explainSshError(err: unknown, host: string, port: number): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (/host denied/i.test(e.message)) {
    const reason = lastRefusal.get(key(host, port));
    if (reason) return new Error(reason, { cause: e });
  }
  return e;
}
