import {
  parseRosId, highestStoredId, isLogReset, selectNewLogLines,
  surrogateLogId, isSurrogateLogId, type RawLogLine,
} from '../logDedup';

// Fixed clock so timestamp comparisons are deterministic.
const T = (iso: string) => new Date(iso);
const parseTime = (raw: string) => (raw ? T(raw) : new Date(0));

const line = (id: string, time = '', message = 'm'): RawLogLine =>
  ({ '.id': id, time, message, topics: 'system,info' });

describe('parseRosId', () => {
  it('reads RouterOS hex ids', () => {
    expect(parseRosId('*1A2F')).toBe(0x1a2f);
    expect(parseRosId('1a2f')).toBe(0x1a2f);
  });

  it('returns 0 for anything unusable', () => {
    for (const bad of ['', undefined, '*', '*zz', 'not-hex', '*-5']) {
      expect(parseRosId(bad as string)).toBe(0);
    }
  });
});

describe('highestStoredId', () => {
  // The bug this exists for: taking the last *inserted* row instead of the
  // highest id lets the watermark move backwards, after which every line looks
  // new and the whole buffer is reprocessed every poll.
  it('takes the maximum, not the last element', () => {
    expect(highestStoredId(['*10', '*FF', '*20'])).toBe(0xff);
  });

  it('ignores nulls and junk', () => {
    expect(highestStoredId([null, undefined, '', '*zz', '*7'])).toBe(7);
    expect(highestStoredId([])).toBe(0);
  });
});

describe('isLogReset', () => {
  it('detects ids going backwards', () => {
    expect(isLogReset(5, 900)).toBe(true);
  });

  it('is not fooled by a first run or an empty buffer', () => {
    expect(isLogReset(900, 0)).toBe(false);
    expect(isLogReset(0, 900)).toBe(false);
  });

  it('treats normal forward movement as no reset', () => {
    expect(isLogReset(950, 900)).toBe(false);
  });
});

describe('selectNewLogLines', () => {
  const latestStoredTime = T('2026-09-08T00:00:00Z');

  it('returns nothing when the whole buffer is already stored', () => {
    // The reported symptom: a thousand lines re-offered every minute.
    const logs = Array.from({ length: 1000 }, (_, i) => line(`*${(i + 1).toString(16)}`));
    const out = selectNewLogLines(logs, { lastStoredId: 1000, latestStoredTime, parseTime });
    expect(out).toHaveLength(0);
  });

  it('returns only the lines above the watermark', () => {
    const logs = [line('*8'), line('*9'), line('*A'), line('*B')];
    const out = selectNewLogLines(logs, { lastStoredId: 9, latestStoredTime, parseTime });
    expect(out.map((l) => l['.id'])).toEqual(['*A', '*B']);
  });

  it('falls back to timestamps when the buffer has reset', () => {
    // Ids went backwards, so they cannot be compared against the watermark.
    const logs = [
      line('*1', '2026-09-07T23:00:00Z'), // older than what we hold
      line('*2', '2026-09-08T00:30:00Z'), // newer
    ];
    const out = selectNewLogLines(logs, { lastStoredId: 900, latestStoredTime, parseTime });
    expect(out.map((l) => l['.id'])).toEqual(['*2']);
  });

  it('uses timestamps for lines carrying no id', () => {
    const logs = [
      { time: '2026-09-07T23:00:00Z', message: 'old' },
      { time: '2026-09-08T01:00:00Z', message: 'new' },
    ];
    const out = selectNewLogLines(logs, { lastStoredId: 5, latestStoredTime, parseTime });
    expect(out.map((l) => l.message)).toEqual(['new']);
  });

  it('treats a line exactly on the boundary as already stored', () => {
    const logs = [{ time: '2026-09-08T00:00:00Z', message: 'boundary' }];
    expect(selectNewLogLines(logs, { lastStoredId: 0, latestStoredTime, parseTime })).toHaveLength(0);
  });
});

describe('surrogateLogId', () => {
  const line = ['sep/08 02:38:10', 'system,info', 'router rebooted'] as const;

  it('is stable for the same line', () => {
    expect(surrogateLogId(...line)).toBe(surrogateLogId(...line));
  });

  it('differs when any field differs', () => {
    const base = surrogateLogId(...line);
    expect(surrogateLogId('sep/08 02:38:11', line[1], line[2])).not.toBe(base);
    expect(surrogateLogId(line[0], 'system,error', line[2])).not.toBe(base);
    expect(surrogateLogId(line[0], line[1], 'something else')).not.toBe(base);
  });

  // Field boundaries are separated, so shifting text between fields cannot
  // produce the same key.
  it('does not confuse field boundaries', () => {
    expect(surrogateLogId('a', 'b', 'c')).not.toBe(surrogateLogId('ab', '', 'c'));
  });

  // The column is VARCHAR(20); an over-long key would throw on insert.
  it('fits the log_id column', () => {
    const id = surrogateLogId('x'.repeat(500), 'y'.repeat(500), 'z'.repeat(5000));
    expect(id.length).toBeLessThanOrEqual(20);
  });

  it('cannot be mistaken for a RouterOS id', () => {
    const id = surrogateLogId(...line);
    expect(id.startsWith('#')).toBe(true);
    expect(isSurrogateLogId(id)).toBe(true);
    expect(isSurrogateLogId('*CC75')).toBe(false);
    expect(isSurrogateLogId(null)).toBe(false);
  });

  /**
   * The watermark is a max over RouterOS's own hex ids. A synthesised id must
   * not be parsed as one, or it would poison the high-water mark and make every
   * real line look already-seen.
   */
  it('is ignored by the id watermark', () => {
    const id = surrogateLogId(...line);
    expect(parseRosId(id)).toBe(0);
    expect(highestStoredId([id, '*10'])).toBe(0x10);
  });
});
