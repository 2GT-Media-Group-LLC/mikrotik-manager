import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';

jest.mock('../../config/redis', () => ({ redis: { exists: async () => 0 } }));
jest.mock('../../middleware/rateLimitRedis', () => ({
  loginRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitRedis: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const pg = process.env.PG_E2E_URL;
const suite = pg ? describe : describe.skip;

suite('initial admin password (Postgres)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const originalEnv = process.env;
  const database = 'mtm_e2e_initial_admin';
  const initialPassword = ' test-bootstrap-42 \n';
  let admin: Client;
  let db: typeof import('../../config/database');
  let runMigrations: typeof import('../migrate').runMigrations;
  let dir: string;
  let app: express.Express;

  beforeAll(async () => {
    const url = new URL(pg!);
    if (!/e2e|test/i.test(url.pathname)) throw new Error('PG_E2E_URL must name a test database');
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    url.pathname = `/${database}`;

    dir = await mkdtemp(join(tmpdir(), 'mtm-initial-admin-'));
    process.env = { ...originalEnv, DATABASE_URL: url.toString(), SECRETS_DIR: dir, PASSWORD_LOGIN: 'true' };
    delete process.env.DB_PASSWORD;
    delete process.env.INITIAL_ADMIN_PASSWORD;
    db = require('../../config/database');
    ({ runMigrations } = require('../migrate'));
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../routes/auth').default);
    await runMigrations();
  }, 30_000);

  beforeEach(async () => {
    delete process.env.INITIAL_ADMIN_PASSWORD;
    await db.query('DELETE FROM users');
  });

  afterAll(async () => {
    process.env = originalEnv;
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const login = (password: string) => request(app).post('/api/auth/login').send({ username: 'admin', password });

  it('preserves the default first-login flow when the setting is absent', async () => {
    const { body } = await loginAfterMigration('admin');
    expect(body.user.must_change_password).toBe(true);
  });

  it('accepts the environment password immediately and keeps a later password change', async () => {
    process.env.INITIAL_ADMIN_PASSWORD = initialPassword;
    const { body } = await loginAfterMigration(initialPassword);
    expect(body.user.must_change_password).toBe(false);

    const newPassword = 'test-replacement-68';
    await request(app).put('/api/auth/password').set('Authorization', `Bearer ${body.token}`)
      .send({ currentPassword: initialPassword, newPassword }).expect(200);
    await runMigrations();
    await login(initialPassword).expect(401);

    process.env.INITIAL_ADMIN_PASSWORD = '';
    await loginAfterMigration(newPassword);
    delete process.env.INITIAL_ADMIN_PASSWORD;
    await loginAfterMigration(newPassword);
  });

  it.each([
    '',
    'hide1',
  ])('rejects an invalid password with a redacted error (%#)', async (password) => {
    process.env.INITIAL_ADMIN_PASSWORD = password;
    await expect(runMigrations()).rejects.toHaveProperty('message',
      'Invalid INITIAL_ADMIN_PASSWORD: Password must be at least 10 characters long');
    expect(await db.query('SELECT id FROM users')).toEqual([]);
  });

  async function loginAfterMigration(password: string) {
    await runMigrations();
    return login(password).expect(200);
  }
});
