/**
 * Running a command on a device over SSH, with whichever credential works.
 *
 * Console syntax — `:put`, `:foreach`, `/interface print` — is not reachable over
 * the binary API, which has its own command tree. Anything that runs what an
 * operator would type has to go over SSH (#118).
 *
 * Credential choice is not a preference. RouterOS refuses password
 * authentication for a user once a key is bound to them, so a device with an
 * installed key can *only* be reached by that key. Password is the path for
 * devices without one (#110).
 */
import { Client as SSHClient } from 'ssh2';
import { queryOne } from '../config/database';
import { decrypt } from '../utils/crypto';

export interface SshExecDevice {
  id: number;
  name: string;
  ip_address: string;
  ssh_port?: number | null;
  ssh_username?: string | null;
  ssh_password_encrypted?: string | null;
  api_username?: string | null;
  api_password_encrypted?: string | null;
}

export interface SshExecResult {
  /** Combined stdout and stderr, as an operator would see at a console. */
  output: string;
  /** Which credential actually carried the session. */
  auth: 'key' | 'password';
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the credential for a device.
 *
 * A key is used only when it has been *proved* — a key that was generated or
 * pushed but never authenticated is not evidence the device will accept it.
 */
async function resolveAuth(device: SshExecDevice): Promise<{
  username: string;
  auth: { password: string } | { privateKey: string };
  kind: 'key' | 'password';
}> {
  const key = await queryOne<{ private_key_encrypted: string; ssh_username: string | null }>(
    `SELECT private_key_encrypted, ssh_username FROM device_ssh_keys
      WHERE device_id = $1 AND status = 'verified'`,
    [device.id]
  );

  if (key) {
    const username = key.ssh_username || device.ssh_username || device.api_username;
    if (!username) throw new Error('No SSH username available for key authentication');
    return { username, auth: { privateKey: decrypt(key.private_key_encrypted) }, kind: 'key' };
  }

  const username = device.ssh_username || device.api_username;
  if (!username) throw new Error('No SSH username configured');
  const encrypted = device.ssh_password_encrypted || device.api_password_encrypted;
  if (!encrypted) throw new Error('No SSH credential configured');
  return { username, auth: { password: decrypt(encrypted) }, kind: 'password' };
}

/**
 * Run one command and return everything it printed.
 *
 * Errors are thrown, never swallowed. A command runner that reports success
 * because it discarded the failure is worse than one that does nothing — and a
 * quietly discarded error is exactly how a shipped feature spent a week doing
 * nothing at all.
 */
export async function runSshCommand(
  device: SshExecDevice,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SshExecResult> {
  const { username, auth, kind } = await resolveAuth(device);

  return new Promise<SshExecResult>((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* already closing */ }
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return finish(() => reject(err));
        let output = '';
        stream.on('data', (d: Buffer) => { output += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { output += d.toString(); });
        stream.on('close', () => finish(() => resolve({ output: output.trim(), auth: kind })));
      });
    });
    conn.on('error', (err) => finish(() => reject(err)));

    conn.connect({
      host: device.ip_address,
      port: device.ssh_port ?? 22,
      username,
      readyTimeout: Math.min(timeoutMs, 20_000),
      ...auth,
    });
  });
}

/**
 * Does RouterOS's output indicate the command failed?
 *
 * RouterOS reports most errors in the text rather than through an exit code, so
 * a command that "succeeded" and one that printed `syntax error` are
 * indistinguishable unless the output is read. Deliberately conservative: only
 * unambiguous markers count, because misreading ordinary output as failure would
 * halt a rollout that was working.
 */
export function looksLikeFailure(output: string): boolean {
  return /(^|\n)\s*(syntax error|bad command name|expected end of command|no such item|failure:|input does not match any value)/i
    .test(output);
}
