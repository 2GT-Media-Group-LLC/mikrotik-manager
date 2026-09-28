import * as fs from 'fs';
import * as path from 'path';
import { Client as SSHClient } from 'ssh2';
import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import { exportPlan } from '../utils/backupExport';
import { randomBytes } from 'crypto';
import { withSafeApply, type GuardDevice, type GuardOutcome } from './changeGuard/ChangeGuard';
import { resolveAuth, type SshExecDevice } from './sshExec';
import { parseImportOutput, type ImportResult } from '../utils/importResult';

const BACKUPS_DIR = process.env.BACKUPS_DIR || '/app/backups';

export interface BackupDevice {
  id: number;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_username?: string;
  ssh_password_encrypted?: string;
  api_username: string;
  api_password_encrypted: string;
}

export class BackupService {
  constructor() {
    // Ensure backups directory exists
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }
  }

  /**
   * Run `/export compact` over SSH and return the raw .rsc text.
   *
   * Prefers a *verified* key over the stored password. Only verified, because a
   * key that has merely been generated or pushed is not evidence the device will
   * accept it — and a backup that fails on an unproven credential is worse than
   * one that succeeds on a working password (#110). If the key fails at connect
   * time we fall back rather than giving up, so introducing keys can never make
   * backups less reliable than they were without them.
   */
  async exportConfig(
    device: BackupDevice,
    opts: { includeSecrets?: boolean } = {}
  ): Promise<{ text: string; containsSecrets: boolean }> {
    const sshUser = device.ssh_username || device.api_username;
    const port = device.ssh_port || 22;
    const [ver] = await query<{ ros_version: string | null }>(
      `SELECT ros_version FROM devices WHERE id = $1`, [device.id]
    ).catch(() => []);
    const plan = exportPlan(ver?.ros_version, !!opts.includeSecrets);
    const run = async (user: string, auth: { password: string } | { privateKey: string }) =>
      ({ text: await this.sshExport(device.ip_address, port, user, auth, plan.command), containsSecrets: plan.containsSecrets });

    const key = await queryOne<{ private_key_encrypted: string; ssh_username: string | null }>(
      `SELECT private_key_encrypted, ssh_username FROM device_ssh_keys
        WHERE device_id = $1 AND status = 'verified'`,
      [device.id]
    ).catch(() => null);

    if (key) {
      try {
        return await run(key.ssh_username || sshUser, { privateKey: decrypt(key.private_key_encrypted) });
      } catch (e) {
        console.warn(`[Backup] ${device.name}: key auth failed, falling back to password: ${(e as Error).message}`);
      }
    }

    const sshPass = device.ssh_password_encrypted
      ? decrypt(device.ssh_password_encrypted)
      : decrypt(device.api_password_encrypted);
    return run(sshUser, { password: sshPass });
  }

  /** Whether backups should include passwords and keys (Settings, admin only). */
  async includeSecretsSetting(): Promise<boolean> {
    const [row] = await query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'backup_include_secrets'`
    ).catch(() => []);
    return row?.value === true;
  }

  /** A backup's text, decrypted when it was stored encrypted. */
  static readContent(row: { file_path: string; encrypted?: boolean | null }): string {
    const raw = fs.readFileSync(row.file_path, 'utf8');
    return row.encrypted ? decrypt(raw) : raw;
  }

  /** Persist already-fetched .rsc text as a backup file + DB row. Returns the backup id. */
  async createBackupFromContent(
    device: BackupDevice,
    content: string,
    notes?: string,
    type: string = 'manual',
    containsSecrets = false
  ): Promise<number> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${device.name.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.rsc`;
    const filePath = path.join(BACKUPS_DIR, String(device.id), filename);

    // Ensure device backup directory exists
    const deviceDir = path.join(BACKUPS_DIR, String(device.id));
    if (!fs.existsSync(deviceDir)) {
      fs.mkdirSync(deviceDir, { recursive: true });
    }

    // Passwords and keys are never written in plain text (#172). The recorded
    // size is the readable size, which is what the UI shows.
    fs.writeFileSync(filePath, containsSecrets ? encrypt(content) : content, { encoding: 'utf8', mode: 0o600 });
    const size = Buffer.byteLength(content, 'utf8');

    const rows = await query<{ id: number }>(
      `INSERT INTO backups (device_id, filename, file_path, size_bytes, backup_type, notes, contains_secrets, encrypted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
      [device.id, filename, filePath, size, type, notes || null, containsSecrets]
    );

    return rows[0].id;
  }

  async createBackup(device: BackupDevice, notes?: string, type: string = 'manual'): Promise<number> {
    const { text, containsSecrets } = await this.exportConfig(device, { includeSecrets: await this.includeSecretsSetting() });
    return this.createBackupFromContent(device, text, notes, type, containsSecrets);
  }

  /**
   * Replay a backup onto its device and report what really happened (P1-10).
   *
   * Runs under Change Guard, so an import that cuts the device off restores the
   * previous configuration by itself, and reads RouterOS's output, because
   * `/import` exits 0 whether or not it worked. Uses the device's SSH key when
   * one is deployed; the password alone fails once a key is installed.
   */
  async restoreBackup(backupId: number, opts: { userId?: number | null } = {}): Promise<RestoreOutcome> {
    const rows = await query<GuardDevice & SshExecDevice & { file_path: string; encrypted: boolean; backup_filename: string }>(
      `SELECT d.*, b.file_path, b.encrypted, b.filename AS backup_filename
         FROM backups b JOIN devices d ON d.id = b.device_id
        WHERE b.id = $1`, [backupId]);
    const row = rows[0];
    if (!row) throw new Error('Backup not found');

    const content = BackupService.readContent(row);

    try {
      const outcome = await withSafeApply(
        row,
        { kind: 'backup.restore', summary: `Restore ${row.backup_filename}`, userId: opts.userId ?? null },
        async () => {
          const result = await this.sshImport(row, content);
          if (result.status !== 'applied') throw new ImportFailedError({ ...result, status: result.status });
          return result;
        }
      );
      if (outcome.autoReverting) return { status: 'reverting', guard: guardSummary(outcome) };
      return { status: 'applied', guard: guardSummary(outcome) };
    } catch (err) {
      if (err instanceof ImportFailedError) return { ...err.result, guard: null };
      throw err;
    }
  }

  async deleteBackup(backupId: number): Promise<void> {
    const rows = await query<{ file_path: string }>(
      `DELETE FROM backups WHERE id = $1 RETURNING file_path`,
      [backupId]
    );
    if (rows[0]?.file_path && fs.existsSync(rows[0].file_path)) {
      fs.unlinkSync(rows[0].file_path);
    }
  }

  getBackupFilePath(backupId: number, deviceId: number): string | null {
    const rows = fs.readdirSync(path.join(BACKUPS_DIR, String(deviceId))).filter(
      (f) => f.includes(String(backupId))
    );
    if (!rows.length) return null;
    return path.join(BACKUPS_DIR, String(deviceId), rows[0]);
  }

  private sshExport(
    host: string,
    port: number,
    username: string,
    auth: { password: string } | { privateKey: string },
    command = '/export compact'
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let output = '';
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH timeout during backup'));
      }, 30_000);

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(err);
          }

          stream.on('data', (data: Buffer) => {
            output += data.toString();
          });

          stream.stderr.on('data', (data: Buffer) => {
            console.warn('SSH stderr:', data.toString());
          });

          stream.on('close', () => {
            clearTimeout(timeout);
            conn.end();
            resolve(output);
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({ host, port, username, ...auth, readyTimeout: 10_000 });
    });
  }

  /**
   * Upload the script under a name of its own, run it, delete it, and return
   * RouterOS's verdict. A shared filename let two restores of one device import
   * each other's backups, and the file (which can hold secrets) was left behind.
   */
  private async sshImport(device: SshExecDevice, content: string): Promise<ImportResult> {
    const { username, auth } = await resolveAuth(device);
    const remoteFile = `mtm-restore-${randomBytes(6).toString('hex')}.rsc`;

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { conn.end(); } catch { /* closing */ }
        fn();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error('SSH timeout during restore'))), 180_000);

      const exec = (cmd: string): Promise<string> => new Promise((res, rej) => {
        conn.exec(cmd, (err, stream) => {
          if (err) return rej(err);
          let out = '';
          stream.on('data', (d: Buffer) => { out += d.toString(); });
          stream.stderr.on('data', (d: Buffer) => { out += d.toString(); });
          stream.on('close', () => res(out));
          stream.on('error', rej);
        });
      });

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return finish(() => reject(err));
          const writeStream = sftp.createWriteStream(remoteFile);
          writeStream.on('error', (e: Error) => finish(() => reject(e)));
          writeStream.on('close', () => {
            void (async () => {
              try {
                const output = await exec(`/import file-name=${remoteFile}`);
                await exec(`/file remove [find name="${remoteFile}"]`).catch(() => '');
                finish(() => resolve(parseImportOutput(output, content)));
              } catch (e) {
                finish(() => reject(e));
              }
            })();
          });
          writeStream.end(Buffer.from(content, 'utf8'));
        });
      });

      conn.on('error', (err) => finish(() => reject(err)));
      conn.connect({ host: device.ip_address, port: device.ssh_port || 22, username, ...auth, readyTimeout: 10_000 });
    });
  }
}

export type RestoreOutcome =
  | { status: 'applied' | 'reverting'; guard: RestoreGuard }
  | (ImportResult & { status: 'nothing_applied' | 'partial'; guard: null });

interface RestoreGuard {
  protected: boolean;
  confirmed: boolean;
  auto_reverting: boolean;
  unprotected_reason: string | null;
  revert_may_fire_at: string | null;
}

function guardSummary(o: GuardOutcome<unknown>): RestoreGuard {
  return {
    protected: !o.unprotectedReason,
    confirmed: o.confirmed,
    auto_reverting: o.autoReverting,
    unprotected_reason: o.unprotectedReason ?? null,
    revert_may_fire_at: o.revertMayFireAt ?? null,
  };
}

/** The import ran but did not complete; carries RouterOS's verdict out of the guard. */
class ImportFailedError extends Error {
  constructor(readonly result: ImportResult & { status: 'nothing_applied' | 'partial' }) {
    super(result.error || 'The import did not complete');
  }
}

/** A plain-language account of a restore, for the API response. */
export function describeRestore(r: RestoreOutcome): string {
  switch (r.status) {
    case 'applied':
      return 'Restored: RouterOS ran the whole backup, and the device was confirmed reachable afterwards.';
    case 'reverting':
      return 'The device stopped responding during the restore, so it is putting its previous configuration back. It should return shortly.';
    case 'partial':
      return `Partly restored. RouterOS ran ${r.appliedCommands} command${r.appliedCommands === 1 ? '' : 's'}, then stopped at line ${r.failedLine}: ${r.error}. ` +
        'The device now has a mix of the backup and its previous configuration.';
    default:
      return r.failedLine
        ? `Nothing was changed. RouterOS stopped at line ${r.failedLine}: ${r.error}. ` +
          'A backup replays its commands onto the running configuration, so it stops at the first object that already exists.'
        : `Nothing was changed: ${r.error || 'RouterOS did not confirm the import'}.`;
  }
}
