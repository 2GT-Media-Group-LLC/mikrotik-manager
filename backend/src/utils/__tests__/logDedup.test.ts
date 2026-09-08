import {
  parseRosId, highestStoredId, isLogReset, selectNewLogLines, type RawLogLine,
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
