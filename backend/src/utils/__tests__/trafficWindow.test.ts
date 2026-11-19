import { timeWindow, pointSeconds } from '../trafficWindow';

const NOW = Date.parse('2026-11-17T21:40:00Z');

describe('timeWindow (#463)', () => {
  it('reads a preset range back from now', () => {
    const w = timeWindow({ range: '24h' }, NOW)!;
    expect(w.flux).toBe('start: -24h');
    expect(w.every).toBe('15m');
    expect(w.stop).toBeNull();
    expect(w.hours).toBe(24);
    expect(w.start.toISOString()).toBe('2026-11-16T21:00:00.000Z');
  });

  it('falls back to 24h for an unknown range', () => {
    expect(timeWindow({ range: '99y' }, NOW)!.flux).toBe('start: -24h');
    expect(timeWindow({}, NOW)!.flux).toBe('start: -24h');
  });

  it('keeps the presets\' chart windows', () => {
    const every = (range: string) => timeWindow({ range }, NOW)!.every;
    expect(['1h', '2h', '3h', '6h', '12h', '24h', '7d', '30d'].map(every))
      .toEqual(['1m', '2m', '5m', '5m', '10m', '15m', '1h', '6h']);
  });

  it('takes a picked window, with a chart window sized to it', () => {
    const w = timeWindow({ from: '2026-11-17T20:00:00Z', to: '2026-11-17T21:00:00Z' }, NOW)!;
    expect(w.flux).toBe('start: 2026-11-17T20:00:00.000Z, stop: 2026-11-17T21:00:00.000Z');
    expect(w.every).toBe('1m');
    expect(w.hours).toBeNull();
    expect(timeWindow({ from: '2026-11-10T00:00:00Z', to: '2026-11-13T00:00:00Z' }, NOW)!.every).toBe('1h');
  });

  it('accepts offsets and fractions, and ends a window reaching past now at now', () => {
    const w = timeWindow({ from: '2026-11-17T15:00:00.250-05:00', to: '2026-11-18T09:00:00+00:00' }, NOW)!;
    expect(w.start.toISOString()).toBe('2026-11-17T20:00:00.250Z');
    expect(w.stop!.getTime()).toBe(NOW);
  });

  it('refuses what isn\'t a window', () => {
    for (const q of [
      { from: '2026-11-17T21:00:00Z', to: '2026-11-17T20:00:00Z' },     // backwards
      { from: '2026-11-17T20:00:00Z', to: '2026-11-17T20:00:30Z' },     // under a minute
      { from: '2026-10-01T00:00:00Z', to: '2026-11-17T00:00:00Z' },     // over 31 days
      { from: '2026-11-17', to: '2026-11-17T21:00:00Z' },               // not RFC 3339
      { from: '2026-11-17T20:00:00Z' },                                 // half a window
      { from: '2026-11-17T20:00:00Z) |> drop(', to: '2026-11-17T21:00:00Z' },
      { from: '2027-01-01T00:00:00Z', to: '2027-01-02T00:00:00Z' },     // all in the future
    ]) expect(timeWindow(q, NOW)).toBeNull();
  });
});

describe('pointSeconds: what a chart point covers, for rates', () => {
  it('is the whole window for a point inside the view', () => {
    const w = timeWindow({ range: '24h' }, NOW)!; // 15-minute windows
    expect(pointSeconds('2026-11-17T12:15:00Z', w, NOW)).toBe(900);
    expect(pointSeconds('2026-11-17T12:00:00Z', timeWindow({ range: '7d' }, NOW)!, NOW)).toBe(3600);
  });

  it('is only what has passed of the newest window, which ends now', () => {
    // 21:40 is 10 minutes into the 21:30-21:45 window.
    expect(pointSeconds(new Date(NOW).toISOString(), timeWindow({ range: '24h' }, NOW)!, NOW)).toBe(600);
  });

  it('starts the oldest window where the view starts', () => {
    // The 24h view starts at 21:40 yesterday, 5 minutes before its first window ends at 21:45.
    expect(pointSeconds('2026-11-16T21:45:00Z', timeWindow({ range: '24h' }, NOW)!, NOW)).toBe(300);
  });

  it('cuts a picked window\'s points at both of its ends', () => {
    const w = timeWindow({ from: '2026-11-17T20:00:30Z', to: '2026-11-17T21:00:20Z' }, NOW)!; // 1-minute windows
    expect(pointSeconds('2026-11-17T20:01:00Z', w, NOW)).toBe(30);
    expect(pointSeconds('2026-11-17T20:30:00Z', w, NOW)).toBe(60);
    expect(pointSeconds('2026-11-17T21:00:20Z', w, NOW)).toBe(20);
  });
});
