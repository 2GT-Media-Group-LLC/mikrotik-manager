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
