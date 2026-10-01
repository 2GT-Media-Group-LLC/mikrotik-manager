import { logAlertCandidates } from '../logAlerts';

// Outside review P2-18.
describe('logAlertCandidates', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const ev = (id: number, severity: string, mins: number) =>
    ({ id, severity, message: `m${id}`, event_time: new Date(now.getTime() - mins * 60_000) });

  it('picks the newest error and the newest warning among the stored lines', () => {
    const out = logAlertCandidates([ev(1, 'error', 3), ev(2, 'info', 2), ev(3, 'error', 1), ev(4, 'warning', 1)], now);
    expect(out.map((e) => e.id)).toEqual([3, 4]);
  });

  it("doesn't alert on a new device's old backlog", () => {
    expect(logAlertCandidates([ev(1, 'error', 60 * 24 * 3)], now)).toEqual([]);
  });

  it('alerts on an error even when an info line came after it', () => {
    // The old check looked only at the single newest row by time.
    expect(logAlertCandidates([ev(1, 'error', 2), ev(2, 'info', 1)], now).map((e) => e.id)).toEqual([1]);
  });
});
