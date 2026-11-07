import { simpleToCron, cronError, nextRunAt, dueDecision, describeSchedule, parseScheduleInput, GRACE_MS } from '../commandSchedule';

const NOW = new Date('2026-11-07T18:00:00Z');

describe('command schedules (#359)', () => {
  it('compiles simple schedules to cron', () => {
    expect(simpleToCron({ freq: 'daily', time: '03:05' })).toBe('5 3 * * *');
    expect(simpleToCron({ freq: 'weekly', time: '23:00', weekday: 0 })).toBe('0 23 * * 0');
    expect(simpleToCron({ freq: 'monthly', time: '00:30', monthday: 15 })).toBe('30 0 15 * *');
  });

  it('takes five-field cron only, and says what is wrong', () => {
    expect(cronError('*/15 2-4 * * 1-5')).toBeNull();
    expect(cronError('0 3 * *')).toMatch(/five fields/);
    expect(cronError('0 0 3 * * *')).toMatch(/five fields/);
    expect(cronError('61 * * * *')).toMatch(/0-59/);
  });

  it('finds the next run in the manager\'s time zone', () => {
    // 03:00 every Monday in Los Angeles is 11:00 UTC (PST).
    expect(nextRunAt({ kind: 'cron', run_at: null, cron: '0 3 * * 1' }, NOW, 'America/Los_Angeles')!.toISOString()).toBe('2026-11-09T11:00:00.000Z');
    expect(nextRunAt({ kind: 'simple', run_at: null, cron: '0 3 * * *' }, NOW, 'UTC')!.toISOString()).toBe('2026-11-08T03:00:00.000Z');
    // A one-off runs once: in the future it's next, once passed there's none.
    expect(nextRunAt({ kind: 'once', run_at: '2026-11-08T09:00:00Z', cron: null }, NOW, 'UTC')!.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect(nextRunAt({ kind: 'once', run_at: '2026-11-07T17:00:00Z', cron: null }, NOW, 'UTC')).toBeNull();
  });

  it('fires on time, a little late, but never long after', () => {
    expect(dueDecision(new Date(NOW.getTime() + 1000), NOW)).toBe('wait');
    expect(dueDecision(new Date(NOW.getTime() - 60_000), NOW)).toBe('fire');
    expect(dueDecision(new Date(NOW.getTime() - GRACE_MS - 1), NOW)).toBe('missed');
  });

  it('describes a schedule the way it was chosen', () => {
    expect(describeSchedule({ kind: 'simple', run_at: null, cron: '0 3 * * 1', simple: { freq: 'weekly', time: '03:00', weekday: 1 } })).toBe('Mondays at 03:00');
    expect(describeSchedule({ kind: 'simple', run_at: null, cron: '0 3 22 * *', simple: { freq: 'monthly', time: '03:00', monthday: 22 } })).toBe('Monthly on the 22nd at 03:00');
    expect(describeSchedule({ kind: 'cron', run_at: null, cron: '*/15 * * * *', simple: null })).toBe('Cron */15 * * * *');
  });

  it('checks the form field by field', () => {
    const ok = parseScheduleInput({ command: '/system backup save', tag_ids: [3], kind: 'simple', simple: { freq: 'daily', time: '02:00' } }, NOW);
    expect(ok).toMatchObject({ schedule: { name: '/system backup save', cron: '0 2 * * *', use_change_guard: true, alert_on_failure: true, maintenance_only: false } });
    const bad = parseScheduleInput({ command: '', kind: 'once', run_at: '2026-11-01T00:00:00Z' }, NOW);
    expect('errors' in bad && bad.errors).toMatchObject({ command: expect.any(String), targets: expect.any(String), run_at: expect.stringMatching(/future/) });
    expect(parseScheduleInput({ command: 'x', device_ids: [1], kind: 'simple', simple: { freq: 'monthly', time: '02:00', monthday: 31 } }, NOW))
      .toMatchObject({ errors: { simple: expect.stringMatching(/1 to 28/) } });
    expect(parseScheduleInput({ command: 'x', device_ids: ['1; drop'], kind: 'cron', cron: '0 2 * * *' }, NOW)).toMatchObject({ errors: { targets: expect.any(String) } });
    expect(parseScheduleInput({ command: 'x', site_ids: [2], kind: 'cron', cron: '0  2 * *   *' }, NOW)).toMatchObject({ schedule: { cron: '0 2 * * *' } });
  });
});
