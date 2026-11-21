/**
 * Devices on a package mirror count as having an update everywhere, against a
 * real Postgres (#482).
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 *
 * The reporter's fleet: switches with no internet pull through the manager's
 * package mirror on the router. The Firmware page listed their update; the
 * Dashboard, which reads the stored flag, showed only the router's.
 */
jest.mock('../../config/redis', () => {
  const stub = (): unknown => new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : prop === 'status' ? 'ready'
      : () => Promise.resolve(prop === 'set' ? 'OK' : null)),
  });
  return { redis: stub(), limiterRedis: () => stub(), createRedisConnection: () => stub() };
});
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), getWriteApi: jest.fn(), bucket: 'test' }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('package mirror updates against Postgres (#482)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let mirror: typeof import('../firmwareMirror');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-mirrorupd-'));
  const id: Record<string, number> = {};

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_mirrorupd';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = 'e2e-mirrorupd-key-0123456789abcdef01234567';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();
    mirror = require('../firmwareMirror');

    // key, RouterOS, packages, flagged by its own check, latest from its own check
    const devices: Array<[string, string, string[], boolean, string | null]> = [
      ['router', '7.21.4', ['routeros'], true, '7.22'],     // the package server, online
      ['sw1', '7.21.4', ['routeros'], false, null],         // no internet
      ['sw2', '7.21.4', ['routeros'], false, null],
      ['ap', '7.21.4', ['routeros', 'wifi-qcom'], false, null], // wifi-qcom isn't on the mirror
      ['broken', '7.21.4', ['routeros'], false, null],       // its mirror setup failed
      ['current', '7.22', ['routeros'], false, null],        // already on the mirror's version
      ['ahead', '7.20', ['routeros'], true, '7.23'],         // MikroTik offers newer than the mirror
    ];
    for (const [key, ros, pkgs, flagged, latest] of devices) {
      id[key] = (await db.query<{ id: number }>(
        `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, ros_version, architecture,
                              installed_packages, firmware_update_available, latest_ros_version)
         VALUES ($1, $2, 'u', 'x', $3, 'arm64', $4::text[], $5, $6) RETURNING id`,
        [key, `10.98.0.${Object.keys(id).length + 1}`, ros, pkgs, flagged, latest],
      ))[0].id;
    }
    const m = (await db.query<{ id: number }>(
      `INSERT INTO firmware_mirrors (device_id, status) VALUES ($1, 'ready') RETURNING id`, [id.router]))[0].id;
    for (const v of ['7.21.4', '7.22']) {
      await db.query(
        `INSERT INTO firmware_mirror_files (mirror_id, version, package, architecture, filename, size_bytes, sha256)
         VALUES ($1, $2, 'routeros', 'arm64', $3, 1, $4)`, [m, v, `routeros-${v}-arm64.npk`, '0'.repeat(64)]);
    }
    for (const key of ['sw1', 'sw2', 'ap', 'current', 'ahead']) {
      await db.query(`INSERT INTO firmware_mirror_clients (device_id, mirror_id, status) VALUES ($1, $2, 'ok')`, [id[key], m]);
    }
    await db.query(`INSERT INTO firmware_mirror_clients (device_id, mirror_id, status, error) VALUES ($1, $2, 'error', 'login failed')`, [id.broken, m]);
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const flags = async () => Object.fromEntries((await db.query<{ name: string; firmware_update_available: boolean; latest_ros_version: string | null }>(
    `SELECT name, firmware_update_available, latest_ros_version FROM devices`))
    .map((d) => [d.name, [d.firmware_update_available, d.latest_ros_version]]));

  it('knows what the mirror holds for each device it can upgrade', async () => {
    const v = await mirror.mirrorVersions();
    expect(Object.fromEntries([...v].map(([k, ver]) => [Object.keys(id).find((n) => id[n] === k), ver]))).toEqual({
      sw1: '7.22', sw2: '7.22', current: '7.22', ahead: '7.22',
    });
    expect([...(await mirror.mirrorVersions([id.sw1, id.router])).keys()]).toEqual([id.sw1]);
  });

  it('flags the switches without internet, and only them', async () => {
    const changed = await mirror.flagMirrorUpdates();
    expect(changed.map((d) => [d.name, d.latest, d.newly]).sort()).toEqual([
      ['sw1', '7.22', true], ['sw2', '7.22', true],
    ]);
    expect(await flags()).toEqual({
      router: [true, '7.22'],
      sw1: [true, '7.22'],
      sw2: [true, '7.22'],
      ap: [false, null],
      broken: [false, null],
      current: [false, null],
      ahead: [true, '7.23'],
    });
  });

  it('a second pass changes nothing, so the alert goes out once', async () => {
    expect(await mirror.flagMirrorUpdates()).toEqual([]);
  });
});
