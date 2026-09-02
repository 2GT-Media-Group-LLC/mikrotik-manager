/**
 * Deploying and verifying per-device SSH keys.
 *
 * The order of operations here is the whole point. A key is generated, pushed,
 * imported, and only then *proved* by opening a completely fresh connection and
 * authenticating with it. Nothing downstream trusts a key until that last step
 * succeeds — because "imported without error" and "the device will let me in"
 * are different claims, and the gap between them is where fleets become
 * unreachable (#110).
 *
 * The existing password is never removed as a side effect. Losing password
 * access is an explicit, separate decision, taken after keys are seen working.
 */
import { Client as SSHClient } from 'ssh2';
import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import {
  generateDeviceKeyPair, keyFileName, keyComment, isUsablePrivateKey, type KeyStatus,
} from '../utils/sshKeys';
import { RouterOSClient } from './mikrotik/RouterOSClient';

const CONNECT_TIMEOUT_MS = 20_000;

export interface SshTarget {
  id: number;
  name: string;
  ip_address: string;
  ssh_port: number | null;
  ssh_username: string | null;
  ssh_password_encrypted: string | null;
  /** The binary API is the recovery path: it is unaffected by SSH key state. */
  api_port: number | null;
  api_username: string | null;
  api_password_encrypted: string | null;
}

export interface DeviceKeyRow {
  device_id: number;
  key_type: string;
  public_key: string;
  private_key_encrypted: string;
  fingerprint: string | null;
  ssh_username: string | null;
  status: KeyStatus;
  last_error: string | null;
  last_verified_at: string | null;
}

type Auth = { password: string } | { privateKey: string };

/** One SSH session, with whichever credential the caller chose. */
function withSsh<T>(
  target: SshTarget,
  username: string,
  auth: Auth,
  work: (conn: SSHClient) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const conn = new SSHClient();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH timed out connecting to ${target.ip_address}`));
    }, CONNECT_TIMEOUT_MS);

    conn.on('ready', () => {
      work(conn)
        .then((r) => { clearTimeout(timer); conn.end(); resolve(r); })
        .catch((e) => { clearTimeout(timer); conn.end(); reject(e); });
    });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });

    conn.connect({
      host: target.ip_address,
      port: target.ssh_port ?? 22,
      username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      ...auth,
    });
  });
}

/** Run one command and collect its output. */
function exec(conn: SSHClient, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d: Buffer) => { out += d.toString(); });
      stream.stderr.on('data', (d: Buffer) => { out += d.toString(); });
      stream.on('close', () => resolve(out));
    });
  });
}

/** Upload the public key, which RouterOS needs as a real file before importing. */
function putFile(conn: SSHClient, remoteName: string, contents: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remoteName);
      ws.on('close', () => resolve());
      ws.on('error', reject);
      ws.end(contents);
    });
  });
}

export class SshKeyService {
  async getKey(deviceId: number): Promise<DeviceKeyRow | null> {
    return queryOne<DeviceKeyRow>(`SELECT * FROM device_ssh_keys WHERE device_id = $1`, [deviceId]);
  }

  /**
   * Remove an authorised key from the device over the binary API.
   *
   * The API is deliberately the tool for this. Once a key is bound to a user,
   * RouterOS refuses password SSH for that user, so a failed key deployment
   * would otherwise leave no way in over SSH at all. The API is unaffected by
   * any of that, which makes it the one reliable way to undo this feature.
   */
  private async removeKeyViaApi(
    target: SshTarget, comment: string, fingerprint?: string | null,
  ): Promise<number> {
    if (!target.api_username || !target.api_password_encrypted) {
      throw new Error('No API credentials available to remove the key');
    }
    const client = new RouterOSClient(
      target.ip_address, target.api_port ?? 8728,
      target.api_username, decrypt(target.api_password_encrypted),
    );
    // RouterOS keeps the key comment in `info`, not `key-owner` — matching the
    // latter silently matched nothing and left every rotation's old key behind.
    // Fingerprint is the stronger identity, so it is preferred where we have it;
    // RouterOS keeps the base64 padding that we strip, hence the normalisation.
    const norm = (f: string) => f.replace(/^SHA256:/, '').replace(/=+$/, '');
    const wantFp = fingerprint ? norm(fingerprint) : null;

    let removed = 0;
    try {
      await client.connect();
      const keys = await client.execute('/user/ssh-keys/print', { detail: '' });
      for (const k of keys) {
        const matchesFp = wantFp != null && norm(k['fingerprint'] || '') === wantFp;
        const matchesComment = comment.length > 0 && (k['info'] || '').includes(comment);
        if (matchesFp || matchesComment) {
          await client.execute('/user/ssh-keys/remove', { '.id': k['.id'] });
          removed++;
        }
      }
    } finally {
      client.disconnect();
    }
    return removed;
  }

  /**
   * Generate, deploy and verify a key for one device.
   *
   * Two things here were learned the hard way, on a switch that lost SSH.
   *
   * **Installing a key disables password SSH for that user.** RouterOS binds the
   * key and then refuses password authentication — confirmed by removing the key
   * and watching password login start working again. So a rotation cannot
   * authenticate with the password; it must use the key already in place.
   *
   * **The stored private key is not replaced until the new one is proved.** It
   * was, once, and a rotation that failed halfway left the database holding a
   * key the device had never authorised while the device held one we no longer
   * had. Nothing is overwritten until a fresh connection has authenticated with
   * the new key, and a deployment that fails verification removes the key it
   * just installed rather than leaving the device in that state.
   */
  async deploy(target: SshTarget, opts: { rotate?: boolean } = {}): Promise<DeviceKeyRow> {
    const username = target.ssh_username?.trim();
    if (!username) throw new Error('No SSH username configured for this device');

    const existing = await this.getKey(target.id);
    const canUseExistingKey = existing && existing.status === 'verified';
    if (!canUseExistingKey && !target.ssh_password_encrypted) {
      throw new Error('An SSH password is required to install the first key');
    }

    const pair = generateDeviceKeyPair(target.id);
    if (!isUsablePrivateKey(pair.privateKey)) {
      throw new Error('Generated key could not be parsed — refusing to deploy it');
    }

    // Authenticate with whatever currently works: the existing key if we have a
    // proved one, otherwise the password. After the first key is installed the
    // password is no longer an option, so this order is not a preference.
    const auth: Auth = canUseExistingKey
      ? { privateKey: decrypt(existing!.private_key_encrypted) }
      : { password: decrypt(target.ssh_password_encrypted!) };

    const fileName = keyFileName(target.id);
    try {
      await withSsh(target, username, auth, async (conn) => {
        await putFile(conn, fileName, pair.publicKey + '\n');
        const out = await exec(conn, `/user/ssh-keys/import public-key-file=${fileName} user=${username}`);
        // RouterOS reports failure in the output rather than an exit code.
        if (/failure|error|no such/i.test(out)) {
          throw new Error(`Device rejected the key import: ${out.trim().slice(0, 200)}`);
        }
        await exec(conn, `/file/remove ${fileName}`).catch(() => '');
      });
    } catch (e) {
      const msg = (e as Error).message;
      // The most likely cause of an auth failure here is a key this manager
      // installed previously and no longer holds — it keeps password SSH
      // disabled, so neither credential works. Say so, rather than leaving
      // someone to work it out.
      if (/authentication/i.test(msg) && !canUseExistingKey) {
        const orphans = await this.countManagerKeys(target).catch(() => 0);
        if (orphans > 0) {
          throw new Error(
            `Key deployment failed: ${msg}. This device already holds ${orphans} key(s) ` +
            `from this manager, which disables password SSH. Revoke to clear them, then retry.`,
            { cause: e }
          );
        }
      }
      throw new Error(`Key deployment failed: ${msg}`, { cause: e });
    }

    // Prove it on a connection that shares nothing with the one above.
    const proved = await this.tryKey(target, username, pair.privateKey);
    if (!proved.ok) {
      // Undo, or the device is left with a key it will demand and we cannot
      // supply — which is exactly how SSH was lost the first time.
      await this.removeKeyViaApi(target, pair.comment, pair.fingerprint).catch((e) =>
        console.error(`[SshKey] ${target.name}: could not remove the failed key: ${(e as Error).message}`));
      throw new Error(
        `The key was installed but would not authenticate (${proved.error}). ` +
        `It has been removed from the device and nothing was changed.`
      );
    }

    // Only now is it safe to replace what we had.
    await query(
      `INSERT INTO device_ssh_keys
         (device_id, key_type, public_key, private_key_encrypted, fingerprint,
          ssh_username, status, last_error, deployed_at, last_verified_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'verified',NULL,NOW(),NOW(),NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         key_type = EXCLUDED.key_type, public_key = EXCLUDED.public_key,
         private_key_encrypted = EXCLUDED.private_key_encrypted,
         fingerprint = EXCLUDED.fingerprint, ssh_username = EXCLUDED.ssh_username,
         status = 'verified', last_error = NULL, deployed_at = NOW(),
         last_verified_at = NOW(), updated_at = NOW()`,
      [target.id, pair.keyType, pair.publicKey, encrypt(pair.privateKey), pair.fingerprint, username]
    );

    // Retire the previous key only once its replacement is proved, and target it
    // by its own unique comment so this cannot remove the new one as well.
    if (existing?.public_key) {
      const oldComment = existing.public_key.trim().split(/\s+/).pop();
      if (oldComment && oldComment !== pair.comment) {
        await this.removeKeyViaApi(target, oldComment, existing.fingerprint)
          .then((n) => { if (n === 0) console.warn(`[SshKey] ${target.name}: old key not found on device`); })
          .catch((e) => console.warn(`[SshKey] ${target.name}: old key left in place: ${(e as Error).message}`));
      }
    }

    void opts;
    return (await this.getKey(target.id))!;
  }

  /** How many keys on this device were installed by this manager? */
  private async countManagerKeys(target: SshTarget): Promise<number> {
    if (!target.api_username || !target.api_password_encrypted) return 0;
    const client = new RouterOSClient(
      target.ip_address, target.api_port ?? 8728,
      target.api_username, decrypt(target.api_password_encrypted),
    );
    try {
      await client.connect();
      const keys = await client.execute('/user/ssh-keys/print', { detail: '' });
      return keys.filter((k) => (k['info'] || '').includes(keyComment(target.id))).length;
    } finally {
      client.disconnect();
    }
  }

  /** Can this private key authenticate, right now, on its own connection? */
  private async tryKey(
    target: SshTarget, username: string, privateKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await withSsh(target, username, { privateKey }, (conn) => exec(conn, '/system/identity/print'));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Prove the key works, on a connection that shares nothing with deployment.
   *
   * This is the only evidence that counts. Reusing the deployment session would
   * prove nothing — it authenticated with a password.
   */
  async verify(target: SshTarget): Promise<{ ok: boolean; error?: string }> {
    const row = await this.getKey(target.id);
    if (!row) return { ok: false, error: 'No key on record for this device' };
    const username = row.ssh_username || target.ssh_username || '';
    if (!username) return { ok: false, error: 'No SSH username configured' };

    const result = await this.tryKey(target, username, decrypt(row.private_key_encrypted));
    if (result.ok) {
      await query(
        `UPDATE device_ssh_keys SET status='verified', last_verified_at=NOW(),
                last_error=NULL, updated_at=NOW() WHERE device_id=$1`, [target.id]);
    } else {
      await query(
        `UPDATE device_ssh_keys SET status='failed', last_error=$2, updated_at=NOW()
          WHERE device_id=$1`, [target.id, result.error]);
    }
    return result;
  }

  /**
   * Forget a key, and remove it from the device.
   *
   * Removal goes over the binary API rather than SSH, because SSH is precisely
   * what may be broken. Deliberately tolerant of the device being unreachable:
   * the operator's intent is that the manager stop using this key, and that must
   * not depend on the hardware answering — but the message says plainly when the
   * device still holds it, since a leftover key keeps password SSH disabled.
   */
  async revoke(target: SshTarget): Promise<{ removedFromDevice: boolean; error?: string }> {
    const row = await this.getKey(target.id);
    if (!row) return { removedFromDevice: false, error: 'No key on record' };

    let removed = false;
    let error: string | undefined;
    try {
      // Match the device's *base* comment, which is a prefix of every key this
      // manager has ever installed for it. Removing only the key we currently
      // know about leaves orphans behind — from a rotation that failed halfway,
      // or an older install — and every orphan keeps password SSH disabled with
      // no way back through the product. Anything tagged for this device is
      // unambiguously ours to remove.
      const n = await this.removeKeyViaApi(target, keyComment(target.id), null);
      removed = n > 0;
      if (n === 0) error = 'the device does not appear to hold a key from this manager';
    } catch (e) {
      error = (e as Error).message;
    }

    await query(`DELETE FROM device_ssh_keys WHERE device_id = $1`, [target.id]);
    return { removedFromDevice: removed, error };
  }
}

export const sshKeyService = new SshKeyService();
