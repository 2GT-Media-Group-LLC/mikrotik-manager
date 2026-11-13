/**
 * The update check's 24-hour cache answers only for the version and channel
 * that wrote it. After an update it said the newest release was older than
 * the one running (reported in #443).
 */
jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWrite: (_req: unknown, _res: unknown, next: () => void) => next(),
  fleetOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
import { query } from '../../config/database';

const mockedQuery = jest.mocked(query);
const SOURCE = 'https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/main/frontend/package.json';

let systemRoutes: express.Router;
beforeAll(() => {
  process.env.npm_package_version = '1.0.16';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  systemRoutes = require('../system').default;
});

function makeApp() {
  const app = express();
  app.use('/api/system', systemRoutes);
  return app;
}

describe('GET /api/system/version-check', () => {
  let cache: Record<string, unknown> | undefined;
  const fetchMock = jest.fn();

  beforeEach(() => {
    cache = undefined;
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.17' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedQuery.mockReset().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("'update_check_enabled'")) return [] as never;
      if (sql.includes('SELECT value') && sql.includes("'version_check_cache'")) return (cache ? [{ value: cache }] : []) as never;
      if (sql.includes('INSERT INTO app_settings')) cache = JSON.parse(String(params?.[0]));
      return [] as never;
    });
  });

  const fresh = () => new Date().toISOString();

  it('uses a fresh cache written by this version for this channel', async () => {
    cache = { version: '1.0.17', checked_at: fresh(), for_version: '1.0.16', source: SOURCE };
    const res = await request(makeApp()).get('/api/system/version-check');
    expect(res.body).toEqual({ current: '1.0.16', latest: '1.0.17', update_available: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks again after an update, rather than call an older release the latest', async () => {
    cache = { version: '1.0.15', checked_at: fresh(), for_version: '1.0.15', source: SOURCE };
    const res = await request(makeApp()).get('/api/system/version-check');
    expect(fetchMock).toHaveBeenCalledWith(SOURCE, expect.anything());
    expect(res.body).toEqual({ current: '1.0.16', latest: '1.0.17', update_available: true });
    expect(cache).toMatchObject({ version: '1.0.17', for_version: '1.0.16', source: SOURCE });
  });

  it('checks again when the cache came from the other channel', async () => {
    cache = { version: '1.1.0-beta.48', checked_at: fresh(), for_version: '1.0.16',
      source: SOURCE.replace('/main/', '/dev/') };
    const res = await request(makeApp()).get('/api/system/version-check');
    expect(fetchMock).toHaveBeenCalled();
    expect(res.body.latest).toBe('1.0.17');
  });

  it('checks again for a cache from before it said what wrote it', async () => {
    cache = { version: '1.0.15', checked_at: fresh() };
    await request(makeApp()).get('/api/system/version-check');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('checks again once the cache is a day old', async () => {
    cache = { version: '1.0.16', checked_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      for_version: '1.0.16', source: SOURCE };
    await request(makeApp()).get('/api/system/version-check');
    expect(fetchMock).toHaveBeenCalled();
  });
});
