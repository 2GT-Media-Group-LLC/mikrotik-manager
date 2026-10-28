import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { previewContext, type PreviewContext } from '../../utils/previewContext';
import { isReadCommand, targetQuery, describeWrite } from '../../utils/changePreview';

/**
 * Key under which repeated attributes from one sentence are preserved as JSON.
 * Present only when a reply actually repeated a key, so ordinary rows are
 * byte-for-byte unchanged.
 */
export const REPEATED_ATTRIBUTES_KEY = '.repeated';

/**
 * Ceilings on what a device may send. A reply is data from the device, and a
 * compromised or broken device (or anyone on the path of a plaintext session)
 * controls it. Without limits, one crafted length header could grow the buffer
 * until the process ran out of memory. Real replies are far below these.
 */
const MAX_WORD_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** The device sent something the API protocol does not allow. */
class ProtocolError extends Error {}


export interface RouterOSSentence {
  type: string;
  words: Record<string, string>;
  tag?: string;
}

export class RouterOSError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'RouterOSError';
  }
}

/**
 * The device answered and refused the command (a !trap): no such menu, no
 * permission, bad argument. Unlike a timeout or a dropped connection, this is
 * a real answer about the device, so callers can treat it as "not there"
 * without mistaking a failed read for an empty one (outside review P2-21).
 */
export class RouterOSTrapError extends RouterOSError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'RouterOSTrapError';
  }
}

/**
 * The device said the menu or command doesn't exist: a trap of category 0
 * ("no such command or directory", then "no such command prefix"). Other traps
 * aren't an answer about the menu. A command cut off mid-reply traps with
 * category 2, "interrupted", and taking that for "not there" recorded a
 * CAPsMAN controller as having no wireless role (#365).
 */
export function isNoSuchCommand(err: unknown): boolean {
  return err instanceof RouterOSTrapError && (err.code === '0' || /^no such command/i.test(err.message));
}

/** A read for executeMany() and prefetch(). */
export interface ReadSpec {
  command: string;
  params?: Record<string, string>;
  queries?: string[];
}

/** The same read, whatever order its parameters were given in. */
function readKey(command: string, params: Record<string, string>, queries: string[]): string {
  return JSON.stringify([command, Object.entries(params).sort(([a], [b]) => a.localeCompare(b)), queries]);
}

export class RouterOSClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private connected = false;
  private authenticated = false;

  // Sequential command queue: each command waits for previous to complete
  private operationChain: Promise<void> = Promise.resolve();

  // Pending read resolver (one outstanding read at a time)
  private pendingRead: {
    resolve: (s: RouterOSSentence) => void;
    reject: (e: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;
  private sentenceQueue: RouterOSSentence[] = [];
  /** Set when a reply stream can no longer be trusted; distinct from `connected`. */
  private poisoned = false;

  private tagCounter = 0;

  /**
   * Answers to reads sent together at the start of a poll (#301), served to
   * the same reads made during it. Null outside a poll; any write clears it.
   */
  private prefetched: Map<string, { rows?: Record<string, string>[]; error?: Error }> | null = null;

  /** Time spent waiting on the device's answers, for a poll's breakdown (#301). */
  private waitedMs = 0;

  /** The time spent waiting on the device since the last call, and start again. */
  takeDeviceTime(): number {
    const ms = this.waitedMs;
    this.waitedMs = 0;
    return ms;
  }

  private readonly useTls: boolean;

  constructor(
    private readonly host: string,
    private readonly port: number = 8728,
    private readonly username: string,
    private readonly password: string,
    private readonly connectTimeoutMs: number = 15000,
    private readonly readTimeoutMs: number = 30000,
    useTls?: boolean
  ) {
    super();
    // api-ssl runs on 8729 by RouterOS convention (the same heuristic the
    // security-posture code uses); callers can override explicitly.
    this.useTls = useTls ?? port === 8729;
  }

  /**
   * Checks the certificate a device presents on API-SSL, before any login is
   * sent. Registered once at startup (index.ts); throws to refuse the device.
   */
  static tlsVerifier: ((host: string, port: number, fingerprint: string, raw: Buffer) => Promise<void>) | null = null;

  /** SHA-256 fingerprint of the certificate seen on the last TLS connect, lowercase hex. */
  tlsFingerprint: string | null = null;

  /**
   * This connection's local TCP port. NAT in front of the manager usually
   * keeps it, so it identifies the manager's own session in the device's
   * connection table (Change Guard, outside review P2-7).
   */
  get localPort(): number | null {
    return this.socket?.localPort ?? null;
  }

  /**
   * The address this connection actually reached. When the device was added by
   * hostname, or as an IPv6 address written differently from how RouterOS
   * prints it, this is the address to look for on the device (#205).
   */
  get remoteAddress(): string | null {
    return this.socket?.remoteAddress ?? null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    // A fresh connection starts trusted, so a client that was abandoned earlier
    // can be reconnected and used again.
    this.poisoned = false;
    this.sentenceQueue = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RouterOSError(`Connection timeout to ${this.host}:${this.port}`));
        this.socket?.destroy();
      }, this.connectTimeoutMs);

      const onReady = async () => {
        clearTimeout(timer);
        try {
          await this.authenticate();
          this.connected = true;
          this.authenticated = true;
          resolve();
        } catch (err) {
          this.socket?.destroy();
          reject(err);
        }
      };

      if (this.useTls) {
        // api-ssl: RouterOS devices ship self-signed certificates, so there is
        // no CA to check against. Instead the certificate is pinned: the
        // registered verifier compares it with the one the device presented the
        // first time, before the login is sent (outside review P1-4).
        const tlsSocket = tls.connect(
          { host: this.host, port: this.port, rejectUnauthorized: false },
          () => {
            void (async () => {
              try {
                const cert = tlsSocket.getPeerCertificate();
                const fp = cert?.fingerprint256;
                if (!fp) throw new RouterOSError('The device presented no certificate on API-SSL');
                this.tlsFingerprint = fp.replace(/:/g, '').toLowerCase();
                if (RouterOSClient.tlsVerifier) {
                  await RouterOSClient.tlsVerifier(this.host, this.port, this.tlsFingerprint, cert.raw);
                }
              } catch (err) {
                clearTimeout(timer);
                tlsSocket.destroy();
                reject(err);
                return;
              }
              await onReady();
            })();
          }
        );
        this.socket = tlsSocket;
      } else {
        this.socket = net.createConnection({ host: this.host, port: this.port });
        this.socket.on('connect', () => { void onReady(); });
      }
      // A session kept open between polls (#301) must survive NAT and
      // firewall idle timeouts between them.
      this.socket.setKeepAlive(true, 30_000);

      this.socket.on('data', (data: Buffer) => {
        // Nothing thrown here may escape: this runs from the socket's event
        // emitter, where an exception is uncaught and ends the whole process.
        // A bad reply costs this one connection, never the manager.
        try {
          this.buffer = Buffer.concat([this.buffer, data]);
          if (this.buffer.length > MAX_BUFFER_BYTES) {
            throw new ProtocolError(`reply exceeded ${MAX_BUFFER_BYTES} bytes`);
          }
          this.processBuffer();
        } catch (err) {
          const reason = `Protocol error from device: ${(err as Error).message}`;
          const pending = this.pendingRead;
          this.pendingRead = null;
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new RouterOSError(reason));
          }
          clearTimeout(timer);
          this.poison(reason);
          reject(new RouterOSError(reason));
        }
      });

      this.socket.on('error', (err) => {
        clearTimeout(timer);
        this.connected = false;
        this.authenticated = false;
        if (this.pendingRead) {
          this.pendingRead.reject(new RouterOSError(`Socket error: ${err.message}`));
          this.pendingRead = null;
        }
        reject(err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.authenticated = false;
        if (this.pendingRead) {
          this.pendingRead.reject(new RouterOSError('Connection closed'));
          this.pendingRead = null;
        }
      });
    });
  }

  // Enqueue a command so concurrent calls don't interleave
  /**
   * @param opts.timeoutMs  How long to wait for each reply sentence. The 30s
   *   default suits ordinary reads, but some RouterOS commands legitimately run
   *   far longer -- `/system/package/update/download` takes a minute or more on
   *   an ordinary link -- and timing those out corrupted the connection (#136).
   *   Callers issuing a long-running command must say so.
   */
  async execute(
    command: string,
    params: Record<string, string> = {},
    queries: string[] = [],
    opts: { timeoutMs?: number } = {}
  ): Promise<Record<string, string>[]> {
    // "Review changes" (#255): while a preview runs, a write is recorded with
    // the item it would change, and nothing is sent. Reads still go to the
    // device, so the route behaves as it would for real up to each write.
    const preview = previewContext();
    if (preview && !isReadCommand(command, params)) {
      return this.recordPreviewWrite(preview, command, params);
    }
    if (this.prefetched) {
      if (!isReadCommand(command, params)) this.prefetched = null;
      else {
        const hit = this.prefetched.get(readKey(command, params, queries));
        if (hit?.error) throw hit.error;
        // Each caller gets its own rows, as from the device.
        if (hit?.rows) return hit.rows.map((r) => Object.assign(Object.create(null) as Record<string, string>, r));
      }
    }

    let result!: Record<string, string>[];
    let error!: Error;

    await new Promise<void>((resolve) => {
      this.operationChain = this.operationChain.then(async () => {
        try {
          const t = Date.now();
          try { result = await this._executeRaw(command, params, queries, opts.timeoutMs); } finally { this.waitedMs += Date.now() - t; }
        } catch (err) {
          error = err as Error;
        }
        resolve();
      });
    });

    if (error) throw error;
    return result;
  }

  /**
   * Run a RouterOS script and return what it printed (#295). `/execute` with
   * `as-string` waits for the script and returns its output on !done as
   * `ret` (RouterOS 7). Used to read values the API leaves out of a reply,
   * so it's for read-only scripts; it never runs during a preview.
   */
  async runScript(source: string, timeoutMs = 30_000): Promise<string> {
    if (previewContext()) throw new RouterOSError('This action runs a script on the device, so it can\'t be previewed');
    let ret = '';
    let error!: Error;
    await new Promise<void>((resolve) => {
      this.operationChain = this.operationChain.then(async () => {
        try {
          const t = Date.now();
          try {
            await this._executeRaw('/execute', { script: source, 'as-string': '' }, [], timeoutMs, (done) => { ret = done['ret'] ?? ''; });
          } finally { this.waitedMs += Date.now() - t; }
        } catch (err) {
          error = err as Error;
        }
        resolve();
      });
    });
    if (error) throw error;
    return ret;
  }

  /**
   * Several reads in one round trip (#301). Each is sent with its own tag
   * straight after the last, and the replies, which RouterOS may interleave,
   * are sorted back by tag. Reads only, so the order they run in can't matter.
   * One failing read (a menu this device doesn't have) fails that entry, not
   * the rest. Anything that doesn't fit (a reply for no command sent, a
   * timeout) drops the connection, as for any read.
   */
  async executeMany(
    reads: ReadSpec[],
    opts: { timeoutMs?: number } = {}
  ): Promise<Array<{ rows?: Record<string, string>[]; error?: Error }>> {
    for (const r of reads) {
      if (!isReadCommand(r.command, r.params ?? {})) throw new RouterOSError(`executeMany is for reads only: ${r.command}`);
    }
    if (reads.length === 0) return [];
    let result!: Array<{ rows?: Record<string, string>[]; error?: Error }>;
    let error!: Error;
    await new Promise<void>((resolve) => {
      this.operationChain = this.operationChain.then(async () => {
        try {
          const t = Date.now();
          try { result = await this._executeManyRaw(reads, opts.timeoutMs); } finally { this.waitedMs += Date.now() - t; }
        } catch (err) {
          error = err as Error;
        }
        resolve();
      });
    });
    if (error) throw error;
    return result;
  }

  private async _executeManyRaw(
    reads: ReadSpec[],
    timeoutMs?: number
  ): Promise<Array<{ rows?: Record<string, string>[]; error?: Error }>> {
    if (!this.socket || !this.connected) throw new RouterOSError('Not connected');
    const tags = reads.map(() => String(++this.tagCounter));
    for (let i = 0; i < reads.length; i++) {
      const r = reads[i];
      const words = [r.command];
      for (const [key, value] of Object.entries(r.params ?? {})) words.push(`=${key}=${value}`);
      for (const q of r.queries ?? []) words.push(q);
      words.push(`.tag=${tags[i]}`);
      await this.sendSentence(words);
    }
    const index = new Map(tags.map((t, i) => [t, i]));
    const out = reads.map(() => ({ rows: [] as Record<string, string>[], error: undefined as Error | undefined, done: false }));
    let remaining = reads.length;
    while (remaining > 0) {
      const sentence = await this.readNextSentence(timeoutMs);
      if (sentence.type === '!fatal') {
        this.connected = false;
        throw new RouterOSError(sentence.words['message'] || 'Fatal error received');
      }
      const i = sentence.tag === undefined ? undefined : index.get(sentence.tag);
      if (i === undefined || out[i].done) {
        this.poison('a reply did not belong to any command waiting for one');
        throw new RouterOSError('Unexpected reply from the device');
      }
      const o = out[i];
      if (sentence.type === '!re') o.rows.push(sentence.words);
      else if (sentence.type === '!trap') {
        // The first trap's message, as execute() reports it; !done follows.
        o.error ??= new RouterOSTrapError(
          sentence.words['message'] || `Command failed: ${reads[i].command}`, sentence.words['category']);
      } else if (sentence.type === '!done') {
        o.done = true;
        remaining--;
      }
      // !empty (RouterOS 7.18+): no rows; its !done follows.
    }
    return out.map((o) => (o.error ? { error: o.error } : { rows: o.rows }));
  }

  /**
   * Send a poll's reads together and keep the answers for the rest of the
   * poll (#301): the same read made during it is served from them, and
   * anything else goes to the device as before. endPrefetch() forgets them.
   * Fails quietly: the reads are then made one by one, as without it.
   */
  async prefetch(reads: ReadSpec[], opts: { timeoutMs?: number } = {}): Promise<void> {
    const results = await this.executeMany(reads, opts);
    this.prefetched = new Map(reads.map((r, i) => [readKey(r.command, r.params ?? {}, r.queries ?? []), results[i]]));
  }

  endPrefetch(): void {
    this.prefetched = null;
  }

  /** Record a write a preview would have sent, with the item as it is now. */
  private async recordPreviewWrite(
    preview: PreviewContext,
    command: string,
    params: Record<string, string>
  ): Promise<Record<string, string>[]> {
    const q = targetQuery(command, params);
    let target: Record<string, string> | null = null;
    if (q) {
      target = (await this.execute(q.print, {}, q.queries).catch(() => []))[0] ?? null;
    }
    preview.steps.push(describeWrite(this.host, command, params, target));
    // An add's reply carries no rows here either (the new id is on !done).
    return [];
  }

  private async _executeRaw(
    command: string,
    params: Record<string, string>,
    queries: string[],
    timeoutMs?: number,
    onDone?: (words: Record<string, string>) => void,
  ): Promise<Record<string, string>[]> {
    if (!this.socket || !this.connected) {
      throw new RouterOSError('Not connected');
    }

    const words = [command];
    for (const [key, value] of Object.entries(params)) {
      words.push(`=${key}=${value}`);
    }
    for (const q of queries) {
      words.push(q);
    }

    await this.sendSentence(words);

    const results: Record<string, string>[] = [];
    while (true) {
      const sentence = await this.readNextSentence(timeoutMs);
      if (sentence.type === '!done') { onDone?.(sentence.words); break; }
      if (sentence.type === '!re') {
        results.push(sentence.words);
      } else if (sentence.type === '!trap') {
        // A !trap's reply always ends with a trailing !done — drain up to it to
        // keep the stream in sync. See drainUntilDone() for why this has to
        // keep reading rather than assume exactly one more sentence.
        await this.drainUntilDone();
        throw new RouterOSTrapError(
          sentence.words['message'] || `Command failed: ${command}`,
          sentence.words['category']
        );
      } else if (sentence.type === '!fatal') {
        this.connected = false;
        throw new RouterOSError(sentence.words['message'] || 'Fatal error received');
      }
    }
    return results;
  }

  disconnect(): void {
    this.connected = false;
    this.authenticated = false;
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.sentenceQueue = [];
  }

  isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  /** Connected, logged in, and its reply stream still trusted: safe to hand to the next poll (#301). */
  isUsable(): boolean {
    return this.connected && this.authenticated && !this.poisoned && !!this.socket && !this.socket.destroyed;
  }

  // ─── RouterOS API Protocol ────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    // Try plain-text login (RouterOS 6.49+ and RouterOS 7.x)
    await this.sendSentence(['/login', `=name=${this.username}`, `=password=${this.password}`]);
    const first = await this.readNextSentence();

    if (first.type === '!done') {
      return; // v7 / newer v6 plain-text login succeeded
    }

    if (first.type === '!re' && first.words['ret']) {
      // Legacy v6 challenge-response
      const challengeHex = first.words['ret'];
      // Drain the !done that follows the !re
      await this.readNextSentence();

      const challenge = Buffer.from(challengeHex, 'hex');
      const md5 = crypto.createHash('md5');
      md5.update(Buffer.from([0x00]));
      md5.update(Buffer.from(this.password, 'utf8'));
      md5.update(challenge);
      const responseHex = '00' + md5.digest('hex');

      await this.sendSentence([
        '/login',
        `=name=${this.username}`,
        `=response=${responseHex}`,
      ]);
      const result = await this.readNextSentence();
      if (result.type !== '!done') {
        throw new RouterOSError(
          result.words['message'] || 'Authentication failed (legacy MD5)',
          result.words['category']
        );
      }
      return;
    }

    if (first.type === '!trap') {
      throw new RouterOSError(
        first.words['message'] || 'Authentication failed',
        first.words['category']
      );
    }

    throw new RouterOSError(`Unexpected login response: ${first.type}`);
  }

  private encodeLength(len: number): Buffer {
    if (len < 0x80) {
      return Buffer.from([len]);
    } else if (len < 0x4000) {
      return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
    } else if (len < 0x200000) {
      return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
    } else if (len < 0x10000000) {
      return Buffer.from([
        (len >> 24) | 0xe0,
        (len >> 16) & 0xff,
        (len >> 8) & 0xff,
        len & 0xff,
      ]);
    } else {
      return Buffer.from([
        0xf0,
        (len >> 24) & 0xff,
        (len >> 16) & 0xff,
        (len >> 8) & 0xff,
        len & 0xff,
      ]);
    }
  }

  private decodeLength(
    buf: Buffer,
    offset: number
  ): { length: number; bytesConsumed: number } | null {
    if (offset >= buf.length) return null;
    const b = buf[offset];

    if (b < 0x80) {
      return { length: b, bytesConsumed: 1 };
    } else if (b < 0xc0) {
      if (offset + 1 >= buf.length) return null;
      return {
        length: ((b & 0x3f) << 8) | buf[offset + 1],
        bytesConsumed: 2,
      };
    } else if (b < 0xe0) {
      if (offset + 2 >= buf.length) return null;
      return {
        length: ((b & 0x1f) << 16) | (buf[offset + 1] << 8) | buf[offset + 2],
        bytesConsumed: 3,
      };
    } else if (b < 0xf0) {
      if (offset + 3 >= buf.length) return null;
      return {
        length:
          (((b & 0x0f) << 24) |
          (buf[offset + 1] << 16) |
          (buf[offset + 2] << 8) |
          buf[offset + 3]) >>> 0,
        bytesConsumed: 4,
      };
    } else if (b === 0xf0) {
      if (offset + 4 >= buf.length) return null;
      // `>>> 0` keeps this unsigned. JavaScript's `<<` works on signed 32-bit
      // integers, so a top byte of 0x80 or more used to decode as a negative
      // length, which slipped past the bounds check and spun the parser.
      return {
        length:
          ((buf[offset + 1] << 24) |
          (buf[offset + 2] << 16) |
          (buf[offset + 3] << 8) |
          buf[offset + 4]) >>> 0,
        bytesConsumed: 5,
      };
    } else {
      // 0xF1-0xFF are reserved control bytes, never a length.
      throw new ProtocolError(`reserved control byte 0x${b.toString(16)}`);
    }
  }

  private async sendSentence(words: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new RouterOSError('Socket not available'));
      const parts: Buffer[] = [];
      for (const word of words) {
        const wb = Buffer.from(word, 'utf8');
        parts.push(this.encodeLength(wb.length), wb);
      }
      parts.push(Buffer.from([0x00])); // end-of-sentence
      this.socket.write(Buffer.concat(parts), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private processBuffer(): void {
    while (true) {
      const sentence = this.tryParseSentence();
      if (!sentence) break;

      // Once a connection is abandoned, anything still arriving belongs to the
      // command that gave up. Queueing it would hand it to the next caller as
      // that caller's own reply, which is the desynchronisation poison() exists
      // to prevent -- destroying the socket usually stops this, but data already
      // buffered can still surface.
      //
      // This must test `poisoned`, not `connected`: `connected` is only set once
      // login has *finished*, so testing it here discarded the login exchange
      // itself and every connection timed out.
      if (this.poisoned) continue;

      if (this.pendingRead) {
        clearTimeout(this.pendingRead.timeout);
        const { resolve } = this.pendingRead;
        this.pendingRead = null;
        resolve(sentence);
      } else {
        this.sentenceQueue.push(sentence);
      }
    }
  }

  private tryParseSentence(): RouterOSSentence | null {
    const words: string[] = [];
    let offset = 0;

    while (offset < this.buffer.length) {
      const dec = this.decodeLength(this.buffer, offset);
      if (!dec) return null; // need more bytes

      const { length, bytesConsumed } = dec;
      if (length > MAX_WORD_BYTES) {
        throw new ProtocolError(`word of ${length} bytes exceeds the ${MAX_WORD_BYTES}-byte limit`);
      }

      if (length === 0) {
        // End of sentence — consume it
        this.buffer = this.buffer.slice(offset + 1);

        if (words.length === 0) return null;

        const type = words[0];
        // No prototype: attribute names come from the device, and on a plain
        // object a name like `constructor` or `__proto__` hits Object.prototype
        // instead of being stored as data (`'constructor' in {}` is true).
        const parsed: Record<string, string> = Object.create(null);
        let tag: string | undefined;
        // A sentence may carry the same attribute more than once — an LTE modem
        // reports one `ca-band` per aggregated carrier — and a flat object can
        // only hold the last. Repeats are preserved alongside it so that
        // multi-valued replies are not silently reduced to their final value.
        let repeated: Record<string, string[]> | undefined;

        for (let i = 1; i < words.length; i++) {
          const w = words[i];
          if (w.startsWith('=')) {
            const eq = w.indexOf('=', 1);
            if (eq > 0) {
              const key = w.slice(1, eq);
              const value = w.slice(eq + 1);
              if (Object.hasOwn(parsed, key)) {
                repeated ??= Object.create(null) as Record<string, string[]>;
                repeated[key] ??= [parsed[key]];
                repeated[key].push(value);
              }
              parsed[key] = value;
            }
          } else if (w.startsWith('.tag=')) {
            tag = w.slice(5);
          }
        }

        if (repeated) parsed[REPEATED_ATTRIBUTES_KEY] = JSON.stringify(repeated);

        return { type, words: parsed, tag };
      }

      if (offset + bytesConsumed + length > this.buffer.length) {
        return null; // need more bytes
      }

      words.push(
        this.buffer
          .slice(offset + bytesConsumed, offset + bytesConsumed + length)
          .toString('utf8')
      );
      offset += bytesConsumed + length;
    }

    return null;
  }

  /**
   * `poisonOnTimeout: false` is only for a wait whose timeout is expected and
   * whose leftovers the caller drains itself: the streaming loop waiting out
   * its deadline, which cancelStreaming() then resynchronises or poisons.
   */
  private readNextSentence(timeoutMs = this.readTimeoutMs, poisonOnTimeout = true): Promise<RouterOSSentence> {
    // Check queue first
    if (this.sentenceQueue.length > 0) {
      return Promise.resolve(this.sentenceQueue.shift()!);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRead = null;
        // A timed-out read leaves a reply in flight. Previously the socket was
        // left open, so when that reply finally arrived processBuffer() found no
        // pending read and queued it -- and the *next* command took it as its
        // own answer. Every later command on that connection then returned the
        // previous one's data.
        //
        // That is how a slow `/system/package/update/download` turned into
        // "did not finish downloading within 10 minutes" (#136): the status
        // polls afterwards were reading shifted replies and could never see
        // "Downloaded". A desynchronised connection can also make an unrelated
        // command look like it succeeded, so the only safe response is to stop
        // using it.
        if (poisonOnTimeout) this.poison('Read timeout waiting for API response');
        reject(new RouterOSError('Read timeout waiting for API response'));
      }, timeoutMs);

      this.pendingRead = {
        resolve,
        reject,
        timeout: timer,
      };
    });
  }

  /**
   * After a !trap, RouterOS's reply always ends with a trailing !done — but
   * that !done is not always the very next sentence: an unrecognized command
   * path (e.g. /system/routerboard/print on x86/CHR, which has no routerboard
   * submenu at all) replies with *two* !trap sentences — "no such command or
   * directory (routerboard)", then "no such command prefix" — before !done.
   *
   * Draining exactly one sentence assumed there was only ever one !trap, so
   * on a double-trap it consumed the second trap instead of the real !done,
   * leaving that !done sitting in the queue for the *next* command's very
   * first read. That command then saw type '!done' immediately and returned
   * an empty result before its real reply ever arrived — reached in practice
   * as /system/identity/print silently returning [] right after a
   * /system/routerboard/print trap on non-routerboard hardware.
   *
   * Reads and discards sentences until !done actually shows up, or a read
   * fails/times out (already logged via poison() in that case, so there is
   * nothing more to safely drain).
   *
   * Bounded to MAX_TRAP_SENTENCES reads: the per-read timeout already stops
   * this from hanging, but every !trap sequence actually observed is two
   * sentences at most, so an explicit cap keeps "how much this can discard"
   * obviously finite rather than implicit in that timeout.
   */
  private async drainUntilDone(timeoutMs?: number): Promise<void> {
    const MAX_TRAP_SENTENCES = 16;
    for (let i = 0; i < MAX_TRAP_SENTENCES; i++) {
      const sentence = await this.readNextSentence(timeoutMs).catch(() => null);
      if (!sentence || sentence.type === '!done') return;
    }
  }

  /**
   * Abandon a connection whose reply stream can no longer be trusted.
   *
   * Anything already queued belongs to a command that gave up, so it is
   * discarded rather than handed to the next caller.
   */
  private poison(reason: string): void {
    this.poisoned = true;
    this.connected = false;
    this.sentenceQueue = [];
    this.buffer = Buffer.alloc(0);
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.socket = null;
    this.emit('poisoned', reason);
  }

  // Execute a streaming/generator command (one that never sends !done on its own,
  // e.g. /tool/ip-scan). Collects !re rows until maxDurationMs elapses, then
  // sends /cancel to terminate the command and drains the cleanup response.
  async executeStreaming(
    command: string,
    params: Record<string, string> = {},
    maxDurationMs = 30_000,
    /**
     * maxRows: stop (and cancel) once this many rows have arrived, so a print
     * of a huge table (a busy router's connections, #300) never transfers it
     * all. queries: API query words ("?protocol=tcp") for the router to filter.
     */
    opts: { maxRows?: number; queries?: string[] } = {},
  ): Promise<Record<string, string>[]> {
    if (previewContext()) throw new RouterOSError('This action runs a tool on the device, so it can\'t be previewed');
    let result!: Record<string, string>[];
    let error!: Error;

    await new Promise<void>((resolve) => {
      this.operationChain = this.operationChain.then(async () => {
        try {
          const t = Date.now();
          try { result = await this._executeStreamingRaw(command, params, maxDurationMs, opts); } finally { this.waitedMs += Date.now() - t; }
        } catch (err) {
          error = err as Error;
        }
        resolve();
      });
    });

    if (error) throw error;
    return result;
  }

  private async _executeStreamingRaw(
    command: string,
    params: Record<string, string>,
    maxDurationMs: number,
    opts: { maxRows?: number; queries?: string[] } = {},
  ): Promise<Record<string, string>[]> {
    if (!this.socket || !this.connected) {
      throw new RouterOSError('Not connected');
    }

    const tag = String(++this.tagCounter);
    const words = [command];
    for (const [key, value] of Object.entries(params)) {
      words.push(`=${key}=${value}`);
    }
    for (const q of opts.queries ?? []) words.push(q);
    words.push(`.tag=${tag}`);

    await this.sendSentence(words);

    const results: Record<string, string>[] = [];
    const maxRows = opts.maxRows ?? Infinity;
    const deadline = Date.now() + maxDurationMs;

    // Collect !re sentences until deadline or until !done / !fatal arrives
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      let sentence: RouterOSSentence;
      try {
        // Reaching the deadline is how a streaming command normally ends, so
        // it must not poison the connection: cancelStreaming() below drains
        // what is still in flight, and drops the connection if it can't.
        sentence = await this.readNextSentence(Math.min(remaining, this.readTimeoutMs), false);
      } catch {
        // Timeout or socket error — fall through to cancel
        break;
      }

      if (sentence.type === '!re') {
        results.push(sentence.words);
        if (results.length >= maxRows) break;
      } else if (sentence.type === '!done') {
        // Command finished on its own (shouldn't happen for generators, but handle it)
        return results;
      } else if (sentence.type === '!trap') {
        // See drainUntilDone(): a !trap's trailing !done isn't always the very
        // next sentence.
        await this.drainUntilDone(5_000);
        throw new RouterOSTrapError(
          sentence.words['message'] || `Command failed: ${command}`,
          sentence.words['category']
        );
      } else if (sentence.type === '!fatal') {
        this.connected = false;
        throw new RouterOSError(sentence.words['message'] || 'Fatal error received');
      }
    }

    await this.cancelStreaming(tag);
    return results;
  }

  /**
   * Stop a streaming command and consume everything it still has to say.
   *
   * RouterOS answers a cancel with the cancelled command's late rows, an
   * "interrupted" !trap and a !done (all tagged with its tag), plus a !done
   * for /cancel itself. The old drain stopped after two sentences and ignored
   * tags, so a sentence was often left queued and the next command read it as
   * its own (empty) reply (outside review P2-4).
   *
   * /cancel gets its own tag, and sentences are read until both !done replies
   * have arrived. If they don't arrive in time, or the cancel can't be sent,
   * the reply stream can't be trusted any more, and the connection is dropped
   * rather than handed to the next command.
   */
  private async cancelStreaming(tag: string): Promise<void> {
    if (this.poisoned || !this.socket) return; // already dropped; nothing to resync
    const cancelTag = String(++this.tagCounter);
    try {
      await this.sendSentence(['/cancel', `=tag=${tag}`, `.tag=${cancelTag}`]);
    } catch {
      this.poison('could not send /cancel for a streaming command');
      return;
    }
    let commandDone = false;
    let cancelDone = false;
    const until = Date.now() + 5_000;
    // Bounded by time and count: a device streaming rows forever can't keep us here.
    for (let i = 0; i < 10_000 && !(commandDone && cancelDone); i++) {
      const left = until - Date.now();
      if (left <= 0) break;
      const s = await this.readNextSentence(left).catch(() => null);
      if (!s) break;
      if (s.type === '!fatal') break;
      if (s.type !== '!done') continue; // late rows and the "interrupted" trap
      if (s.tag === tag) commandDone = true;
      else if (s.tag === cancelTag) cancelDone = true;
    }
    if (!(commandDone && cancelDone) && !this.poisoned) {
      this.poison('a cancelled streaming command did not finish cleanly');
    }
  }
}
