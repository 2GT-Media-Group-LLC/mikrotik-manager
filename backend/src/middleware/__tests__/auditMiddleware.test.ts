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

  it('leaves MCP requests to the connector, but records refused ones', async () => {
    inserted.length = 0;
    const app = express();
    app.use(auditMiddleware);
    app.post('/api/mcp', (req, res) => { res.sendStatus(req.get('authorization') ? 200 : 401); });

    await request(app).post('/api/mcp').set('Authorization', 'Bearer x');
    await request(app).post('/api/mcp');
    await new Promise((r) => setImmediate(r));

    expect(inserted).toHaveLength(1);
    expect(inserted[0][8]).toBe(401);
  });
});
