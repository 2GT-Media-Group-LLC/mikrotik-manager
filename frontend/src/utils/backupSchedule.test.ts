import { describe, expect, it } from 'vitest';
import { describeBackupSchedule, parseBackupCron, scheduleToCron } from './backupSchedule';

describe('backup time display', () => {
  it('uses the browser hour cycle by default', () => {
    const schedule = parseBackupCron('30 14 * * *');
    expect(describeBackupSchedule(schedule, 'browser', 'en-US')).toBe('Every day at 02:30 PM');
    expect(describeBackupSchedule(schedule, 'browser', 'nb-NO')).toBe('Every day at 14:30');
  });

  it.each(['30 14 * * *', '0 0 * * 0', '45 23 28 * *'])('does not change the cron when formatting %s', (cron) => {
    const schedule = parseBackupCron(cron);
    const original = { ...schedule };
    describeBackupSchedule(schedule, '12h', 'en-GB');
    describeBackupSchedule(schedule, '24h', 'en-US');
    expect(schedule).toEqual(original);
    expect(scheduleToCron(schedule)).toBe(cron);
  });
});
