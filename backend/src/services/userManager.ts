/**
 * User Manager (#251): which devices run it, and a live read of one.
 *
 * Read live when the page asks rather than copied into the database: user
 * names, groups and RADIUS attributes stay on the device, and the page shows
 * what is true now. Only "does this device run User Manager" is stored, checked
 * once a day per device so the rest of the fleet costs nothing.
 */
import { query } from '../config/database';
import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import { RouterOSTrapError } from './mikrotik/RouterOSClient';
import {
  pickSettings, pickUsers, pickGroups, pickRouters, pickSessions, matchNasToDevices, SESSION_FIELDS,
} from '../utils/userManager';
import { canonicalIp } from './netflow/attribution';

export const USER_MANAGER_RECHECK_MS = 86_400_000;

/**
 * Is User Manager running on this device? True or false, or null when the
 * device couldn't be asked (a timeout says nothing).
 */
export async function probeUserManager(execute: (cmd: string) => Promise<Record<string, string>[]>): Promise<boolean | null> {
  try {
    const rows = await execute('/user-manager/print');
    return rows.some((r) => r['enabled'] === 'true' || r['enabled'] === 'yes');
  } catch (e) {
    // No such menu: the user-manager package isn't installed.
    return e instanceof RouterOSTrapError ? false : null;
  }
}

async function withCollector<T>(device: DeviceRow, fn: (c: DeviceCollector) => Promise<T>): Promise<T> {
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    return await fn(c);
  } finally {
    c.disconnect();
  }
}

export interface UserManagerView {
  settings: Record<string, string>;
  users: Record<string, string>[];
  groups: Record<string, string>[];
  routers: { row: Record<string, string>; managed_device: { id: number; name: string } | null }[];
  sessions: { active: Record<string, string>[]; recent: Record<string, string>[] };
}

/** Everything the page shows, read from the device now, secrets removed. */
export async function readUserManager(device: DeviceRow): Promise<UserManagerView> {
  const raw = await withCollector(device, async (c) => {
    const run = c.commandRunner();
    const [settings, users, groups, routers, sessions] = await Promise.all([
      run.execute('/user-manager/print'),
      run.execute('/user-manager/user/print', { detail: '' }),
      run.execute('/user-manager/user/group/print', { detail: '' }),
      run.execute('/user-manager/router/print', { detail: '' }),
      // Only the fields shown, so a long history stays small on the wire.
      run.execute('/user-manager/session/print', { '.proplist': SESSION_FIELDS.join(',') }, [], { timeoutMs: 30_000 }),
    ]);
    return { settings, users, groups, routers, sessions };
  });

  const managed = await query<{ id: number; name: string; ip_address: string; ip_addresses_jsonb: { address?: string }[] | null }>(
    `SELECT id, name, ip_address, ip_addresses_jsonb FROM devices`);
  const addresses = managed.map((d) => ({
    id: d.id,
    name: d.name.trim(),
    addresses: [d.ip_address, ...(d.ip_addresses_jsonb ?? []).map((a) => (a.address || '').split('/')[0])]
      .filter(Boolean).map((a) => canonicalIp(a)),
  }));
  const routers = pickRouters(raw.routers);
  const nas = matchNasToDevices(routers, addresses);
  return {
    settings: pickSettings(raw.settings[0]),
    users: pickUsers(raw.users),
    groups: pickGroups(raw.groups),
    routers: routers.map((r) => ({ row: r, managed_device: nas.get(r['.id']) ?? null })),
    sessions: pickSessions(raw.sessions),
  };
}

/**
 * Remove a session record: for one left open because the device never sent
 * its accounting stop, which can block a user limited to one session.
 */
export async function removeSession(device: DeviceRow, id: string): Promise<void> {
  await withCollector(device, async (c) => {
    await c.commandRunner().execute('/user-manager/session/remove', { numbers: id });
  });
}
