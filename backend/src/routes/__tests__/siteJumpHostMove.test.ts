jest.mock('../../config/database');
jest.mock('../../services/AlertService', () => ({ alertService: { dispatch: jest.fn() } }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWrite: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
import sitesRoutes from '../sites';
import { query, queryOne } from '../../config/database';

/**
 * Moving devices to another site while they connect through their current
 * site's jump host is refused, and the refusal names them in the right
 * number: "connects … its" for one device, "connect … their" for several.
 */
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: unknown }).user = { userId: 1, username: 'admin', role: 'admin' };
  next();
});
app.use('/', sitesRoutes);

const viaGw = (name: string) => ({ name, jump_host: 'branch-gw' });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(queryOne).mockResolvedValue({ id: 2 } as never); // the site moved to
});

it.each([
  [[viaGw('core-1')],
    'core-1 connects through jump host "branch-gw", which belongs to its current site. '
    + 'Change its connection first, or make the jump host fleet-wide.'],
  [[viaGw('core-1'), viaGw('ap-2')],
    'core-1 and 1 other device connect through jump host "branch-gw", which belongs to their current site. '
    + 'Change their connection first, or make the jump host fleet-wide.'],
  [[viaGw('core-1'), viaGw('ap-2'), viaGw('ap-3')],
    'core-1 and 2 other devices connect through jump host "branch-gw", which belongs to their current site. '
    + 'Change their connection first, or make the jump host fleet-wide.'],
])('refuses %j, saying so in the right number', async (rows, message) => {
  jest.mocked(query).mockResolvedValueOnce(rows as never);
  const res = await request(app).post('/2/devices').send({ deviceIds: rows.map((_, i) => i + 1) });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ error: message, code: 'jump_host_other_site' });
  expect(jest.mocked(query).mock.calls.some(([sql]) => /UPDATE devices SET site_id/.test(String(sql)))).toBe(false);
});
