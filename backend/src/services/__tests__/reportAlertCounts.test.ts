import { reportService } from '../ReportService';
import { query } from '../../config/database';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockedQuery = jest.mocked(query);

describe('scheduled report alert counts', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("severity='error'")) return [{ errors: '3', warnings: '1512' }] as never;
      if (sql.includes('FROM devices')) return [{ total: '4', online: '3', updates: '1' }] as never;
      if (sql.includes('FROM device_availability')) return [{ n: '0', secs: '0' }] as never;
      if (sql.includes('FROM backups')) return [{ n: '2' }] as never;
      return [] as never;
    });
  });

  it('reads only the error and warning events of the period', async () => {
    const html = await (reportService as unknown as { buildHtml(f: string): Promise<string> }).buildHtml('weekly');
    const sql = String(mockedQuery.mock.calls.map(([s]) => s).find((s) => String(s).includes("severity='error'")));
    // Without it the query visits every (mostly info) event of the period.
    expect(sql).toContain("WHERE severity IN ('error','warning')");
    expect(html).toContain('1512');
  });
});
