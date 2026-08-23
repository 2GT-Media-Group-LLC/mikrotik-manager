import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

/**
 * Key under which repeated attributes from one sentence are preserved as JSON.
 * Present only when a reply actually repeated a key, so ordinary rows are
 * byte-for-byte unchanged.
 */
export const REPEATED_ATTRIBUTES_KEY = '.repeated';


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

  private tagCounter = 0;

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

  async connect(): Promise<void> {
    if (this.connected) return;

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
        // api-ssl: RouterOS devices ship self-signed certificates by default,
        // so certificate verification is intentionally disabled — the same
        // trust model as the plaintext API this replaces, but with the
        // credentials and session encrypted in transit.
        this.socket = tls.connect(
          { host: this.host, port: this.port, rejectUnauthorized: false },
          () => { void onReady(); }
        );
      } else {
        this.socket = net.createConnection({ host: this.host, port: this.port });
        this.socket.on('connect', () => { void onReady(); });
      }

      this.socket.on('data', (data: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, data]);
        this.processBuffer();
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
  async execute(
    command: string,
    params: Record<string, string> = {},
    queries: string[] = []
  ): Promise<Record<string, string>[]> {
    let result!: Record<string, string>[];
    let error!: Error;

    await new Promise<void>((resolve) => {
      this.operationChain = this.operationChain.then(async () => {
        try {
          result = await this._executeRaw(command, params, queries);
        } catch (err) {
          error = err as Error;
        }
        resolve();
      });
    });

    if (error) throw error;
    return result;
  }

  private async _executeRaw(
    command: string,
    params: Record<string, string>,
    queries: string[]
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
      const sentence = await this.readNextSentence();
      if (sentence.type === '!done') break;
      if (sentence.type === '!re') {
        results.push(sentence.words);
      } else if (sentence.type === '!trap') {
        // RouterOS always sends !done after !trap — drain it to keep the stream in sync.
        // Without this, the stale !done is consumed by the next command, causing it to
        // exit immediately with empty results before its real response arrives.
        await this.readNextSentence().catch(() => {});
        throw new RouterOSError(
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
          ((b & 0x0f) << 24) |
          (buf[offset + 1] << 16) |
          (buf[offset + 2] << 8) |
          buf[offset + 3],
        bytesConsumed: 4,
      };
    } else {
      if (offset + 4 >= buf.length) return null;
      return {
        length:
          (buf[offset + 1] << 24) |
          (buf[offset + 2] << 16) |
          (buf[offset + 3] << 8) |
          buf[offset + 4],
        bytesConsumed: 5,
      };
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

      if (length === 0) {
        // End of sentence — consume it
        this.buffer = this.buffer.slice(offset + 1);

        if (words.length === 0) return null;

        const type = words[0];
        const parsed: Record<string, string> = {};
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
              if (key in parsed) {
                repeated ??= {};
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

  private readNextSentence(timeoutMs = this.readTimeoutMs): Promise<RouterOSSentence> {
    // Check queue first
    if (this.sentenceQueue.length > 0) {
      return Promise.resolve(this.sentenceQueue.shift()!);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRead = null;
        reject(new RouterOSError('Read timeout waiting for API response'));
      }, timeoutMs);

      this.pendingRead = {
        resolve,
        reject,
        timeout: timer,
      };
    });
  }

  // Execute a streaming/generator command (one that never sends !done on its own,
  // e.g. /tool/ip-scan). Collects !re rows until maxDurationMs elapses, then
  // sends /cancel to terminate the command and drains the cleanup response.
  async executeStreaming(
    command: string,
    params: Record<string, string> = {},
    maxDurationMs = 30_000
  ): Promise<Record<string, string>[]> {
    let result!: Record<string, string>[];
    let error!: Error;

    await new Promise<void>((resolve) => {
      this.operationChain = this.operationChain.then(async () => {
        try {
          result = await this._executeStreamingRaw(command, params, maxDurationMs);
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
    maxDurationMs: number
  ): Promise<Record<string, string>[]> {
    if (!this.socket || !this.connected) {
      throw new RouterOSError('Not connected');
    }

    const tag = String(++this.tagCounter);
    const words = [command];
    for (const [key, value] of Object.entries(params)) {
      words.push(`=${key}=${value}`);
    }
    words.push(`.tag=${tag}`);

    await this.sendSentence(words);

    const results: Record<string, string>[] = [];
    const deadline = Date.now() + maxDurationMs;

    // Collect !re sentences until deadline or until !done / !fatal arrives
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      let sentence: RouterOSSentence;
      try {
        sentence = await this.readNextSentence(Math.min(remaining, this.readTimeoutMs));
      } catch {
        // Timeout or socket error — fall through to cancel
        break;
      }

      if (sentence.type === '!re') {
        results.push(sentence.words);
      } else if (sentence.type === '!done') {
        // Command finished on its own (shouldn't happen for generators, but handle it)
        return results;
      } else if (sentence.type === '!trap') {
        // Drain the !done that follows !trap
        await this.readNextSentence(5_000).catch(() => {});
        throw new RouterOSError(
          sentence.words['message'] || `Command failed: ${command}`,
          sentence.words['category']
        );
      } else if (sentence.type === '!fatal') {
        this.connected = false;
        throw new RouterOSError(sentence.words['message'] || 'Fatal error received');
      }
    }

    // Send /cancel and drain responses (RouterOS replies !trap + !done to cancel)
    try {
      await this.sendSentence(['/cancel', `=tag=${tag}`]);
      // Drain up to 2 sentences (!trap and/or !done) with a short timeout each
      for (let i = 0; i < 2; i++) {
        const s = await this.readNextSentence(5_000).catch(() => null);
        if (!s || s.type === '!done') break;
      }
    } catch {
      // Ignore cancel errors
    }

    return results;
  }
}
