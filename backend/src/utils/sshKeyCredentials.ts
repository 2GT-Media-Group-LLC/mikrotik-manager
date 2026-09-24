/**
 * Which login installs a device's first SSH key.
 *
 * Key deployment used to require SSH credentials stored on the device, and
 * skipped every device without them, even though the rest of the platform
 * (backups, bulk commands) already falls back to the API login when SSH
 * fields are blank. Most fleets use one account for both, so most devices
 * could never be keyed without typing the same login in twice.
 *
 * The fallback is deliberately narrow, so it cannot key an account nobody chose:
 *
 *   - SSH username and password both set: use them. Unchanged.
 *   - Neither set: use the API username and password, as a pair.
 *   - SSH username set to the API username, no SSH password: the same account,
 *     so the API password is used.
 *   - Anything else (a different SSH username with no password, a password
 *     with no username) is refused with a reason. Pairing one account's name
 *     with another's password would be a guess.
 *
 * The consequence of keying is the same whichever login is used: RouterOS
 * refuses password SSH for that user afterwards. What changes with the
 * fallback is only *which* user, and the preview names it before anything runs.
 */

export interface KeyCredentialInput {
  ssh_username?: string | null;
  ssh_password_encrypted?: string | null;
  api_username?: string | null;
  api_password_encrypted?: string | null;
}

export type KeyCredentials =
  | { ok: true; username: string; passwordEncrypted: string; source: 'ssh' | 'api' }
  | { ok: false; reason: string };

const t = (v: string | null | undefined) => (v ?? '').trim();

export function resolveKeyCredentials(d: KeyCredentialInput): KeyCredentials {
  const sshUser = t(d.ssh_username);
  const sshPass = d.ssh_password_encrypted || '';
  const apiUser = t(d.api_username);
  const apiPass = d.api_password_encrypted || '';

  if (sshUser && sshPass) return { ok: true, username: sshUser, passwordEncrypted: sshPass, source: 'ssh' };

  if (!sshUser && !sshPass) {
    if (apiUser && apiPass) return { ok: true, username: apiUser, passwordEncrypted: apiPass, source: 'api' };
    return { ok: false, reason: 'No SSH or API login stored for this device.' };
  }

  if (sshUser && !sshPass) {
    if (apiUser && sshUser === apiUser && apiPass) {
      return { ok: true, username: apiUser, passwordEncrypted: apiPass, source: 'api' };
    }
    return {
      ok: false,
      reason: `SSH username "${sshUser}" has no SSH password, and it is not the API user. ` +
              'Add the SSH password, or clear the SSH username to use the API login.',
    };
  }

  return { ok: false, reason: 'An SSH password is stored without an SSH username. Add the username.' };
}

export interface KeyTargetRow extends KeyCredentialInput {
  status?: string | null;
  has_verified_key?: boolean | null;
}

export type KeyTargetClass =
  | { kind: 'eligible'; username: string; source: 'ssh' | 'api' }
  | { kind: 'keyed' }
  | { kind: 'skip'; reason: string };

/**
 * Whether a fleet job should key this device. Shared by the preview and the
 * job itself, which re-checks every device when it reaches it: the fleet can
 * change between the preview and the run.
 */
export function classifyKeyTarget(d: KeyTargetRow): KeyTargetClass {
  if (d.has_verified_key) return { kind: 'keyed' };
  if (d.status !== 'online') return { kind: 'skip', reason: 'Offline.' };
  const cred = resolveKeyCredentials(d);
  if (!cred.ok) return { kind: 'skip', reason: cred.reason };
  return { kind: 'eligible', username: cred.username, source: cred.source };
}
