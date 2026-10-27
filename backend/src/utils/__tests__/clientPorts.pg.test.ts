/**
 * Where a client is shown, and a device's way up, against a real Postgres (#363).
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 *
 * The fabric is the reporter's: access switches with an LACP bond (Po1) to a
 * core switch, a router above that, and an out-of-band management router on
 * a dedicated port of every device. RouterOS names a bonded bridge port by
 * its path ("bridge/Po1/sfp-sfpplus1") in the neighbour table.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { INFRA_PORTS_CTE, CLIENT_PORT_RANK, CLIENT_SIGHTING_ORDER, UPSTREAM_LINK_ORDER } from '../clientPorts';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('client port and upstream choice against Postgres (#363)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-clientports-'));
  const id: Record<string, number> = {};

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_clientports';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = 'e2e-clientports-key-0123456789abcdef0123';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    const devices: Array<[string, string, string, string]> = [
      // key, name, management address, interface holding it
      ['rtr', '01-RTR01', '10.99.0.10', 'ether1'],
      ['csw', '01-CSW01', '10.99.0.11', 'ether1'],
      ['asw', '01-ASW01-2F', '10.99.0.13', 'ether49'],
      ['mgmt', '99-MGMT-RTR01', '10.99.0.1', 'vlan99'],
      ['inband', '01-ASW02-INBAND', '10.0.10.15', 'bridge'],
      ['vlanmgmt', '01-ASW03-VLANMGMT', '10.99.0.16', 'vlan99-mgmt'],
    ];
    for (const [key, n, ip, iface] of devices) {
      id[key] = (await db.query<{ id: number }>(
        `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, ip_addresses_jsonb)
         VALUES ($1, $2, 'u', 'x', $3::jsonb) RETURNING id`,
        [n, ip, JSON.stringify([{ address: `${ip}/24`, interface: iface, dynamic: false }])],
      ))[0].id;
    }
    const link = (from: string, fromIf: string, to: string | null, toIf: string, addr: string, ident: string) =>
      db.query(
        `INSERT INTO topology_links (from_device_id, from_interface, to_device_id, to_interface, neighbor_address, neighbor_identity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id[from], fromIf, to ? id[to] : null, toIf, addr, ident],
      );
    // The management link is the oldest row, as on the reporter's site.
    await link('asw', 'ether49', 'mgmt', 'vlan99', '10.99.0.1', '99-MGMT-RTR01');
    await link('asw', 'bridge/Po1/sfp-sfpplus1', 'csw', 'bridge/Po6/sfp-sfpplus6', '10.99.0.11', '01-CSW01');
    await link('csw', 'sfp-sfpplus6', 'asw', 'bridge/Po1/sfp-sfpplus1', '10.99.0.13', '01-ASW01-2F');
    await link('csw', 'bridge/Po1/sfp-sfpplus1', 'rtr', 'bridge/Po3/sfp-sfpplus3', '10.99.0.10', '01-RTR01');
    await link('rtr', 'sfp-sfpplus3', 'csw', 'bridge/Po1/sfp-sfpplus1', '10.99.0.11', '01-CSW01');
    // An unmanaged AP: not infrastructure, clients behind it stay on ether7.
    await link('asw', 'ether7', null, 'eth0', '10.0.10.50', 'some-unmanaged-ap');
    // Several managed neighbours on one port (an unmanaged switch in between):
    // the topology leaves to_device_id empty, but it's still an uplink.
    await link('rtr', 'ether2', null, 'bridge/ether9', '10.99.0.11', '01-CSW01');
    await link('inband', 'ether1', 'mgmt', 'vlan99', '10.99.0.1', '99-MGMT-RTR01');
    await link('inband', 'sfp-sfpplus1', 'csw', 'bridge/Po8/sfp-sfpplus8', '10.99.0.11', '01-CSW01');
    await link('vlanmgmt', 'ether49', 'mgmt', 'vlan99', '10.99.0.1', '99-MGMT-RTR01');
    await link('vlanmgmt', 'sfp-sfpplus1', 'csw', 'bridge/Po9/sfp-sfpplus9', '10.99.0.11', '01-CSW01');

    const ports: Array<[string, string]> = [
      ['asw', 'Po1'], ['asw', 'ether5'], ['asw', 'ether7'],
      ['csw', 'Po6'], ['csw', 'Po1'], ['rtr', 'Po3'], ['rtr', 'ether2'],
      ['inband', 'sfp-sfpplus1'], ['vlanmgmt', 'sfp-sfpplus1'],
    ];
    for (const [d, p] of ports) {
      await db.query(`INSERT INTO bridge_vlan_entries (device_id, bridge, port) VALUES ($1, 'bridge', $2)`, [id[d], p]);
    }

    const seen = (d: string, mac: string, iface: string, ageSec: number, active = true, type = 'wired') =>
      db.query(
        `INSERT INTO clients (device_id, mac_address, interface_name, active, client_type, last_seen)
         VALUES ($1, $2, $3, $4, $5, NOW() - make_interval(secs => $6))`,
        [id[d], mac, iface, active, type, ageSec],
      );
    // A PC on an access port, also learned by the core on its bond and by the router (ARP).
    await seen('asw', '02:00:00:00:00:01', 'ether5', 60);
    await seen('csw', '02:00:00:00:00:01', 'Po6', 10);
    await seen('rtr', '02:00:00:00:00:01', 'vlan10', 5);
    // Behind an unmanaged AP on ether7.
    await seen('asw', '02:00:00:00:00:02', 'ether7', 60);
    await seen('csw', '02:00:00:00:00:02', 'Po6', 1);
    // Known only to the router by ARP, and to the core on its uplink.
    await seen('rtr', '02:00:00:00:00:03', 'vlan10', 5);
    await seen('csw', '02:00:00:00:00:03', 'Po1', 1);
    // A live sighting beats a stale edge one.
    await seen('asw', '02:00:00:00:00:04', 'ether5', 86_400, false);
    await seen('csw', '02:00:00:00:00:04', 'Po6', 1);
    // Seen on the router's ether2, which faces an unmanaged switch with the core
    // behind it, and on an access port: ether2 is an uplink, so the access port wins.
    await seen('rtr', '02:00:00:00:00:05', 'ether2', 1);
    await seen('asw', '02:00:00:00:00:05', 'ether5', 30);
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function picks(): Promise<Record<string, string>> {
    const rows = await db.query<{ mac_address: string; device_id: number; interface_name: string }>(
      `WITH ${INFRA_PORTS_CTE}
       SELECT DISTINCT ON (c.mac_address) c.mac_address, c.device_id, c.interface_name
         FROM clients c
        ORDER BY c.mac_address, ${CLIENT_SIGHTING_ORDER}`,
    );
    const name = Object.fromEntries(Object.entries(id).map(([k, v]) => [v, k]));
    return Object.fromEntries(rows.map((r) => [r.mac_address, `${name[r.device_id]}/${r.interface_name}`]));
  }

  it('shows a client on the edge port, not on an uplink bond', async () => {
    const p = await picks();
    expect(p['02:00:00:00:00:01']).toBe('asw/ether5');
    expect(p['02:00:00:00:00:02']).toBe('asw/ether7');
  });

  it('prefers an ARP sighting to an uplink, and a live sighting to a stale edge one', async () => {
    const p = await picks();
    expect(p['02:00:00:00:00:03']).toBe('rtr/vlan10');
    expect(p['02:00:00:00:00:04']).toBe('csw/Po6');
  });

  it('treats a port with managed neighbours as an uplink even where the topology left it unmatched', async () => {
    expect((await picks())['02:00:00:00:00:05']).toBe('asw/ether5');
  });

  it('ranks the bond on both ends as infrastructure', async () => {
    const rows = await db.query<{ device_id: number; interface_name: string; rank: number }>(
      `WITH ${INFRA_PORTS_CTE}
       SELECT c.device_id, c.interface_name, ${CLIENT_PORT_RANK} AS rank FROM clients c
        WHERE c.mac_address = '02:00:00:00:00:01'`,
    );
    const rank = (d: string, i: string) => rows.find((r) => r.device_id === id[d] && r.interface_name === i)?.rank;
    expect(rank('asw', 'ether5')).toBe(0);
    expect(rank('csw', 'Po6')).toBe(2);
    expect(rank('rtr', 'vlan10')).toBe(1);
  });

  it('goes up through the core, not the management router', async () => {
    const up = async (d: string) => (await db.query<{ to: number; via: string }>(
      `SELECT tl.to_device_id AS to, tl.from_interface AS via
         FROM topology_links tl JOIN devices d ON d.id = tl.from_device_id
        WHERE tl.from_device_id = $1 AND tl.to_device_id IS NOT NULL
        ORDER BY ${UPSTREAM_LINK_ORDER} LIMIT 1`, [id[d]]))[0];
    expect(await up('asw')).toEqual({ to: id.csw, via: 'bridge/Po1/sfp-sfpplus1' });
    // In-band management on the bridge: the bridge-port uplink still wins.
    expect(await up('inband')).toEqual({ to: id.csw, via: 'sfp-sfpplus1' });
    // Management address on a VLAN over the management port.
    expect(await up('vlanmgmt')).toEqual({ to: id.csw, via: 'sfp-sfpplus1' });
  });

  it('still takes the spanning-tree root port first', async () => {
    await db.query(`UPDATE topology_links SET stp_role = 'root' WHERE from_device_id = $1 AND from_interface = 'ether49'`, [id.asw]);
    const r = await db.query<{ via: string }>(
      `SELECT tl.from_interface AS via FROM topology_links tl JOIN devices d ON d.id = tl.from_device_id
        WHERE tl.from_device_id = $1 AND tl.to_device_id IS NOT NULL ORDER BY ${UPSTREAM_LINK_ORDER} LIMIT 1`, [id.asw]);
    expect(r[0].via).toBe('ether49');
    await db.query(`UPDATE topology_links SET stp_role = NULL WHERE from_device_id = $1`, [id.asw]);
  });
});
