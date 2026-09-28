jest.mock('../../../config/database');
jest.mock('../../../config/redis', () => ({
  redis: { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) },
}));
jest.mock('../../../utils/crypto', () => ({ decrypt: () => 'pw' }));
jest.mock('../../mikrotik/RouterOSClient');

import { withSafeApply, probeCapability, GuardRequiredError, type GuardDevice } from '../ChangeGuard';
import { RouterOSClient } from '../../mikrotik/RouterOSClient';
import { query, queryOne } from '../../../config/database';
import { redis } from '../../../config/redis';

const mockedQuery = jest.mocked(query);
/** redis.set calls as plain values (its overloads defeat direct comparison). */
const setCalls = () => (jest.mocked(redis.set).mock.calls as unknown as unknown[][]);
const mockedQueryOne = jest.mocked(queryOne);
const MockedClient = jest.mocked(RouterOSClient);

const device: GuardDevice = {
  id: 1, name: 'sw1', ip_address: '10.0.0.1', api_port: 8728,
  api_username: 'admin', api_password_encrypted: 'enc',
};

/** Commands seen across every client instance, in order. */
let commands: string[];
/** When true, the *verification* clients fail to connect (device unreachable). */
let unreachableAfterApply: boolean;
let applyDone: boolean;
/** When true, /system/scheduler/print fails once the change is applied (a stalled read). */
let schedulerReadFailsAfterApply: boolean;
/** Simulated device state, so cleanup has something real to find and remove. */
let deviceSchedulers: Record<string, string>[];
let deviceFiles: Record<string, string>[];

function installClientMock() {
  commands = [];
  applyDone = false;
  deviceSchedulers = [];
  deviceFiles = [];
  MockedClient.mockImplementation(() => {
    const client = {
      connect: jest.fn(async () => {
        // Verification uses fresh clients created after the change is applied.
        if (applyDone && unreachableAfterApply) throw new Error('connect ETIMEDOUT');
      }),
      disconnect: jest.fn(),
      isConnected: jest.fn(() => true),
      execute: jest.fn(async (cmd: string, params: Record<string, string> = {}) => {
        commands.push(cmd);
        switch (cmd) {
          case '/system/backup/save':
            deviceFiles.push({ '.id': `*f${deviceFiles.length}`, name: `${params.name}.backup` });
            return [];
          case '/export':
            deviceFiles.push({ '.id': `*f${deviceFiles.length}`, name: `${params.file}.rsc` });
            return [];
          case '/system/scheduler/add':
            deviceSchedulers.push({ '.id': `*s${deviceSchedulers.length}`, name: params.name });
            return [];
          case '/system/scheduler/remove':
            deviceSchedulers = deviceSchedulers.filter((s) => s['.id'] !== params['.id']);
            return [];
          case '/file/remove':
            deviceFiles = deviceFiles.filter((f) => f['.id'] !== params['.id']);
            return [];
          case '/system/scheduler/print':
            if (applyDone && schedulerReadFailsAfterApply) throw new Error('Read timeout waiting for API response');
            return deviceSchedulers;
          case '/file/print': return deviceFiles;
          case '/system/identity/print': return [{ name: 'sw1' }];
          default: return [];
        }
      }),
    };
    return client as unknown as RouterOSClient;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  unreachableAfterApply = false;
  schedulerReadFailsAfterApply = false;
  installClientMock();
  // Settings lookup + any INSERT/UPDATE bookkeeping
  mockedQuery.mockResolvedValue([]);
  mockedQueryOne.mockResolvedValue({ id: 42 } as never);
  jest.mocked(redis.set).mockResolvedValue('OK' as never);
});

describe('withSafeApply', () => {
  it('arms a restore point and scheduler BEFORE running the change', async () => {
    const order: string[] = [];
    await withSafeApply(device, { kind: 'test', summary: 's' }, async () => {
      order.push(...commands, 'APPLY');
      return 'ok';
    });

    const armIdx = order.indexOf('/system/backup/save');
    const schedIdx = order.indexOf('/system/scheduler/add');
    const applyIdx = order.indexOf('APPLY');
    expect(armIdx).toBeGreaterThanOrEqual(0);
    // Restore point must exist before the scheduler, so a restore also clears it
    expect(armIdx).toBeLessThan(schedIdx);
    expect(schedIdx).toBeLessThan(applyIdx);
  });

  it('commits by disarming the scheduler when the device stays reachable', async () => {
    const out = await withSafeApply(device, { kind: 'test', summary: 's' }, async () => {
      applyDone = true;
      return 'ok';
    });

    expect(out.confirmed).toBe(true);
    expect(out.autoReverting).toBe(false);
    // Nothing left behind on the device: no armed revert, no restore-point file
    expect(deviceSchedulers).toHaveLength(0);
    expect(deviceFiles).toHaveLength(0);
  });

  it('leaves the scheduler ARMED when the device is unreachable after the change', async () => {
    unreachableAfterApply = true;
    const out = await withSafeApply(device, { kind: 'test', summary: 's' }, async () => {
      applyDone = true;
      return 'ok';
    });

    expect(out.confirmed).toBe(false);
    expect(out.autoReverting).toBe(true);
    // Critically: the revert must remain armed so the device can rescue itself
    expect(deviceSchedulers).toHaveLength(1);
    expect(deviceFiles).toHaveLength(1);
    // Generous budget: this exercises the real retry-with-backoff before giving up.
  }, 30_000);

  it('disarms and rethrows when the change itself fails, so the device is not rebooted for nothing', async () => {
    await expect(
      withSafeApply(device, { kind: 'test', summary: 's' }, async () => {
        throw new Error('bad command');
      })
    ).rejects.toThrow('bad command');
    expect(deviceSchedulers).toHaveLength(0);
  });

  /**
   * Observed on real hardware: deleting the management address applies on the device
   * and then times out, because the reply has to travel over the address that just
   * disappeared. Treating that throw as "the change failed" would disarm the guard on
   * a device that has already gone silent — stripping the safety net at the exact
   * moment it is needed — and would report a raw timeout instead of telling the user
   * the device is restoring itself.
   */
  it('treats a change that severs the connection as auto-reverting, not as a failure', async () => {
    unreachableAfterApply = true;

    const out = await withSafeApply(device, { kind: 'ip.remove', summary: 's' }, async () => {
      applyDone = true;
      throw new Error('Read timeout waiting for API response');
    });

    expect(out.autoReverting).toBe(true);
    expect(out.confirmed).toBe(false);
    // The safety net must survive: the device restores itself from these.
    expect(deviceSchedulers).toHaveLength(1);
    expect(deviceFiles).toHaveLength(1);
  }, 30_000);

  it('records a severed-connection guard as reverted, never as committed', async () => {
    unreachableAfterApply = true;
    await withSafeApply(device, { kind: 'ip.remove', summary: 's' }, async () => {
      applyDone = true;
      throw new Error('Read timeout waiting for API response');
    });

    const statuses = mockedQuery.mock.calls
      .filter(([sql]) => String(sql).includes('UPDATE device_change_guards'))
      .map(([, params]) => (params as unknown[])[1]);
    expect(statuses).toContain('reverted');
    expect(statuses).not.toContain('committed');
    expect(statuses).not.toContain('failed');
  }, 30_000);

  it('still applies the change when protection cannot be armed, and says so', async () => {
    MockedClient.mockImplementation(() => ({
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(),
      isConnected: jest.fn(() => true),
      execute: jest.fn(async (cmd: string) => {
        if (cmd === '/system/backup/save') throw new Error('no permission');
        return [];
      }),
    }) as unknown as RouterOSClient);

    let ran = false;
    const out = await withSafeApply(device, { kind: 'test', summary: 's' }, async () => { ran = true; return 'ok'; });

    expect(ran).toBe(true);
    expect(out.unprotectedReason).toMatch(/no permission/);
    expect(out.confirmed).toBe(false);
  });

  it('refuses to start a second protected change on the same device', async () => {
    jest.mocked(redis.set).mockResolvedValueOnce(null as never); // lock already held
    await expect(
      withSafeApply(device, { kind: 'test', summary: 's' }, async () => 'ok')
    ).rejects.toThrow(/already in progress/);
  });

  it('uses /export instead of a binary backup in script mode', async () => {
    await withSafeApply(device, { kind: 'test', summary: 's', mode: 'script' }, async () => {
      applyDone = true;
      return 'ok';
    });
    expect(commands).toContain('/export');
    expect(commands).not.toContain('/system/backup/save');
  });

  // ── Protection required (P1-12) ───────────────────────────────────────────

  it('refuses, without applying, a change that requires protection it cannot arm', async () => {
    MockedClient.mockImplementation(() => ({
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(),
      isConnected: jest.fn(() => true),
      execute: jest.fn(async (cmd: string) => {
        if (cmd === '/system/backup/save') throw new Error('not enough permissions');
        return [];
      }),
    }) as unknown as RouterOSClient);

    let ran = false;
    await expect(
      withSafeApply(device, { kind: 'test', summary: 's', requireProtection: true }, async () => { ran = true; return 'ok'; })
    ).rejects.toBeInstanceOf(GuardRequiredError);
    expect(ran).toBe(false);
  });

  it('refuses a change that requires protection when Change Guard is turned off', async () => {
    mockedQuery.mockResolvedValueOnce([{ key: 'change_guard_enabled', value: false }] as never);
    let ran = false;
    await expect(
      withSafeApply(device, { kind: 'test', summary: 's', requireProtection: true }, async () => { ran = true; return 'ok'; })
    ).rejects.toThrow(/turned off/);
    expect(ran).toBe(false);
  });

  // ── Disarm must be proven (P2-5, P2-6) ────────────────────────────────────

  it('does not record a commit when the scheduler cannot be read back after the change', async () => {
    schedulerReadFailsAfterApply = true;
    const out = await withSafeApply(device, { kind: 'test', summary: 's' }, async () => {
      applyDone = true;
      return 'ok';
    });

    expect(out.confirmed).toBe(true);
    expect(out.revertMayFireAt).toBeDefined();
    const statuses = mockedQuery.mock.calls
      .filter(([sql]) => String(sql).includes('UPDATE device_change_guards'))
      .map(([, params]) => (params as unknown[])[1]);
    expect(statuses).toContain('uncertain');
    expect(statuses).not.toContain('committed');
    // The restore point stays, so a revert that fires still has something to load.
    expect(deviceFiles).toHaveLength(1);
    // And the device stays locked until the revert would have fired.
    expect(redis.del).not.toHaveBeenCalled();
    const holds = setCalls().filter((c) => c[2] === 'EX' && c[4] !== 'NX');
    expect(holds.length).toBeGreaterThan(0);
  }, 30_000);

  it('keeps the device locked while a left-armed revert is still due', async () => {
    unreachableAfterApply = true;
    await withSafeApply(device, { kind: 'test', summary: 's' }, async () => {
      applyDone = true;
      return 'ok';
    });
    expect(redis.del).not.toHaveBeenCalled();
    const hold = setCalls().find((c) => c[4] !== 'NX');
    expect(Number(hold?.[3])).toBeGreaterThan(120);
  }, 30_000);

  it('releases the lock after a clean commit', async () => {
    await withSafeApply(device, { kind: 'test', summary: 's' }, async () => { applyDone = true; return 'ok'; });
    expect(redis.del).toHaveBeenCalled();
  });
});

describe('probeCapability', () => {
  it('reports a device that cannot save a restore point', async () => {
    MockedClient.mockImplementation(() => ({
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(),
      isConnected: jest.fn(() => true),
      execute: jest.fn(async (cmd: string) => {
        if (cmd === '/system/backup/save') throw new Error('not enough permissions (9)');
        return [];
      }),
    }) as unknown as RouterOSClient);
    const r = await probeCapability(device);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/restore point/);
  });

  it('passes, and leaves nothing behind, on a capable device', async () => {
    const r = await probeCapability(device);
    expect(r.ok).toBe(true);
    expect(deviceSchedulers).toHaveLength(0);
    expect(deviceFiles).toHaveLength(0);
  });
});
