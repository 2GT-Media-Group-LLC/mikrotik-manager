jest.mock('../../config/database');
jest.mock('../../middleware/site', () => ({ activeSite: () => null }));
jest.mock('../../middleware/auth', () => ({
  requireWrite: (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.user?.role === 'viewer' ? res.status(403).json({ error: 'viewer' }) : next()),
}));

const live = {
  packages: [] as Record<string, string>[], entries: [] as Record<string, string>[], cache: [] as Record<string, string>[],
  devices: [] as Record<string, string>[], settings: { 'cache-directory': 'NetinstallCache/' } as Record<string, string>,
  files: [{ name: 'flash', type: 'disk' }] as Record<string, string>[], disks: [] as Record<string, string>[],
  resource: {} as Record<string, string>, interfaces: [{ name: 'ether1' }, { name: 'bridge' }] as Record<string, string>[],
};
const collector = {
  connect: jest.fn(), disconnect: jest.fn(),
  getNetinstall: jest.fn(async () => live),
  addNetinstallEntry: jest.fn(), setNetinstallEntry: jest.fn(), removeNetinstallEntry: jest.fn(),
  addNetinstallCache: jest.fn(), removeNetinstallCache: jest.fn(), setNetinstallCacheDirectory: jest.fn(),
  startNetinstall: jest.fn(), clearNetinstallDevices: jest.fn(), changePackage: jest.fn(),
  getUpdateVersions: jest.fn(async () => ({ 'installed-version': '7.25', 'latest-version': '7.25' }) as Record<string, string>),
};
jest.mock('../../services/mikrotik/DeviceCollector', () => ({ DeviceCollector: jest.fn(() => collector) }));
const guarded = jest.fn();
jest.mock('../../services/changeGuard/guardedRoute', () => ({
  withGuardedChange: async (_id: number, _req: unknown, res: { json: (b: unknown) => void }, meta: unknown, fn: (c: unknown) => Promise<unknown>) => {
    guarded(meta);
    res.json(await fn(collector));
  },
}));

import request from 'supertest';
import express from 'express';
import netinstallRoutes from '../netinstall';
import { query, queryOne } from '../../config/database';

const MiB = 1024 * 1024;
const app = (role = 'operator') => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = { userId: 1, username: 'u', role } as never; next(); });
  a.use('/', netinstallRoutes);
  return a;
};

const installed = { '.id': '*7', name: 'netinstall', version: '7.25', available: 'false', disabled: 'false', size: '73873', scheduled: '' };
const available = { ...installed, version: '', available: 'true', disabled: 'true' };
const routeros = { '.id': '*1', name: 'routeros', version: '7.25', available: 'false', disabled: 'false', size: String(12 * MiB), scheduled: '' };
const resource = { version: '7.25 (stable)', 'architecture-name': 'arm', 'free-hdd-space': String(3 * MiB), 'total-hdd-space': String(16 * MiB),
  'free-memory': String(450 * MiB), 'total-memory': String(512 * MiB) };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(queryOne).mockResolvedValue({ id: 8, name: 'TEST', status: 'online', ros_version: '7.25', architecture: 'arm' } as never);
  jest.mocked(query).mockResolvedValue([] as never);
  Object.assign(live, { packages: [routeros, installed], entries: [], cache: [], devices: [], resource, files: [{ name: 'flash', type: 'disk' }] });
});

describe('GET /', () => {
  it('lists every device with what it can do', async () => {
    jest.mocked(query).mockResolvedValueOnce([
      { id: 1, name: 'a', ros_version: '7.25', architecture: 'arm', installed_packages: ['routeros', 'netinstall'] },
      { id: 2, name: 'b', ros_version: '7.20', architecture: 'arm', installed_packages: ['routeros'] },
    ] as never);
    const res = await request(app()).get('/');
    expect(res.body.devices.map((d: { support: string }) => d.support)).toEqual(['installed', 'too-old']);
    expect(res.body.devices[0].installed_packages).toBeUndefined();
  });
});

describe('GET /device', () => {
  it('reads the device live and flags open entries and managed targets', async () => {
    live.entries = [{ '.id': '*1', interface: 'ether1', wait: 'false', disabled: 'false', 'allow-etherboot': 'true' }];
    live.devices = [{ '.id': '*2', 'mac-address': '02:23:45:67:89:bb', state: 'waiting' }];
    jest.mocked(query).mockResolvedValueOnce([{ mac: '02:23:45:67:89:BB', id: 1, name: '2GT-NW-100G' }] as never);
    const res = await request(app()).get('/device?deviceId=8');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ support: 'installed', storage: { kind: 'ram' }, space_problem: null, interfaces: ['ether1', 'bridge'] });
    expect(res.body.entries[0].open).toBe(true);
    expect(res.body.devices[0].managed).toEqual({ id: 1, name: '2GT-NW-100G' });
  });
});

describe('POST /package', () => {
  it('needs confirming, and refuses when other package changes wait', async () => {
    live.packages = [routeros, available];
    expect((await request(app()).post('/package?deviceId=8').send({ action: 'install' })).status).toBe(400);
    live.packages = [routeros, available, { '.id': '*9', name: 'container', scheduled: 'scheduled for install', available: 'true', disabled: 'true' }];
    const res = await request(app()).post('/package?deviceId=8').send({ action: 'install', confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/container/);
    expect(collector.changePackage).not.toHaveBeenCalled();
  });

  it('installs it, and refuses on a device too old to have it', async () => {
    live.packages = [routeros, available];
    const res = await request(app()).post('/package?deviceId=8').send({ action: 'install', confirm: true });
    expect(res.body.started).toBe(true);
    expect(collector.changePackage).toHaveBeenCalledWith('*7', true);
    live.packages = [routeros];
    expect((await request(app()).post('/package?deviceId=8').send({ action: 'install', confirm: true })).status).toBe(409);
  });

  it('asks first when RouterOS may upgrade itself along with it', async () => {
    live.packages = [routeros, available];
    collector.getUpdateVersions.mockResolvedValueOnce({ 'installed-version': '7.25', 'latest-version': '7.25.1' });
    const res = await request(app()).post('/package?deviceId=8').send({ action: 'install', confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.upgrade_to).toBe('7.25.1');
    expect(collector.changePackage).not.toHaveBeenCalled();
    collector.getUpdateVersions.mockResolvedValueOnce({ 'installed-version': '7.25', 'latest-version': '7.25.1' });
    const ok = await request(app()).post('/package?deviceId=8').send({ action: 'install', confirm: true, allow_upgrade: true });
    expect(ok.body.started).toBe(true);
  });

  it('is refused to a viewer', async () => {
    expect((await request(app('viewer')).post('/package?deviceId=8').send({ action: 'install', confirm: true })).status).toBe(403);
  });
});

describe('server entries', () => {
  it('refuses an entry that would install any device, before touching the device', async () => {
    const res = await request(app()).post('/entry?deviceId=8').send({ interface: 'ether1' });
    expect(res.status).toBe(400);
    expect(res.body.errors['mac-address']).toMatch(/any device/);
    expect(guarded).not.toHaveBeenCalled();
  });

  it('adds a safe one under Change Guard', async () => {
    const res = await request(app()).post('/entry?deviceId=8').send({ interface: 'ether1', 'mac-address': '02:00:00:00:00:01' });
    expect(res.status).toBe(200);
    expect(guarded).toHaveBeenCalledWith(expect.objectContaining({ kind: 'netinstall.add' }));
    expect(collector.addNetinstallEntry).toHaveBeenCalledWith({ interface: 'ether1', 'mac-address': '02:00:00:00:00:01', 'allow-flashfig': 'no' });
  });

  it('won\'t fill flash with an install\'s downloads', async () => {
    live.files = [];
    const res = await request(app()).post('/entry?deviceId=8').send({ interface: 'ether1', wait: true });
    expect(res.status).toBe(400);
    expect(res.body.errors.storage).toMatch(/in flash/);
    expect(collector.addNetinstallEntry).not.toHaveBeenCalled();
  });

  it('needs the package', async () => {
    live.packages = [routeros, available];
    expect((await request(app()).post('/entry?deviceId=8').send({ interface: 'ether1', wait: true })).status).toBe(409);
  });
});

describe('installs', () => {
  it('starts only with the MAC typed back', async () => {
    live.devices = [{ '.id': '*3', 'mac-address': '02:23:45:67:89:BB', arch: 'arm', state: 'waiting' }];
    const no = await request(app()).post('/devices/install?deviceId=8').send({ mac: '02:23:45:67:89:BB' });
    expect(no.status).toBe(400);
    // A device no longer in the list isn't installed, whatever row now has its old id.
    const gone = await request(app()).post('/devices/install?deviceId=8').send({ mac: '02:00:00:00:00:09', confirm_mac: '02:00:00:00:00:09' });
    expect(gone.body.errors.device).toBeDefined();
    expect(collector.startNetinstall).not.toHaveBeenCalled();
    const yes = await request(app()).post('/devices/install?deviceId=8').send({ mac: '02:23:45:67:89:BB', confirm_mac: '02:23:45:67:89:bb', 'auto-reboot': 'reboot' });
    expect(yes.status).toBe(200);
    expect(collector.startNetinstall).toHaveBeenCalledWith({ numbers: '*3', 'auto-reboot': 'reboot' });
  });
});

describe('cache', () => {
  it('checks the architecture and packages', async () => {
    const res = await request(app()).post('/cache?deviceId=8').send({ arch: 'sparc', packages: 'notapkg' });
    expect(Object.keys(res.body.errors).sort()).toEqual(['arch', 'packages']);
    await request(app()).post('/cache?deviceId=8').send({ arch: 'arm64', version: '7.25', packages: 'wifi-qcom' });
    expect(collector.addNetinstallCache).toHaveBeenCalledWith({ arch: 'arm64', version: '7.25', packages: 'wifi-qcom' });
  });

  it('removes a cache file by its path, not its position', async () => {
    live.cache = [{ '.id': '*0', path: 'NetinstallCache/linux.arm64-uefi', status: 'downloaded' }];
    expect((await request(app()).delete('/cache?deviceId=8&path=NetinstallCache/linux.arm64')).status).toBe(404);
    await request(app()).delete('/cache?deviceId=8&path=NetinstallCache/linux.arm64-uefi');
    expect(collector.removeNetinstallCache).toHaveBeenCalledWith('*0');
  });

  it('keeps the cache folder on the device', async () => {
    const res = await request(app()).put('/settings?deviceId=8').send({ cache_directory: 'usb9/x' });
    expect(res.body.errors.cache_directory).toMatch(/usb9/);
    await request(app()).put('/settings?deviceId=8').send({ cache_directory: 'NetinstallCache' });
    expect(collector.setNetinstallCacheDirectory).toHaveBeenCalledWith('NetinstallCache/');
  });
});
