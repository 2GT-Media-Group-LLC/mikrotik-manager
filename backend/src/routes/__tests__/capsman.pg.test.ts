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
  // Who's asking: fleet-wide unless a test narrows it to some sites.
  let viewer: Record<string, unknown> = { userId: 1, username: 'admin', role: 'admin' };

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
    app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = viewer; next(); });
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

  it('the gateway router has no way up, and an unmanaged switch on the cable is a way up when nothing else is', async () => {
    const dev = async (n: string, ip: string, type: string) => (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, status)
       VALUES ($1, $2, 'u', 'x', $3, 'online') RETURNING id`, [n, ip, type]))[0].id;
    const byName = async (n: string) => (await db.query<{ id: number }>(`SELECT id FROM devices WHERE name = $1`, [n]))[0].id;
    const link = (from: number, fromIf: string, to: number | null, toIf: string, by: string, ident: string | null = null) => db.query(
      `INSERT INTO topology_links (from_device_id, from_interface, to_device_id, to_interface, neighbor_address, neighbor_identity, discovered_by)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT ip_address FROM devices WHERE id = $3), '10.7.0.250'),
               COALESCE((SELECT name FROM devices WHERE id = $3), $6), $5)`,
      [from, fromIf, to, toIf, by, ident]);
    const wired = (d: number, mac: string) => db.query(
      `INSERT INTO clients (device_id, mac_address, interface_name, active, client_type, last_seen)
       VALUES ($1, $2, 'ether2', true, 'wired', NOW())`, [d, mac]);
    const up = async (mac: string) => {
      const c = await get(`/api/clients/${mac}`) as Row;
      return [c.upstream_device_name ?? null, c.upstream_managed ?? null];
    };

    // Home: a PC on R1. Everything R1 hears goes up through it: SW to R1, the
    // WAP to SW. R1 used to go up to SW.
    expect(await up('02:00:00:00:00:06')).toEqual([null, null]);
    // SW, the switch under it, still goes up to R1.
    expect(await up('02:00:00:00:01:01')).toEqual(['R1', true]);

    // HQ: the router goes up to nothing, not to the core switch below it.
    const hqR = await byName('HQ-R');
    await link(hqR, 'sfp1', await byName('HQ-CORE'), 'sfp1', 'cdp,lldp,mndp');
    await wired(hqR, '02:00:00:00:01:05');
    expect(await up('02:00:00:00:01:05')).toEqual([null, null]);
    expect(await up('02:00:00:00:01:02')).toEqual(['HQ-CORE', true]);

    // A branch where the CAPs hang off an unmanaged switch, heard over LLDP.
    const ap1 = await dev('UN-AP1', '10.7.0.11', 'wireless_ap');
    await link(ap1, 'ether1', null, 'Port42', 'lldp', 'gs1920-48v2');
    await wired(ap1, '02:00:00:00:01:06');
    expect(await up('02:00:00:00:01:06')).toEqual(['gs1920-48v2', false]);
    // With a managed neighbour too, the managed one is the way up, as before.
    const brR2 = await dev('BR2-R', '10.7.0.1', 'router');
    const ap2 = await dev('UN-AP2', '10.7.0.12', 'wireless_ap');
    await link(ap2, 'ether1', null, 'Port43', 'lldp', 'gs1920-48v2');
    await link(ap2, 'ether1', brR2, 'ether6', 'mndp');
    await wired(ap2, '02:00:00:00:01:07');
    expect(await up('02:00:00:00:01:07')).toEqual(['BR2-R', true]);
    // An unmanaged neighbour heard only over MNDP could be anywhere: not a way up.
    const ap3 = await dev('UN-AP3', '10.7.0.13', 'wireless_ap');
    await link(ap3, 'ether1', null, 'eth0', 'mndp', 'some-other-ap');
    await wired(ap3, '02:00:00:00:01:08');
    expect(await up('02:00:00:00:01:08')).toEqual([null, null]);
  });

  it('walks the whole path by spanning tree, and starts a device\'s own address at the device', async () => {
    // A site of its own, so nothing above leaks in. CORE is the root bridge;
    // BIG's root port faces it; the AP's bridge hears no BPDUs, so it calls
    // itself root; MINI's root is an unmanaged switch at a lower priority.
    const site = (await db.query<{ id: number }>(`INSERT INTO sites (name) VALUES ('STP lab') RETURNING id`))[0].id;
    const dev = async (n: string, ip: string, type: string) => (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, status, site_id)
       VALUES ($1, $2, 'u', 'x', $3, 'online', $4) RETURNING id`, [n, ip, type, site]))[0].id;
    const core = await dev('LAB-CORE', '10.6.0.40', 'switch');
    const big = await dev('LAB-BIG', '10.6.0.39', 'switch');
    const ap = await dev('LAB-AP', '10.6.0.101', 'wireless_ap');
    const mini = await dev('LAB-MINI', '10.6.0.60', 'switch');
    const bridge = (d: number, bid: string, root: string, port: string, cost: number, designated: string | null) => db.query(
      `INSERT INTO device_bridges (device_id, bridge_name, bridge_id, root_bridge, root_bridge_id, root_port, root_path_cost, protocol_mode, designated_bridge_id)
       VALUES ($1, 'bridge', $2::text, $2::text = $3::text, $3, $4, $5, 'rstp', $6)`, [d, bid, root, port, cost, designated]);
    await bridge(core, '0x8000.F4:1E:57:51:74:1E', '0x8000.F4:1E:57:51:74:1E', 'none', 0, null);
    await bridge(big, '0x8000.F4:1E:57:BD:F0:2A', '0x8000.F4:1E:57:51:74:1E', 'sfp28-2', 800, '0x8000.F4:1E:57:51:74:1E');
    await bridge(ap, '0x8000.D0:EA:11:0A:DE:77', '0x8000.D0:EA:11:0A:DE:77', 'none', 0, null);
    await bridge(mini, '0x8000.38:32:7A:34:E5:1B', '0x2000.70:A7:41:EF:8F:FB', 'sfp-sfpplus1', 43010, '0x2000.70:A7:41:EF:8F:FB');
    const link = (from: number, fromIf: string, to: number | null, toIf: string, by: string, ident: string | null = null, mac: string | null = null) => db.query(
      `INSERT INTO topology_links (from_device_id, from_interface, to_device_id, to_interface, neighbor_address, neighbor_identity, neighbor_mac, discovered_by, link_type)
       VALUES ($1, $2, $3, $4, (SELECT ip_address FROM devices WHERE id = $3), COALESCE((SELECT name FROM devices WHERE id = $3), $6), $7, $5::text, split_part($5::text, ',', 1))`,
      [from, fromIf, to, toIf, by, ident, mac]);
    await link(big, 'sfp28-2', core, 'bridge/sfp28-2', 'cdp,lldp,mndp');
    await link(core, 'sfp28-2', big, 'bridge/sfp28-2', 'cdp,lldp,mndp');
    await link(core, 'sfp28-1', mini, 'bridge/sfp-sfpplus1', 'cdp,mndp');
    await link(ap, 'ether2', big, 'bridge/sfp28-2', 'cdp,mndp');
    await link(mini, 'sfp-sfpplus1', null, 'Port 24', 'lldp', 'USW-Core', '70:a7:41:ef:8f:fb');
    await link(mini, 'sfp-sfpplus1', big, 'bridge/sfp28-2', 'cdp,mndp');
    const client = (d: number, mac: string, iface: string, type = 'wired') => db.query(
      `INSERT INTO clients (device_id, mac_address, interface_name, active, client_type, last_seen)
       VALUES ($1, $2, $3, true, $4, NOW())`, [d, mac, iface, type]);
    const pathOf = async (mac: string) => {
      const c = await get(`/api/clients/${mac}`) as Row;
      return { device: c.device_name, own: (c.own_device as Row | null)?.name ?? null,
        path: (c.path as Row[]).map((h) => [h.name, h.port, h.how]) };
    };

    // A phone on the AP: up a tier to BIG (the AP is root only of itself),
    // then spanning tree to CORE, which is root: the top.
    await client(ap, '02:00:00:00:02:01', 'wifi4', 'wireless');
    expect(await pathOf('02:00:00:00:02:01')).toEqual({ device: 'LAB-AP', own: null, path: [
      ['LAB-BIG', 'sfp28-2', 'discovery'], ['LAB-CORE', 'sfp28-2', 'stp']] });

    // On MINI: spanning tree names the unmanaged switch at the other end, not BIG heard through it.
    await client(mini, '02:00:00:00:02:02', 'ether3');
    const onMini = await get('/api/clients/02:00:00:00:02:02') as Row;
    expect((onMini.path as Row[]).map((h) => [h.name, h.managed, h.from_port, h.how])).toEqual([['USW-Core', false, 'sfp-sfpplus1', 'stp']]);
    expect(onMini).toMatchObject({ upstream_device_name: 'USW-Core', upstream_managed: false });

    // BIG's own address, heard by every switch around it: its page starts at BIG.
    await db.query(`INSERT INTO interfaces (device_id, name, type, mac_address) VALUES ($1, 'sfp28-2', 'ether', 'f4:1e:57:bd:f0:33')`, [big]);
    await client(core, 'f4:1e:57:bd:f0:33', 'sfp28-2');
    await client(mini, 'f4:1e:57:bd:f0:33', 'sfp-sfpplus1');
    expect(await pathOf('f4:1e:57:bd:f0:33')).toEqual({ device: 'LAB-CORE', own: 'LAB-BIG', path: [['LAB-CORE', 'sfp28-2', 'stp']] });

    // Seen only on uplinks: not where it reaches MINI by MINI's root port, but
    // where CORE sees it on a port leading down.
    await client(mini, '02:00:00:00:02:03', 'sfp-sfpplus1');
    await client(core, '02:00:00:00:02:03', 'sfp28-2');
    expect((await pathOf('02:00:00:00:02:03')).device).toBe('LAB-CORE');

    // The AP's bridge hears no BPDUs, so spanning tree doesn't mark its uplink;
    // its link to a switch above still says the port leads up. The newer AP
    // sighting doesn't win.
    await client(core, '02:00:00:00:02:04', 'sfp28-1');
    await client(ap, '02:00:00:00:02:04', 'ether2');
    expect((await pathOf('02:00:00:00:02:04')).device).toBe('LAB-CORE');
    // A switch managed in another site, cabled to one here. Discovery doesn't
    // match across sites, but the LLDP neighbour's MAC is the other switch's
    // own and it uses that switch's name, and spanning tree names its bridge.
    const other = (await db.query<{ id: number }>(`INSERT INTO sites (name) VALUES ('Other lab') RETURNING id`))[0].id;
    const test = (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, status, site_id)
       VALUES ('LAB-TEST', '10.6.0.51', 'u', 'x', 'switch', 'online', $1) RETURNING id`, [other]))[0].id;
    await db.query(`INSERT INTO interfaces (device_id, name, type, mac_address) VALUES ($1, 'sfp-sfpplus1', 'ether', 'C4:AD:34:D5:BC:AF')`, [test]);
    await db.query(`INSERT INTO device_bridges (device_id, bridge_name, bridge_id, root_bridge, root_bridge_id, root_port, root_path_cost, protocol_mode)
       VALUES ($1, 'bridge', '0x3000.C4:AD:34:D5:BC:B7', false, '0x1000.70:A7:41:EF:8F:FB', 'ether1', 41010, 'rstp')`, [test]);
    const mini2 = await dev('LAB-MINI2', '10.6.0.61', 'switch');
    await bridge(mini2, '0x3000.38:32:7A:34:E5:1C', '0x1000.70:A7:41:EF:8F:FB', 'sfp-sfpplus1', 43010, '0x3000.C4:AD:34:D5:BC:B7');
    await link(mini2, 'sfp-sfpplus1', null, 'bridge/sfp-sfpplus1', 'cdp,lldp,mndp', 'LAB-TEST', 'C4:AD:34:D5:BC:AF');
    await client(mini2, '38:05:25:38:a6:aa', 'ether8');
    const hopsOf = async () => ((await get('/api/clients/38:05:25:38:a6:aa') as Row).path as Row[])
      .map((h) => ({ name: h.name, id: h.device_id, managed: h.managed, other: h.other_site ?? false }));
    expect(await hopsOf()).toEqual([{ name: 'LAB-TEST', id: test, managed: true, other: false }]);

    // Someone who can't see the other site gets the name discovery heard, and no more.
    viewer = { userId: 2, username: 'lab', role: 'viewer', siteRoles: { [site]: 'admin' } };
    try {
      expect(await hopsOf()).toEqual([{ name: 'LAB-TEST', id: null, managed: true, other: true }]);
    } finally {
      viewer = { userId: 1, username: 'admin', role: 'admin' };
    }

    // The same MAC under another name isn't proof: not the same box.
    await db.query(`UPDATE topology_links SET neighbor_identity = 'SOMETHING-ELSE' WHERE from_device_id = $1`, [mini2]);
    expect(await hopsOf()).toEqual([{ name: 'SOMETHING-ELSE', id: null, managed: false, other: false }]);
  });
});
