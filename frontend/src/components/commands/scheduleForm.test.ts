import { describe, it, expect } from 'vitest';
import { scheduleErrors } from './ScheduleForm';
import type { CommandScheduleInput } from '../../services/api';

const base: CommandScheduleInput = {
  name: '', command: '/system backup save', device_ids: [1], tag_ids: [], site_ids: [], wave_size: 1,
  halt_on_failure: true, use_change_guard: true, maintenance_only: false, alert_on_failure: true,
  kind: 'simple', run_at: null, cron: null, simple: { freq: 'daily', time: '03:00' },
};
const NOW = new Date('2026-11-07T18:00:00Z');

describe('schedule form checks (#359)', () => {
  it('accepts a complete schedule', () => {
    expect(scheduleErrors(base, NOW)).toEqual({});
    expect(scheduleErrors({ ...base, device_ids: [], tag_ids: [2] }, NOW)).toEqual({});
  });
  it('says what is missing or wrong, the way the server does', () => {
    expect(scheduleErrors({ ...base, command: ' ', device_ids: [] }, NOW)).toMatchObject({ command: expect.any(String), targets: expect.any(String) });
    expect(scheduleErrors({ ...base, kind: 'once', run_at: '2026-11-07T17:00:00Z' }, NOW).run_at).toMatch(/future/);
    expect(scheduleErrors({ ...base, simple: { freq: 'monthly', time: '03:00', monthday: 30 } }, NOW).simple).toMatch(/1 to 28/);
    expect(scheduleErrors({ ...base, kind: 'cron', cron: '0 3 * *' }, NOW).cron).toMatch(/five fields/);
    expect(scheduleErrors({ ...base, kind: 'cron', cron: '0 3 * * mon-fri' }, NOW)).toEqual({});
    expect(scheduleErrors({ ...base, kind: 'cron', cron: '0 3 * * ;rm' }, NOW).cron).toBeDefined();
  });
});
