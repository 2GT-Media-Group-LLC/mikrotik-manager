import * as fs from 'fs';
import * as path from 'path';
import { Client as SSHClient } from 'ssh2';
import { query, queryOne } from '../config/database';
import { decrypt } from '../utils/crypto';

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
  async exportConfig(device: BackupDevice): Promise<string> {
    const sshUser = device.ssh_username || device.api_username;
    const port = device.ssh_port || 22;

    const key = await queryOne<{ private_key_encrypted: string; ssh_username: string | null }>(
      `SELECT private_key_encrypted, ssh_username FROM device_ssh_keys
        WHERE device_id = $1 AND status = 'verified'`,
      [device.id]
    ).catch(() => null);

    if (key) {
      try {
        return await this.sshExport(
          device.ip_address, port, key.ssh_username || sshUser,
          { privateKey: decrypt(key.private_key_encrypted) }
        );
      } catch (e) {
        console.warn(`[Backup] ${device.name}: key auth failed, falling back to password: ${(e as Error).message}`);
      }
    }

    const sshPass = device.ssh_password_encrypted
      ? decrypt(device.ssh_password_encrypted)
      : decrypt(device.api_password_encrypted);
    return this.sshExport(device.ip_address, port, sshUser, { password: sshPass });
  }

  /** Persist already-fetched .rsc text as a backup file + DB row. Returns the backup id. */
  async createBackupFromContent(
    device: BackupDevice,
    content: string,
    notes?: string,
    type: string = 'manual'
  ): Promise<number> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${device.name.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.rsc`;
    const filePath = path.join(BACKUPS_DIR, String(device.id), filename);

    // Ensure device backup directory exists
    const deviceDir = path.join(BACKUPS_DIR, String(device.id));
    if (!fs.existsSync(deviceDir)) {
      fs.mkdirSync(deviceDir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf8');
    const stats = fs.statSync(filePath);

    const rows = await query<{ id: number }>(
      `INSERT INTO backups (device_id, filename, file_path, size_bytes, backup_type, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [device.id, filename, filePath, stats.size, type, notes || null]
    );

    return rows[0].id;
  }

  async createBackup(device: BackupDevice, notes?: string, type: string = 'manual'): Promise<number> {
    const exportContent = await this.exportConfig(device);
    return this.createBackupFromContent(device, exportContent, notes, type);
  }

  async restoreBackup(backupId: number): Promise<void> {
    const backup = await query<{
      file_path: string;
      device_id: number;
      filename: string;
    }>(`SELECT b.*, d.ip_address, d.ssh_port, d.ssh_username, d.ssh_password_encrypted, d.api_username, d.api_password_encrypted
        FROM backups b JOIN devices d ON d.id = b.device_id
        WHERE b.id = $1`, [backupId]);

    if (!backup[0]) throw new Error('Backup not found');

    const b = backup[0] as unknown as BackupDevice & { file_path: string };
    const content = fs.readFileSync(b.file_path, 'utf8');

    const sshUser = b.ssh_username || b.api_username;
    const sshPass = b.ssh_password_encrypted
      ? decrypt(b.ssh_password_encrypted)
      : decrypt(b.api_password_encrypted);

    await this.sshImport(b.ip_address, b.ssh_port || 22, sshUser, sshPass, content);
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
    auth: { password: string } | { privateKey: string }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let output = '';
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH timeout during backup'));
      }, 30_000);

      conn.on('ready', () => {
        conn.exec('/export compact', (err, stream) => {
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

  private sshImport(
    host: string,
    port: number,
    username: string,
    password: string,
    content: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH timeout during restore'));
      }, 60_000);

      conn.on('ready', () => {
        // Upload via SFTP then execute
        conn.sftp((err, sftp) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(err);
          }

          const remoteFile = '/restore_config.rsc';
          const writeStream = sftp.createWriteStream(remoteFile);

          writeStream.on('close', () => {
            // Execute the import
            conn.exec(`/import file-name=${remoteFile}`, (err2, stream) => {
              if (err2) {
                clearTimeout(timeout);
                conn.end();
                return reject(err2);
              }

              stream.on('close', () => {
                clearTimeout(timeout);
                conn.end();
                resolve();
              });

              stream.on('error', (e: Error) => {
                clearTimeout(timeout);
                conn.end();
                reject(e);
              });
            });
          });

          writeStream.on('error', (e: Error) => {
            clearTimeout(timeout);
            conn.end();
            reject(e);
          });

          writeStream.end(Buffer.from(content, 'utf8'));
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({ host, port, username, password, readyTimeout: 10_000 });
    });
  }
}
