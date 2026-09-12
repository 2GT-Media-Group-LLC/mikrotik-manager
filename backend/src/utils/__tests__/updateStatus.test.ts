import {
  parseUpdateStatus, describeUpdateStatus, latestFromStream, peakPercent,
} from '../updateStatus';

/**
 * Every string here was captured from a real device during this investigation,
 * not invented. The first group is the one that matters.
 */
describe('parseUpdateStatus — progress is not completion', () => {
  // The bug: /downloaded/i matched all of these, and the orchestrator rebooted
  // the device on the strength of it.
  it.each([
    ['Downloaded 0% (0.1MiB)', 0, 0.1],
    ['Downloaded 3% (0.4MiB)', 3, 0.4],
    ['Downloaded 66% (8.9MiB)', 66, 8.9],
    ['Downloaded 86% (11.6MiB)', 86, 11.6],
  ])('treats "%s" as still downloading', (raw, pct, mib) => {
    const s = parseUpdateStatus(raw);
    expect(s.state).toBe('downloading');
    expect(s.percent).toBe(pct);
    expect(s.mib).toBe(mib);
  });

  it('treats only the reboot wording as complete', () => {
    const s = parseUpdateStatus('Downloaded, please reboot router to upgrade it');
    expect(s.state).toBe('downloaded');
    expect(s.percent).toBeNull();
  });

  // The property the old code violated, stated directly.
  it('never reports a percentage line as complete', () => {
    for (let p = 0; p <= 100; p++) {
      expect(parseUpdateStatus(`Downloaded ${p}% (1.0MiB)`).state).not.toBe('downloaded');
    }
  });
});

describe('parseUpdateStatus — the other real statuses', () => {
  it.each([
    ['calculating download size...', 'downloading'],
    ['getting changelog...', 'downloading'],
    ['New version is available', 'available'],
    ['System is already up to date', 'up-to-date'],
    ['ERROR: connection error - Connection reset by peer', 'error'],
  ])('reads "%s" as %s', (raw, state) => {
    expect(parseUpdateStatus(raw).state).toBe(state);
  });

  // "available" is not "downloaded". Confusing them would reboot a device that
  // never fetched anything.
  it('does not mistake an available update for a downloaded one', () => {
    expect(parseUpdateStatus('New version is available').state).not.toBe('downloaded');
  });

  it('is unknown for nothing at all, rather than guessing', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(parseUpdateStatus(raw).state).toBe('unknown');
    }
  });

  it('keeps the raw text for the error message', () => {
    const s = parseUpdateStatus('ERROR: connection error - Connection reset by peer');
    expect(s.message).toContain('Connection reset by peer');
  });

  it('handles a percentage with no size', () => {
    const s = parseUpdateStatus('Downloaded 42%');
    expect(s.state).toBe('downloading');
    expect(s.percent).toBe(42);
    expect(s.mib).toBeNull();
  });
});

describe('describeUpdateStatus', () => {
  it('gives a stuck download something to be stuck at', () => {
    expect(describeUpdateStatus(parseUpdateStatus('Downloaded 86% (11.6MiB)')))
      .toBe('downloading 86% (11.6 MiB)');
  });

  it('quotes the device when it reports an error', () => {
    expect(describeUpdateStatus(parseUpdateStatus('ERROR: connection error')))
      .toContain('ERROR: connection error');
  });
});

// The 70-sentence stream the download command actually returns.
const stream = (...statuses: string[]) => statuses.map((status) => ({ status }));

describe('latestFromStream', () => {
  it('takes the outcome from the end of the stream', () => {
    const rows = stream(
      'calculating download size...',
      'Downloaded 3% (0.4MiB)',
      'Downloaded 86% (11.6MiB)',
      'getting changelog...',
      'Downloaded, please reboot router to upgrade it',
    );
    expect(latestFromStream(rows).state).toBe('downloaded');
  });

  it('surfaces a failure that ended the stream', () => {
    const rows = stream('Downloaded 12% (1.6MiB)', 'ERROR: connection error - Connection reset by peer');
    const s = latestFromStream(rows);
    expect(s.state).toBe('error');
    expect(s.message).toContain('Connection reset');
  });

  // A stream that stops mid-progress means the command returned without
  // finishing — not that it succeeded.
  it('reports an interrupted stream as still downloading', () => {
    expect(latestFromStream(stream('Downloaded 40% (5.5MiB)')).state).toBe('downloading');
  });

  it('is unknown for an empty stream', () => {
    expect(latestFromStream([]).state).toBe('unknown');
  });

  it('skips trailing rows it cannot read', () => {
    const rows = stream('Downloaded, please reboot router to upgrade it', '', 'something odd');
    expect(latestFromStream(rows).state).toBe('downloaded');
  });
});

describe('peakPercent', () => {
  it('reports how far a partial download got', () => {
    expect(peakPercent(stream('Downloaded 3% (0.4MiB)', 'Downloaded 66% (8.9MiB)', 'ERROR: x'))).toBe(66);
  });

  it('is null when nothing reported a percentage', () => {
    expect(peakPercent(stream('calculating download size...'))).toBeNull();
    expect(peakPercent([])).toBeNull();
  });
});
