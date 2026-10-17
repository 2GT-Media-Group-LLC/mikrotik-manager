/**
 * Where platform backups go: always this server's own backup volume, and
 * optionally S3-compatible storage, an SFTP server or an email address.
 * Each destination can send a file, prune to the number to keep, and test
 * itself. A backup on the same server doesn't survive losing the server,
 * which is what the off-box destinations are for.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import nodemailer from 'nodemailer';
import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import { queryOne } from '../../config/database';
import { openConfig } from '../../utils/alertChannelSecrets';
import { s3Put, s3PutBuffer, s3Delete, s3List, type S3Config } from './s3';

export const LOCAL_DIR = path.join(process.env.BACKUPS_DIR || '/app/backups', 'platform');
/** Files uploaded for a restore. */
export const UPLOAD_DIR = path.join(LOCAL_DIR, 'uploads');
export const FILE_PREFIX = 'mtm-backup-';
/** Email attachments past this go undelivered by most mail servers. */
export const EMAIL_MAX_BYTES = 20 * 1024 * 1024;

export type DestinationType = 's3' | 'sftp' | 'email';

export interface SftpConfig {
  host: string; port?: number; username: string; directory?: string;
  /** Pinned on the first successful test (SHA-256, base64). */
  hostKey?: string | null;
}
export interface SftpSecrets { password?: string; privateKey?: string; passphrase?: string }
export interface EmailConfig { channelId: number; recipients: string[] }

export interface Destination {
  id: number;
  type: DestinationType;
  name: string;
  enabled: boolean;
  keep: number;
  /** Non-secret settings, safe to show. */
  config: Record<string, unknown>;
  /** Decrypted secrets (S3 secret key, SFTP password or private key). */
  secrets: Record<string, string>;
}

export function ensureLocalDir(): void {
  fs.mkdirSync(LOCAL_DIR, { recursive: true, mode: 0o700 });
}

// ─── S3 ─────────────────────────────────────────────────────────────────────

function s3Config(d: Destination): S3Config {
  const c = d.config as Partial<S3Config>;
  if (!c.endpoint || !c.region || !c.bucket || !c.accessKeyId || !d.secrets.secretAccessKey) {
    throw new Error('S3: endpoint, region, bucket, access key and secret key are all needed');
  }
  return {
    endpoint: c.endpoint, region: c.region, bucket: c.bucket, accessKeyId: c.accessKeyId,
    secretAccessKey: d.secrets.secretAccessKey, pathStyle: !!c.pathStyle,
    prefix: c.prefix ? `${String(c.prefix).replace(/^\/+|\/+$/g, '')}/` : '',
  };
}

// ─── SFTP ───────────────────────────────────────────────────────────────────

const fingerprint = (key: Buffer) => crypto.createHash('sha256').update(key).digest('base64');

/** Connect, checking the host key against the pinned one (or learning it). */
async function sftpSession<T>(d: Destination, fn: (sftp: SFTPWrapper, dir: string) => Promise<T>): Promise<{ result: T; hostKey: string }> {
  const c = d.config as unknown as SftpConfig;
  if (!c.host || !c.username) throw new Error('SFTP: host and username are needed');
  if (!d.secrets.password && !d.secrets.privateKey) throw new Error('SFTP: a password or private key is needed');
  const dir = (c.directory || '.').replace(/\/+$/, '') || '.';
  let seen = '';
  const conn = new SshClient();
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => { conn.end(); reject(e); };
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(err);
        fn(sftp, dir).then((result) => { conn.end(); resolve({ result, hostKey: seen }); }, fail);
      });
    });
    conn.on('error', (e) => fail(/host denied/i.test(e.message)
      ? new Error(`SFTP: the server's host key doesn't match the one saved when this destination was tested (${c.hostKey}). If the server really changed, edit the destination, forget the saved key and test again.`)
      : e));
    conn.connect({
      host: c.host, port: c.port || 22, username: c.username, readyTimeout: 15_000,
      ...(d.secrets.privateKey ? { privateKey: d.secrets.privateKey, passphrase: d.secrets.passphrase } : { password: d.secrets.password }),
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        return !c.hostKey || c.hostKey === seen;
      },
    });
  });
}

const sftpCall = <T>(f: (cb: (err: Error | null | undefined, v?: T) => void) => void) =>
  new Promise<T>((res, rej) => f((err, v) => (err ? rej(err) : res(v as T))));

// ─── Email ──────────────────────────────────────────────────────────────────

async function emailTransport(d: Destination) {
  const c = d.config as unknown as EmailConfig;
  const ch = await queryOne<{ type: string; config: Record<string, unknown> }>(`SELECT type, config FROM alert_channels WHERE id = $1`, [c.channelId]);
  if (!ch || ch.type !== 'email') throw new Error('Email: the chosen email alert channel no longer exists');
  const cfg = openConfig(ch.type, ch.config);
  const user = cfg.smtp_user as string | undefined;
  const pass = cfg.smtp_pass as string | undefined;
  if (!cfg.smtp_host) throw new Error('Email: the alert channel has no SMTP server');
  const recipients = (c.recipients?.length ? c.recipients : (cfg.recipients as string[]) ?? []).filter(Boolean);
  if (!recipients.length) throw new Error('Email: no recipients');
  return {
    // TLS certificates are checked: a backup is worth more than an alert.
    transport: nodemailer.createTransport({
      host: cfg.smtp_host as string, port: (cfg.smtp_port as number) || 587, secure: !!cfg.smtp_secure,
      auth: user && pass ? { user, pass } : undefined,
    }),
    from: (cfg.from_address as string) || user || 'mikrotik-manager@localhost',
    recipients,
  };
}

// ─── The common interface ───────────────────────────────────────────────────

/** Send a backup file. Returns a host key to pin for SFTP's first use. */
export async function sendTo(d: Destination, file: string, name: string): Promise<{ hostKey?: string }> {
  if (d.type === 's3') { await s3Put(s3Config(d), name, file); return {}; }
  if (d.type === 'sftp') {
    const { hostKey } = await sftpSession(d, (sftp, dir) => sftpCall<void>((cb) => sftp.fastPut(file, `${dir}/${name}`, (e) => cb(e))));
    return { hostKey };
  }
  const size = (await fs.promises.stat(file)).size;
  if (size > EMAIL_MAX_BYTES) {
    throw new Error(`Email: the backup is ${(size / 1048576).toFixed(1)} MB, more than mail servers usually accept (${EMAIL_MAX_BYTES / 1048576} MB). Use email for configuration backups, and S3 or SFTP for the database.`);
  }
  const { transport, from, recipients } = await emailTransport(d);
  await transport.sendMail({
    from, to: recipients.join(', '),
    subject: `MikroTik Manager backup ${name}`,
    text: `A MikroTik Manager platform backup is attached (${name}). It's encrypted with the backup passphrase; keep the passphrase somewhere other than this mailbox.`,
    attachments: [{ filename: name, path: file, contentType: 'application/octet-stream' }],
  });
  return {};
}

/** Keep the newest `keep` backups at the destination; returns how many went. Email can't prune. */
export async function pruneAt(d: Destination, keep: number): Promise<number> {
  if (d.type === 'email' || keep <= 0) return 0;
  if (d.type === 's3') {
    const cfg = s3Config(d);
    const names = (await s3List(cfg, FILE_PREFIX)).filter((n) => n.endsWith('.mtmbackup')).sort();
    const drop = names.slice(0, Math.max(0, names.length - keep));
    for (const n of drop) await s3Delete(cfg, n);
    return drop.length;
  }
  const { result } = await sftpSession(d, async (sftp, dir) => {
    const list = await sftpCall<{ filename: string }[]>((cb) => sftp.readdir(dir, cb));
    const names = list.map((f) => f.filename).filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith('.mtmbackup')).sort();
    const drop = names.slice(0, Math.max(0, names.length - keep));
    for (const n of drop) await sftpCall<void>((cb) => sftp.unlink(`${dir}/${n}`, (e) => cb(e)));
    return drop.length;
  });
  return result;
}

/** Write and remove a small file to prove the settings work. */
export async function testDestination(d: Destination): Promise<{ message: string; hostKey?: string }> {
  const probe = `${FILE_PREFIX}test-${Date.now()}.txt`;
  if (d.type === 's3') {
    const cfg = s3Config(d);
    await s3PutBuffer(cfg, probe, Buffer.from('MikroTik Manager destination test\n'));
    await s3Delete(cfg, probe);
    return { message: `Wrote and removed a test file in ${cfg.bucket}/${cfg.prefix ?? ''}` };
  }
  if (d.type === 'sftp') {
    const tmp = path.join(LOCAL_DIR, probe);
    ensureLocalDir();
    await fs.promises.writeFile(tmp, 'MikroTik Manager destination test\n');
    try {
      const { hostKey } = await sftpSession(d, async (sftp, dir) => {
        await sftpCall<void>((cb) => sftp.fastPut(tmp, `${dir}/${probe}`, (e) => cb(e)));
        await sftpCall<void>((cb) => sftp.unlink(`${dir}/${probe}`, (e) => cb(e)));
      });
      return { message: `Wrote and removed a test file in ${(d.config as unknown as SftpConfig).directory || 'the home folder'}`, hostKey };
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }
  const { transport, from, recipients } = await emailTransport(d);
  await transport.sendMail({ from, to: recipients.join(', '), subject: 'MikroTik Manager backup destination test',
    text: 'This address will receive MikroTik Manager platform backups.' });
  return { message: `Sent a test message to ${recipients.join(', ')}` };
}
