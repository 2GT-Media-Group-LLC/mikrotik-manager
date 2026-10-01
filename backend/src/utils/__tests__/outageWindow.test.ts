import { outageSecondsInWindow, outageLengthSeconds } from '../outageWindow';

// Outside review P2-25.
describe('outageSecondsInWindow', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const windowStart = new Date('2026-09-01T00:00:00Z'); // 30 days
  const at = (iso: string) => new Date(iso);

  it('counts an outage inside the window in full', () => {
    expect(outageSecondsInWindow({ went_offline_at: at('2026-09-10T00:00:00Z'), came_back_online_at: at('2026-09-10T01:00:00Z') }, windowStart, now)).toBe(3600);
  });

  it('counts the part of an outage that began before the window', () => {
    // Down from Aug 31 18:00 to Sep 1 06:00: only the 6 hours inside count. It used to count as nothing.
    expect(outageSecondsInWindow({ went_offline_at: at('2026-08-31T18:00:00Z'), came_back_online_at: at('2026-09-01T06:00:00Z') }, windowStart, now)).toBe(6 * 3600);
  });

  it('counts an outage still in progress up to now', () => {
    expect(outageSecondsInWindow({ went_offline_at: at('2026-09-28T00:00:00Z'), came_back_online_at: null }, windowStart, now)).toBe(3 * 86400);
  });

  it('counts the whole window for a device down since before it', () => {
    expect(outageSecondsInWindow({ went_offline_at: at('2026-08-01T00:00:00Z'), came_back_online_at: null }, windowStart, now)).toBe(30 * 86400);
  });

  it('ignores an outage that ended before the window', () => {
    expect(outageSecondsInWindow({ went_offline_at: at('2026-08-01T00:00:00Z'), came_back_online_at: at('2026-08-02T00:00:00Z') }, windowStart, now)).toBe(0);
  });

  it('reports an ongoing outage\'s length so far', () => {
    expect(outageLengthSeconds({ went_offline_at: at('2026-09-30T23:00:00Z'), came_back_online_at: null }, now)).toBe(3600);
  });
});
