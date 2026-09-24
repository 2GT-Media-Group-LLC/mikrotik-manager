import express from 'express';
import request from 'supertest';

const inserted: unknown[][] = [];
jest.mock('../../config/database', () => ({
  query: jest.fn((_sql: string, params: unknown[]) => { inserted.push(params); return Promise.resolve([]); }),
}));

import { auditMiddleware } from '../auditMiddleware';

describe('auditMiddleware', () => {
  it('records the full path and entity, not the router-relative path', async () => {
    const app = express();
    app.use(auditMiddleware);
    const devices = express.Router();
    devices.post('/:id/sync', (_req, res) => { res.json({ ok: true }); });
    app.use('/api/devices', devices);

    await request(app).post('/api/devices/8/sync?x=1');
    await new Promise((r) => setImmediate(r));

    const [, , method, path, entityType, entityId, summary] = inserted[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/devices/8/sync');
    expect(entityType).toBe('device');
    expect(entityId).toBe(8);
    expect(summary).toBe('POST /api/devices/8/sync');
  });
});
