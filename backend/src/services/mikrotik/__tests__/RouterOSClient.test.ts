import * as net from 'net';
import { RouterOSClient, RouterOSSentence, REPEATED_ATTRIBUTES_KEY } from '../RouterOSClient';
import { REPEATED_KEY, parseBandSpecs } from '../../../utils/lte';

/** Encode one word using RouterOS's variable-length prefix (short form only). */
const word = (s: string): Buffer => {
  const body = Buffer.from(s, 'utf8');
  if (body.length >= 0x80) throw new Error('test helper handles short words only');
  return Buffer.concat([Buffer.from([body.length]), body]);
};

/** Build a complete `!re` sentence from raw `key=value` words. */
const sentence = (...kv: string[]): Buffer =>
  Buffer.concat([word('!re'), ...kv.map(p => word('=' + p)), Buffer.from([0x00])]);

/** Build a complete sentence of any type (`!trap`, `!done`, ...) from raw `key=value` words. */
const rawSentence = (type: string, ...kv: string[]): Buffer =>
  Buffer.concat([word(type), ...kv.map(p => word('=' + p)), Buffer.from([0x00])]);
const trap = (message: string): Buffer => rawSentence('!trap', `message=${message}`);
const done = (): Buffer => rawSentence('!done');

/** Feed bytes straight to the parser, bypassing the socket. */
function parse(bytes: Buffer): RouterOSSentence | null {
  const client = new RouterOSClient('127.0.0.1', 8728, 'x', 'x');
  const internals = client as unknown as {
    buffer: Buffer;
    tryParseSentence(): RouterOSSentence | null;
  };
  internals.buffer = bytes;
  return internals.tryParseSentence();
}

describe('sentence parsing', () => {
  it('reads ordinary attributes into a flat object', () => {
    const s = parse(sentence('name=lte1', 'status=running'))!;
    expect(s.type).toBe('!re');
    expect(s.words).toEqual({ name: 'lte1', status: 'running' });
  });

  it('adds no repeat side-channel when nothing repeats', () => {
    // Every existing caller sees byte-for-byte what it saw before.
    const s = parse(sentence('name=lte1'))!;
    expect(Object.keys(s.words)).toEqual(['name']);
  });

  it('preserves every value when an attribute repeats', () => {
    // A Cat-18 modem reports one `ca-band` per aggregated carrier. A flat object
    // keeps only the last, which under-reports aggregation exactly when the link
    // is performing best.
    const s = parse(sentence(
      'primary-band=B1@20Mhz earfcn: 500',
      'ca-band=B3@20Mhz earfcn: 1800',
      'ca-band=B7@20Mhz earfcn: 3350',
      'ca-band=B20@10Mhz earfcn: 6300',
    ))!;

    expect(s.words['ca-band']).toBe('B20@10Mhz earfcn: 6300');   // unchanged
    expect(JSON.parse(s.words[REPEATED_ATTRIBUTES_KEY])).toEqual({
      'ca-band': [
        'B3@20Mhz earfcn: 1800',
        'B7@20Mhz earfcn: 3350',
        'B20@10Mhz earfcn: 6300',
      ],
    });
  });

  it('hands the LTE parser all three carriers', () => {
    const s = parse(sentence(
      'ca-band=B3@20Mhz earfcn: 1800',
      'ca-band=B7@20Mhz earfcn: 3350',
      'ca-band=B20@10Mhz earfcn: 6300',
    ))!;
    expect(parseBandSpecs(s.words, 'ca-band').map(b => b.band)).toEqual([3, 7, 20]);
  });

  it('tracks repeats of several different attributes independently', () => {
    const s = parse(sentence('a=1', 'b=x', 'a=2', 'b=y', 'c=only'))!;
    expect(JSON.parse(s.words[REPEATED_ATTRIBUTES_KEY])).toEqual({ a: ['1', '2'], b: ['x', 'y'] });
    expect(s.words.c).toBe('only');
  });

  it('agrees with the key the LTE parser reads', () => {
    // These constants live apart to keep the pure parser free of socket code.
    expect(REPEATED_KEY).toBe(REPEATED_ATTRIBUTES_KEY);
  });
});

/**
 * Read-timeout handling (#136).
 *
 * A timed-out read leaves a reply in flight. The connection used to stay open,
 * so when that reply eventually arrived it was queued and handed to the *next*
 * command as its own answer — every subsequent call on that connection returned
 * the previous one's data.
 *
 * That is what turned a slow `/system/package/update/download` into "did not
 * finish downloading within 10 minutes": the status polls afterwards were
 * reading shifted replies and could never see "Downloaded". The same
 * desynchronisation could make any unrelated command appear to succeed, so
 * these tests matter well beyond firmware.
 */
describe('read timeout', () => {
  type Internals = {
    buffer: Buffer;
    connected: boolean;
    socket: unknown;
    sentenceQueue: RouterOSSentence[];
    pendingRead: unknown;
    readNextSentence(timeoutMs?: number): Promise<RouterOSSentence>;
    processBuffer(): void;
  };

  const makeClient = () => {
    const client = new RouterOSClient('127.0.0.1', 8728, 'x', 'x');
    const internals = client as unknown as Internals;
    internals.connected = true;
    internals.socket = { destroy() {} };
    return { client, internals };
  };

  // The regression these were written without: the discard guard first tested
  // `connected`, which is only set *after* login succeeds. Every login reply was
  // therefore thrown away and every connection timed out — the whole fleet went
  // offline. The tests above all pre-set connected = true, so none of them saw
  // it. "Not yet connected" and "abandoned" are different states.
  it('delivers replies that arrive before login has completed', () => {
    const { internals } = makeClient();
    internals.connected = false;          // mid-login, as connect() leaves it
    internals.buffer = sentence('ret=abc123');
    internals.processBuffer();
    expect(internals.sentenceQueue).toHaveLength(1);
  });

  it('rejects when no reply arrives in time', async () => {
    const { internals } = makeClient();
    await expect(internals.readNextSentence(20)).rejects.toThrow(/Read timeout/);
  });

  it('does not hand a late reply to the next command', async () => {
    const { internals } = makeClient();

    await expect(internals.readNextSentence(20)).rejects.toThrow(/Read timeout/);

    // The reply the timed-out command was waiting for now turns up.
    internals.buffer = sentence('status=Downloaded, please reboot');
    internals.processBuffer();

    // It must not be sitting in the queue waiting to be mistaken for the next
    // command's answer.
    expect(internals.sentenceQueue).toHaveLength(0);
  });

  it('marks the connection unusable so it cannot be reused blind', async () => {
    const { client, internals } = makeClient();
    await expect(internals.readNextSentence(20)).rejects.toThrow(/Read timeout/);

    expect(internals.connected).toBe(false);
    // A caller that carries on regardless gets a clean error rather than
    // another command's data.
    await expect(client.execute('/system/resource/print')).rejects.toThrow(/Not connected/);
  });

  // The guard above must not break ordinary pipelining: a healthy connection
  // legitimately queues replies that arrive faster than they are read.
  it('still serves queued replies while the connection is healthy', async () => {
    const { internals } = makeClient();
    internals.buffer = sentence('status=ok');
    internals.processBuffer();
    expect(internals.sentenceQueue).toHaveLength(1);
    await expect(internals.readNextSentence(20)).resolves.toMatchObject({
      words: { status: 'ok' },
    });
  });
});

/**
 * Double-!trap desync — reproduced live against an x86/CHR device (no
 * routerboard submenu): /system/routerboard/print replies with *two* !trap
 * sentences ("no such command or directory (routerboard)", then "no such
 * command prefix") before the trailing !done, not the single !trap the old
 * drain-one-sentence code assumed.
 *
 * Draining exactly one sentence after the first !trap consumed the second
 * !trap instead of !done, leaving that !done in the queue for the very next
 * command. That command's first read then saw type '!done' immediately and
 * returned an empty result before its real reply ever arrived — in practice,
 * /system/identity/print silently returning [] right after that failed
 * routerboard probe, which is how a typed "+ Add Device" name kept getting
 * treated as un-lockable: the identity read to compare it against came back
 * empty every time on this class of hardware.
 */
describe('!trap draining', () => {
  type Internals = {
    buffer: Buffer;
    connected: boolean;
    socket: unknown;
    sentenceQueue: RouterOSSentence[];
    processBuffer(): void;
    drainUntilDone(timeoutMs?: number): Promise<void>;
  };

  const makeExecClient = () => {
    const client = new RouterOSClient('127.0.0.1', 8728, 'x', 'x');
    const internals = client as unknown as Internals;
    internals.connected = true;
    internals.socket = { write: (_d: Buffer, cb: () => void) => cb(), destroy() {} };
    return { client, internals };
  };

  it('rejects with the first trap\'s message on a single !trap', async () => {
    const { client, internals } = makeExecClient();
    internals.buffer = Buffer.concat([trap('no such command'), done()]);
    internals.processBuffer();

    await expect(client.execute('/nonexistent/print')).rejects.toThrow('no such command');
  });

  it('does not let a double !trap steal the next command\'s reply', async () => {
    const { client, internals } = makeExecClient();

    internals.buffer = Buffer.concat([
      trap('no such command or directory (routerboard)'),
      trap('no such command prefix'),
      done(),
    ]);
    internals.processBuffer();

    await expect(client.execute('/system/routerboard/print'))
      .rejects.toThrow('no such command or directory (routerboard)');

    // The next command's real reply must not have been eaten by the drain.
    internals.buffer = Buffer.concat([sentence('name=MikroTik'), done()]);
    internals.processBuffer();
    await expect(client.execute('/system/identity/print'))
      .resolves.toEqual([{ name: 'MikroTik' }]);
  });

  // Never observed in practice — RouterOS has only ever sent at most two
  // !trap sentences for one failed command — but the cap must still hold if
  // it somehow did, rather than reading forever until the per-read timeout.
  it('gives up after a bounded number of sentences if !done never arrives', async () => {
    const { internals } = makeExecClient();
    internals.buffer = Buffer.concat(Array.from({ length: 20 }, () => trap('spam')));
    internals.processBuffer();
    expect(internals.sentenceQueue).toHaveLength(20);

    await internals.drainUntilDone(50);

    // Drained exactly the cap (16) and stopped, leaving the rest queued
    // rather than consuming everything while waiting for a !done that never
    // comes.
    expect(internals.sentenceQueue).toHaveLength(4);
  });
});

// ── Hostile replies ──────────────────────────────────────────────────────────
//
// A device controls its own replies. None of these may hang or crash the
// manager; the worst allowed outcome is losing that one connection.

describe('hostile replies', () => {
  it('decodes a 5-byte length as unsigned', () => {
    // 0xF0 then 0x80 00 00 05: 2,147,483,653 bytes. Signed shifts made this
    // negative, it passed the "enough bytes?" check and the parser span.
    const bytes = Buffer.from([0xf0, 0x80, 0x00, 0x00, 0x05, 0x41, 0x42]);
    expect(() => parse(bytes)).toThrow(/exceeds/);
  });

  it('rejects the reserved control bytes', () => {
    expect(() => parse(Buffer.from([0xf8, 0x00]))).toThrow(/reserved control byte/);
    expect(() => parse(Buffer.from([0xff]))).toThrow(/reserved control byte/);
  });

  it('stores attributes named after Object.prototype members as data', () => {
    const s = parse(sentence('constructor=a', 'constructor=b', '__proto__=c', 'toString=d'))!;
    expect(s.words['constructor']).toBe('b');
    expect(s.words['__proto__']).toBe('c');
    expect(s.words['toString']).toBe('d');
    expect(JSON.parse(s.words[REPEATED_ATTRIBUTES_KEY])).toEqual({ constructor: ['a', 'b'] });
  });

  it('drops the connection, not the process, on a malicious reply', async () => {
    // A fake "router" that answers the login with the negative-length header.
    const server = net.createServer((sock) => {
      sock.on('data', () => sock.write(Buffer.from([0xf0, 0x80, 0x00, 0x00, 0x05, 0x00])));
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    const client = new RouterOSClient('127.0.0.1', port, 'admin', 'pw', 3_000, 3_000);
    try {
      await expect(client.connect()).rejects.toThrow(/Protocol error from device/);
    } finally {
      client.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
