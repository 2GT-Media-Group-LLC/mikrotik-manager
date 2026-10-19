import { bootChange } from '../bootTime';

const t0 = Date.parse('2026-10-14T16:52:00Z');

describe('reboots from the uptime counter (#326)', () => {
  it('the first sighting just records the boot time', () => {
    expect(bootChange(null, t0)).toBe('first');
  });
  it('a second or two either way is the same boot', () => {
    expect(bootChange(t0, t0 + 2_000)).toBe('same');
    expect(bootChange(t0, t0 - 3_000)).toBe('same');
  });
  it('a small shift is clock drift, stored without counting a reboot', () => {
    expect(bootChange(t0, t0 + 45_000)).toBe('drift');
    expect(bootChange(t0, t0 - 60_000)).toBe('drift');
  });
  it('a boot time later by minutes is a reboot, even one the polls never saw', () => {
    // Rebooted five days later in under 30 s: never offline at a poll.
    expect(bootChange(t0, t0 + 5 * 86_400_000)).toBe('reboot');
  });
});
