jest.mock('../../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn(), pool: {} }));
jest.mock('../../AlertService', () => ({ alertService: { dispatch: jest.fn() } }));
import { scheduleCron } from '../service';
import { versionNotNewer } from '../engine';
import { cronMatches } from '../../../utils/cron';

describe('platform backup schedule', () => {
  it('turns the schedule into a cron expression', () => {
    expect(scheduleCron({ frequency: 'daily', time_of_day: '02:30', weekday: 0, monthday: 1 })).toBe('30 2 * * *');
    expect(scheduleCron({ frequency: 'weekly', time_of_day: '23:05', weekday: 6, monthday: 1 })).toBe('5 23 * * 6');
    expect(scheduleCron({ frequency: 'monthly', time_of_day: '00:00', weekday: 0, monthday: 15 })).toBe('0 0 15 * *');
  });

  it('fires at the set time in the app’s time zone', () => {
    const cron = scheduleCron({ frequency: 'daily', time_of_day: '02:30', weekday: 0, monthday: 1 });
    // 02:30 in New York (EDT, UTC-4) is 06:30 UTC.
    expect(cronMatches(cron, new Date('2026-10-16T06:30:10Z'), 'America/New_York')).toBe(true);
    expect(cronMatches(cron, new Date('2026-10-16T02:30:10Z'), 'America/New_York')).toBe(false);
  });
});

describe('versionNotNewer', () => {
  it('lets an older or equal backup restore and refuses a newer one', () => {
    expect(versionNotNewer('0.61.2-beta', '0.62.0-beta')).toBe(true);
    expect(versionNotNewer('0.62.0-beta', '0.62.0-beta')).toBe(true);
    expect(versionNotNewer('0.62.1-beta', '0.62.0-beta')).toBe(false);
    // Release candidates (1.0): an RC is older than its release.
    expect(versionNotNewer('1.0.0-rc.1', '1.0.0')).toBe(true);
    expect(versionNotNewer('1.0.0', '1.0.0-rc.1')).toBe(false);
    expect(versionNotNewer('1.0.0-rc.2', '1.0.0-rc.1')).toBe(false);
    expect(versionNotNewer('1.0.0', '0.99.9')).toBe(false);
    expect(versionNotNewer('0.9.0', '0.10.0')).toBe(true);
  });
});
