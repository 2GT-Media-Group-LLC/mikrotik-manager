/**
 * SSH host key pinning for every SSH connection the manager makes (outside
 * review P1-4). Spread into ssh2's connect options, after the device's route
 * (jumpHosts.ts), which it is checked with:
 *
 *   conn.connect({ host, port, username, ...await sshRoute(device, port),
 *     ...sshHostCheck(host, port, device.jump_host_id), ...auth });
 *
 * The first host key seen for a device is pinned; a different one refuses the
 * connection before authentication. ssh2 then reports only "Host denied", so
 * explainSshError() swaps that for what actually happened.
 */
import { verifyDeviceIdentity, sshHostKeyFingerprint, IdentityMismatchError } from './identityPins';

const lastRefusal = new Map<string, string>();
const key = (host: string, port: number, jumpHostId: number | null): string => `${host}:${port}:${jumpHostId ?? ''}`;

export function sshHostCheck(host: string, port: number, jumpHostId: number | null): {
  hostVerifier: (hostKey: Buffer, verify: (ok: boolean) => void) => void;
} {
  return {
    hostVerifier: (hostKey, verify) => {
      verifyDeviceIdentity('ssh-host', host, port, sshHostKeyFingerprint(hostKey), jumpHostId)
        .then(() => { lastRefusal.delete(key(host, port, jumpHostId)); verify(true); })
        .catch((err: unknown) => {
          lastRefusal.set(key(host, port, jumpHostId), err instanceof IdentityMismatchError
            ? err.message
            : `The SSH host key could not be checked: ${(err as Error).message}`);
          verify(false);
        });
    },
  };
}

/** The real reason behind ssh2's "Host denied (verification failed)", when there is one. */
export function explainSshError(err: unknown, host: string, port: number, jumpHostId: number | null = null): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (/host denied/i.test(e.message)) {
    const reason = lastRefusal.get(key(host, port, jumpHostId));
    if (reason) return new Error(reason, { cause: e });
  }
  return e;
}
