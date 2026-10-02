import { computeNextRun } from '../ReportService';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));

// Outside review J5.
describe('computeNextRun', () => {
  it('never skips a short month', () => {
    const next = computeNextRun('monthly', new Date(2027, 0, 31, 7, 0, 0));
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours()]).toEqual([2027, 1, 1, 7]);
  });
  it('runs monthly reports on the 1st, year boundary included', () => {
    const next = computeNextRun('monthly', new Date(2026, 11, 15, 6, 30));
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2027, 0, 1]);
  });
  it('keeps daily and weekly as they were', () => {
    expect(computeNextRun('daily', new Date(2027, 1, 28)).getDate()).toBe(1);
    expect(computeNextRun('weekly', new Date(2027, 0, 1)).getDate()).toBe(8);
  });
});
