/**
 * CAPsMAN on the wireless and client pages, against a real Postgres (#365).
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 *
 * The site is the reporter's: R1, a router that's a CAPsMAN controller with no
 * radios; WAP, a CAP with two radios and traffic processed on the controller,
 * so the registration table is R1's and names the radios by R1's copies
 * (WAP-2.4Ghz, WAP-5Ghz); SW between them. The WAP hears R1 through SW over
 * MNDP as well as SW itself. Added: a guest SSID on a virtual AP, a second
 * controller whose CAP isn't a managed device, a standalone AP, and a
 * controller with a radio of its own (an RB4011) and one CAP. Last, the way
 * up where links tie: SW as the STP root, an HQ switch pair, a branch's CAPs.
 */
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWrite: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), getWriteApi: jest.fn(), bucket: 'test' }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import request from 'supertest';
import express from 'express';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

type Row = Record<string, unknown>;

suite('CAPsMAN controllers and CAPs on the wireless and client pages (#365)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-capsman-'));
  const id: Record<string, number> = {};

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_capsman';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = 'e2e-capsman-key-0123456789abcdef01234567';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    app = express();
    app.use(express.json());
    app.use('/api/wireless', require('../wireless').default);
    app.use('/api/clients', require('../clients').default);

    const devices: Array<[string, string, string, string, string | null]> = [
      // key, name, address, type, wifi role
      ['r1', 'R1', '10.0.0.1', 'router', 'controller'],
      ['wap', 'WAP', '10.0.0.3', 'wireless_ap', 'cap'],
      ['sw', 'SW', '10.0.0.2', 'switch', null],
      ['r2', 'R2-CTRL', '10.0.1.1', 'router', 'controller'],
      ['ap', 'AP-STANDALONE', '10.0.0.9', 'wireless_ap', 'standalone'],
      ['r3', 'R3-RB4011', '10.0.2.1', 'router', 'controller_cap'],
      ['wap2', 'WAP2', '10.0.2.3', 'wireless_ap', 'cap'],
    ];
    for (const [key, n, ip, type, role] of devices) {
      id[key] = (await db.query<{ id: number }>(
        `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, wifi_role, status)
         VALUES ($1, $2, 'u', 'x', $3, $4, 'online') RETURNING id`,
        [n, ip, type, role],
      ))[0].id;
    }

    const wi = (d: string, n: string, radioMac: string | null, freq: number | null, ssid: string | null, master: string | null = null, clients = 0) =>
      db.query(
        `INSERT INTO wireless_interfaces (device_id, name, ssid, frequency, disabled, radio_mac, managed_by_capsman, config_json, registered_clients)
         VALUES ($1, $2, $3, $4, false, $5, $6, $7::jsonb, $8)`,
        [id[d], n, ssid, freq, radioMac, d === 'wap' || d === 'wap2', JSON.stringify(master ? { 'master-interface': master } : {}), clients],
      );
    // The CAP's own radios: no local configuration, so no SSID.
    await wi('wap', 'wifi1_2.4Ghz', 'AA:00:00:00:00:01', null, null);
    await wi('wap', 'wifi2_5Ghz', 'AA:00:00:00:00:02', null, null);
    // R1's copies of them, and a guest SSID on the 5 GHz one.
    await wi('r1', 'WAP-2.4Ghz', 'AA:00:00:00:00:01', 2462, 'Aura');
    await wi('r1', 'WAP-5Ghz', 'AA:00:00:00:00:02', 5320, 'Aura');
    await wi('r1', 'WAP-5Ghz-guest', null, 5320, 'Aura-Guest', 'WAP-5Ghz');
    // R2's copy of a radio on a CAP that isn't managed.
    await wi('r2', 'CAP3-5Ghz', 'BB:00:00:00:00:01', 5180, 'Other');
    // A standalone AP.
    await wi('ap', 'wlan1', 'CC:00:00:00:00:01', 2437, 'Home');
    // R3's own radio, with 5 clients, and its copy of WAP2's, with WAP2's 90.
    await wi('r3', 'wifi1', 'DD:00:00:00:00:01', 2412, 'Shop', null, 5);
    await wi('r3', 'WAP2-5Ghz', 'DD:00:00:00:00:02', 5500, 'Shop', null, 90);
    await wi('wap2', 'wifi1', 'DD:00:00:00:00:02', null, null);

    const radio = (ctrl: string, mac: string, iface: string, matched: string | null, channel: string, peers: number, local = false) =>
      db.query(
        `INSERT INTO capsman_radios (controller_device_id, radio_mac, interface_name, local, matched_device_id, current_channel, registered_peers, ssid)
         VALUES ($1, $2, $3, $7, $4, $5, $6, 'Aura')`,
        [id[ctrl], mac, iface, matched ? id[matched] : null, channel, peers, local],
      );
    await radio('r1', 'AA:00:00:00:00:01', 'WAP-2.4Ghz', 'wap', '2462/ax/Ce', 7);
    await radio('r1', 'AA:00:00:00:00:02', 'WAP-5Ghz', 'wap', '5320/ax/Ceee', 4);
    await radio('r2', 'BB:00:00:00:00:01', 'CAP3-5Ghz', null, '5180/ax/Ceee', 2);
    await radio('r3', 'DD:00:00:00:00:01', 'wifi1', 'r3', '2412/ax/Ce', 5, true);
    await radio('r3', 'DD:00:00:00:00:02', 'WAP2-5Ghz', 'wap2', '5500/ax/Ceee', 90);

    const link = (from: string, fromIf: string, to: string, toIf: string, by = 'cdp,lldp,mndp') =>
      db.query(
        `INSERT INTO topology_links (from_device_id, from_interface, to_device_id, to_interface, neighbor_address, neighbor_identity, discovered_by)
         VALUES ($1, $2, $3, $4, (SELECT ip_address FROM devices WHERE id = $3), (SELECT name FROM devices WHERE id = $3), $5)`,
        [id[from], fromIf, id[to], toIf, by],
      );
    // R1, heard through SW: bridges pass MNDP on. The oldest row, as on the
    // reporter's site, and ether1 is a bridge port either way.
    await link('wap', 'ether1', 'r1', 'bridge/bonding/sfp-sfpplus1', 'mndp');
    await db.query(`INSERT INTO bridge_vlan_entries (device_id, bridge, port) VALUES ($1, 'bridge', 'ether1')`, [id.wap]);
    await link('wap', 'ether1', 'sw', 'ether5');
    await link('sw', 'ether5', 'wap', 'ether1');
    await link('sw', 'sfp-sfpplus1', 'r1', 'sfp-sfpplus1');
    await link('r1', 'sfp-sfpplus1', 'sw', 'sfp-sfpplus1');
    await link('r1', 'sfp-sfpplus1', 'wap', 'bridge/ether1', 'mndp');

    const seen = (d: string, mac: string, iface: string, type: string, signal: number | null = null) =>
      db.query(
        `INSERT INTO clients (device_id, mac_address, interface_name, active, client_type, signal_strength, last_seen, vlan_id)
         VALUES ($1, $2, $3, true, $4, $5, NOW(), 20)`,
        [id[d], mac, iface, type, signal],
      );
    // On the CAP's radios, as R1's registration table lists them.
    await seen('r1', '02:00:00:00:00:01', 'WAP-5Ghz', 'wireless', -60);
    await seen('r1', '02:00:00:00:00:02', 'WAP-2.4Ghz', 'wireless', -70);
    await seen('r1', '02:00:00:00:00:03', 'WAP-5Ghz-guest', 'wireless', -55);
    // A wired PC R1 knows by ARP stays on R1.
    await seen('r1', '02:00:00:00:00:06', 'vlan20', 'wired');
    // On the unmanaged CAP: it can only stay on R2.
    await seen('r2', '02:00:00:00:00:04', 'CAP3-5Ghz', 'wireless', -65);
    // On the standalone AP.
    await seen('ap', '02:00:00:00:00:05', 'wlan1', 'wireless', -50);
    await db.query(`INSERT INTO vlans (device_id, vlan_id, name, bridge) VALUES ($1, 20, 'staff', 'bridge')`, [id.r1]);
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = async (url: string) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    return res.body;
  };

  it('a controller with no radios is listed but is not an access point', async () => {
    const list = (await get('/api/wireless')) as Row[];
    const byName = Object.fromEntries(list.map((d) => [d.name, d]));
    expect(byName.R1).toMatchObject({ has_radios: false, radio_count: '0' });
    expect(byName['R2-CTRL']).toMatchObject({ has_radios: false });
    expect(byName.WAP).toMatchObject({ has_radios: true, radio_count: '2' });
    expect(byName['AP-STANDALONE']).toMatchObject({ has_radios: true });
    expect(list.filter((d) => d.has_radios).length).toBe(4);
    // A controller with a radio of its own: its own clients, not its CAP's too.
    expect(byName['R3-RB4011']).toMatchObject({ has_radios: true, radio_count: '1', client_count: '5' });
    expect(byName.WAP2).toMatchObject({ has_radios: true, client_count: '90' });
  });

  it('Channel Usage shows each radio once, under the controller it belongs to', async () => {
    const body = await get('/api/wireless/rf/channels') as { radios: Row[]; locations: Row[] };
    const radios = body.radios.map((r) => `${r.device_name}/${r.name}@${r.controller_name ?? '-'}`).sort();
    expect(radios).toEqual([
      'AP-STANDALONE/wlan1@-',
      // The CAP isn't managed: R2's copy is all there is, under R2.
      'R2-CTRL/CAP3-5Ghz@R2-CTRL',
      'R3-RB4011/wifi1@R3-RB4011',
      'WAP/wifi1_2.4Ghz@R1',
      'WAP/wifi2_5Ghz@R1',
      'WAP2/wifi1@R3-RB4011',
    ]);
    const wap5 = body.radios.find((r) => r.name === 'wifi2_5Ghz')!;
    expect(wap5).toMatchObject({ frequency: 5320, registered_clients: 4 });
    const r2 = body.radios.find((r) => r.name === 'CAP3-5Ghz')!;
    expect(r2).toMatchObject({ frequency: 5180, registered_clients: 2 });
    const locations = Object.fromEntries(body.locations.map((l) => [l.name, l.radios]));
    expect(locations).toEqual({ R1: 2, 'R2-CTRL': 1, 'R3-RB4011': 2, 'Standalone access points': 1 });
  });

  it('the signal map puts clients on the CAP', async () => {
    const rows = (await get('/api/wireless/rf/signals')) as Row[];
    const at = Object.fromEntries(rows.map((r) => [r.mac_address, r.device_name]));
    expect(at).toEqual({
      '02:00:00:00:00:01': 'WAP',
      '02:00:00:00:00:02': 'WAP',
      '02:00:00:00:00:03': 'WAP',
      '02:00:00:00:00:04': 'R2-CTRL',
      '02:00:00:00:00:05': 'AP-STANDALONE',
    });
    const perAp = (await get(`/api/wireless/rf/signals?deviceId=${id.wap}`)) as Row[];
    expect(perAp.map((r) => r.mac_address).sort()).toEqual(['02:00:00:00:00:01', '02:00:00:00:00:02', '02:00:00:00:00:03']);
  });

  it('the client list shows the CAP, its interface, and the SSID', async () => {
    const body = await get('/api/clients?limit=50') as { clients: Row[]; total: number };
    const by = Object.fromEntries(body.clients.map((c) => [c.mac_address, c]));
    expect(body.total).toBe(6);
    expect(by['02:00:00:00:00:01']).toMatchObject({ device_name: 'WAP', interface_name: 'wifi2_5Ghz', ssid: 'Aura', client_type: 'wireless', device_id: id.wap });
    expect(by['02:00:00:00:00:02']).toMatchObject({ device_name: 'WAP', interface_name: 'wifi1_2.4Ghz', ssid: 'Aura' });
    // A virtual AP keeps the controller's name for it, on the CAP.
    expect(by['02:00:00:00:00:03']).toMatchObject({ device_name: 'WAP', interface_name: 'WAP-5Ghz-guest', ssid: 'Aura-Guest' });
    expect(by['02:00:00:00:00:04']).toMatchObject({ device_name: 'R2-CTRL', interface_name: 'CAP3-5Ghz', ssid: 'Other' });
    expect(by['02:00:00:00:00:05']).toMatchObject({ device_name: 'AP-STANDALONE', interface_name: 'wlan1', ssid: 'Home' });

    const onWap = await get(`/api/clients?deviceId=${id.wap}`) as { clients: Row[]; total: number };
    expect(onWap.total).toBe(3);
    const onR1 = await get(`/api/clients?deviceId=${id.r1}`) as { clients: Row[] };
    // Only the wired PC is left on R1.
    expect(onR1.clients.map((c) => [c.mac_address, c.interface_name])).toEqual([['02:00:00:00:00:06', 'vlan20']]);
  });

  it('client detail: on the CAP, with the switch as its way up, not the router heard through it', async () => {
    const c = await get('/api/clients/02:00:00:00:00:01') as Row;
    expect(c).toMatchObject({
      device_name: 'WAP', device_type: 'wireless_ap', interface_name: 'wifi2_5Ghz', ssid: 'Aura',
      upstream_device_name: 'SW', upstream_interface: 'ether5',
      // The CAP has no VLAN 20 of its own; the controller names it.
      vlan_name: 'staff',
      reported_by_device_id: id.r1,
    });
  });

  // Last: adds devices, links and clients the counts above don't expect.
  it("a switch with no root port goes up to the router, and two switches don't go up to each other", async () => {
    const dev = async (n: string, ip: string, type: string) => (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, status)
       VALUES ($1, $2, 'u', 'x', $3, 'online') RETURNING id`, [n, ip, type]))[0].id;
    const link = (from: number, fromIf: string, to: number, toIf: string, by = 'cdp,lldp,mndp') => db.query(
      `INSERT INTO topology_links (from_device_id, from_interface, to_device_id, to_interface, neighbor_address, neighbor_identity, discovered_by)
       VALUES ($1, $2, $3, $4, (SELECT ip_address FROM devices WHERE id = $3), (SELECT name FROM devices WHERE id = $3), $5)`,
      [from, fromIf, to, toIf, by]);
    const wired = (d: number, mac: string) => db.query(
      `INSERT INTO clients (device_id, mac_address, interface_name, active, client_type, last_seen)
       VALUES ($1, $2, 'ether2', true, 'wired', NOW())`, [d, mac]);
    const upFor = async (mac: string) => (await get(`/api/clients/${mac}`) as Row).upstream_device_name;

    // The reporter's SW is the STP root bridge: no root port, and its links to
    // R1 and down to the WAP are both bridge ports heard over LLDP. The WAP's
    // row is the older one.
    for (const port of ['ether5', 'sfp-sfpplus1']) {
      await db.query(`INSERT INTO bridge_vlan_entries (device_id, bridge, port) VALUES ($1, 'bridge', $2)`, [id.sw, port]);
    }
    await wired(id.sw, '02:00:00:00:01:01');
    expect(await upFor('02:00:00:00:01:01')).toBe('R1');
    // The WAP still goes up to SW, not to R1 heard through it.
    expect(await upFor('02:00:00:00:00:01')).toBe('SW');

    // HQ: two switches with no root port hear each other first; each also
    // has a link that ties with it, to the core and to an AP below.
    const hqR = await dev('HQ-R', '10.9.0.1', 'router');
    const core = await dev('HQ-CORE', '10.9.0.2', 'switch');
    const sw02 = await dev('SW02', '10.9.0.3', 'switch');
    const ftc = await dev('FTC-SW01', '10.9.0.4', 'switch');
    const sw03 = await dev('SW03', '10.9.0.5', 'switch');
    await link(sw02, 'ether11', ftc, 'ether1');
    await link(ftc, 'ether1', sw02, 'ether11');
    await link(sw02, 'ether1', core, 'ether3');
    await link(ftc, 'ether9', sw03, 'ether1');
    await link(sw03, 'ether1', ftc, 'ether9');
    await link(core, 'ether3', sw02, 'ether1');
    await link(core, 'sfp1', hqR, 'sfp1');
    await wired(sw02, '02:00:00:00:01:02');
    await wired(ftc, '02:00:00:00:01:03');
    expect(await upFor('02:00:00:00:01:02')).toBe('HQ-CORE');
    expect(await upFor('02:00:00:00:01:03')).toBe('SW02');

    // A branch with an unmanaged switch: the CAPs hear each other and the
    // router over MNDP, on the same VLAN interface.
    const brR = await dev('BR-R', '10.8.0.1', 'router');
    const ap01 = await dev('AP01', '10.8.0.11', 'wireless_ap');
    const ap02 = await dev('AP02', '10.8.0.12', 'wireless_ap');
    await link(ap02, 'vlan10', ap01, 'vlan10', 'mndp');
    await link(ap02, 'vlan10', brR, 'vlan10', 'mndp');
    await link(ap01, 'vlan10', ap02, 'vlan10', 'mndp');
    await link(ap01, 'vlan10', brR, 'vlan10', 'mndp');
    await wired(ap02, '02:00:00:00:01:04');
    expect(await upFor('02:00:00:00:01:04')).toBe('BR-R');
  });
});
