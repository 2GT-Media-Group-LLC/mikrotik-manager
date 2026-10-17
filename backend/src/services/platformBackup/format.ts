/**
 * The .mtmbackup file (platform backup of MikroTik Manager itself).
 *
 *   "MTMBACKUP1\n" | uint32 header length | header JSON | ciphertext | 16-byte GCM tag
 *
 * The header is plain JSON (what it holds, which MTM version made it, the key
 * derivation parameters); everything else is gzip'd NDJSON records encrypted
 * with AES-256-GCM under a key derived from the admin's passphrase (scrypt).
 * A short encrypted check value in the header lets a wrong passphrase fail at
 * once instead of after reading the whole file. GCM authenticates the lot, so
 * a restore only commits once the tag has verified.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as readline from 'readline';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export const MAGIC = Buffer.from('MTMBACKUP1\n', 'utf8');
const TAG_LEN = 16;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const CHECK_TEXT = 'mikrotik-manager';

export type BackupContents = 'config' | 'database' | 'config+database';

export interface BackupHeader {
  format: 1;
  app_version: string;
  created_at: string;
  contents: BackupContents;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  /** The passphrase check: CHECK_TEXT encrypted under the derived key. */
  check: { iv: string; tag: string; data: string };
}

/**
 * One NDJSON record inside the encrypted payload. A table row is
 * `{"type":"row","r":<row>}`, handled as `{ type: 'row', raw }` with the row's
 * JSON text untouched both ways, so numbers keep every digit.
 */
export type BackupRecord = Record<string, unknown> & { type: string };
const ROW_PREFIX = '{"type":"row","r":';

export class DamagedBackupError extends Error {
  constructor(public detail?: string) { super('The backup file is damaged or has been changed since it was made.'); }
}

export class WrongPassphraseError extends Error {
  constructor() { super('The passphrase is wrong, or this isn’t a MikroTik Manager backup.'); }
}

function deriveKey(passphrase: string, salt: Buffer, kdf = SCRYPT): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem });
}

/**
 * Write a backup: `records` yields the payload records in order. Streams the
 * whole way, so a large database backup never sits in memory.
 */
export async function writeBackup(
  path: string, passphrase: string, meta: { appVersion: string; contents: BackupContents },
  records: AsyncIterable<BackupRecord>,
): Promise<BackupHeader> {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(12);
  const checkIv = crypto.randomBytes(12);
  const checkCipher = crypto.createCipheriv('aes-256-gcm', key, checkIv);
  const checkData = Buffer.concat([checkCipher.update(CHECK_TEXT, 'utf8'), checkCipher.final()]);
  const header: BackupHeader = {
    format: 1,
    app_version: meta.appVersion,
    created_at: new Date().toISOString(),
    contents: meta.contents,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    check: { iv: checkIv.toString('base64'), tag: checkCipher.getAuthTag().toString('base64'), data: checkData.toString('base64') },
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBuf.length);
  await fs.promises.writeFile(path, Buffer.concat([MAGIC, len, headerBuf]), { mode: 0o600 });

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  async function* lines() {
    for await (const r of records) {
      yield r.type === 'row' && typeof r.raw === 'string' ? `${ROW_PREFIX}${r.raw}}\n` : `${JSON.stringify(r)}\n`;
    }
  }
  await pipeline(Readable.from(lines()), zlib.createGzip({ level: 6 }), cipher, fs.createWriteStream(path, { flags: 'a' }));
  await fs.promises.appendFile(path, cipher.getAuthTag());
  return header;
}

/** The header, without the passphrase. Throws on anything that isn't a backup. */
export async function readHeader(path: string): Promise<{ header: BackupHeader; payloadStart: number; size: number }> {
  const fh = await fs.promises.open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(MAGIC.length + 4);
    await fh.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This isn’t a MikroTik Manager backup file.');
    const hlen = head.readUInt32BE(MAGIC.length);
    if (hlen <= 0 || hlen > 64 * 1024 || MAGIC.length + 4 + hlen + TAG_LEN > size) throw new Error('The backup file is damaged.');
    const hbuf = Buffer.alloc(hlen);
    await fh.read(hbuf, 0, hlen, MAGIC.length + 4);
    const header = JSON.parse(hbuf.toString('utf8')) as BackupHeader;
    if (header.format !== 1 || header.kdf?.name !== 'scrypt') throw new Error('This backup was made by a newer MikroTik Manager.');
    return { header, payloadStart: MAGIC.length + 4 + hlen, size };
  } finally {
    await fh.close();
  }
}

/** Derive the key and check the passphrase against the header. */
export function unlock(header: BackupHeader, passphrase: string): Buffer {
  const key = deriveKey(passphrase, Buffer.from(header.kdf.salt, 'base64'), { ...SCRYPT, N: header.kdf.N, r: header.kdf.r, p: header.kdf.p });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.check.iv, 'base64'));
    d.setAuthTag(Buffer.from(header.check.tag, 'base64'));
    const text = Buffer.concat([d.update(Buffer.from(header.check.data, 'base64')), d.final()]).toString('utf8');
    if (text !== CHECK_TEXT) throw new Error('check');
  } catch {
    throw new WrongPassphraseError();
  }
  return key;
}

/**
 * Read the payload records. The GCM tag is only verified at the end of the
 * stream, so the last iteration throws if the file was altered: a restore must
 * not commit until this iterator has finished cleanly.
 */
export async function* readRecords(path: string, passphrase: string): AsyncGenerator<BackupRecord> {
  const { header, payloadStart, size } = await readHeader(path);
  const key = unlock(header, passphrase);
  const fh = await fs.promises.open(path, 'r');
  const tag = Buffer.alloc(TAG_LEN);
  await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  await fh.close();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(tag);
  const plain = fs.createReadStream(path, { start: payloadStart, end: size - TAG_LEN - 1 }).pipe(decipher).pipe(zlib.createGunzip());
  // Errors from the decipher (a failed tag) surface on the gunzip stream's
  // consumer through this forward.
  decipher.on('error', (e) => plain.destroy(e));
  const rl = readline.createInterface({ input: plain, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (line.startsWith(ROW_PREFIX) && line.endsWith('}')) yield { type: 'row', raw: line.slice(ROW_PREFIX.length, -1) };
      else yield JSON.parse(line) as BackupRecord;
    }
  } catch (err) {
    // A failed GCM tag, or gunzip/JSON errors from altered bytes.
    if (err instanceof DamagedBackupError) throw err;
    throw new DamagedBackupError((err as Error).message);
  }
}
