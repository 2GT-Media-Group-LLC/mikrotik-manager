jest.mock('../../../config/database');
jest.mock('../../../config/redis', () => ({
  redis: { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) },
}));
jest.mock('../../../utils/crypto', () => ({ decrypt: () => 'pw' }));
jest.mock('../../mikrotik/RouterOSClient');

import { withSafeApply, probeCapability, GuardRequiredError, type GuardDevice } from '../ChangeGuard';
import { PartialApplyError, PartialApplyRevertError } from '../partialApply';
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
let deviceScripts: Record<string, string>[];
/** What the scheduler would run, captured for the script-mode tests. */
let lastOnEvent: string;
let rosVersion: string;

function installClientMock() {
  commands = [];
  applyDone = false;
  deviceSchedulers = [];
  deviceFiles = [];
  deviceScripts = [];
  lastOnEvent = '';
  rosVersion = '7.24.5 (stable)';
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
            lastOnEvent = params['on-event'];
            return [];
          case '/system/script/add':
            deviceScripts.push({ '.id': `*c${deviceScripts.length}`, name: params.name, source: params.source });
            return [];
          case '/system/script/remove':
            deviceScripts = deviceScripts.filter((x) => x['.id'] !== params['.id']);
            return [];
          case '/system/script/print': return deviceScripts;
          case '/system/resource/print': return [{ version: rosVersion }];
          case '/interface/bridge/port/print':
            return [{ '.id': '*1', interface: 'ether2', bridge: 'bridge', pvid: '10', dynamic: 'false' }];
          case '/interface/bridge/vlan/print':
            return [{ '.id': '*2', bridge: 'bridge', 'vlan-ids': '10', tagged: 'bridge', untagged: 'ether2', dynamic: 'false' }];
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

  it('arms a targeted restore in script mode: no backup, no export, restore steps in /system script', async () => {
    const out = await withSafeApply(device, { kind: 'port.vlan', summary: 's', mode: 'script' }, async () => {
      applyDone = true;
      return 'ok';
    });
    expect(commands).not.toContain('/system/backup/save');
    expect(commands).not.toContain('/export');
    expect(commands).toContain('/interface/bridge/port/print');
    expect(commands).toContain('/system/script/add');
    expect(lastOnEvent).toMatch(/^\/system scheduler remove \[find name="mtm-revert-/);
    expect(lastOnEvent).toContain('/system script run');
    expect(out.mode).toBe('script');
    // Confirmed, so the restore steps are cleaned up with the scheduler.
    expect(deviceScripts).toEqual([]);
    expect(deviceSchedulers).toEqual([]);
  });

  it('falls back to binary in script mode for a change it has no scope for, and says why', async () => {
    const out = await withSafeApply(device, { kind: 'command.bulk', summary: 's', mode: 'script' }, async () => 'ok');
    expect(commands).toContain('/system/backup/save');
    expect(commands).not.toContain('/system/script/add');
    expect(out.mode).toBe('binary');
    expect(out.modeNote).toMatch(/no targeted restore/);
  });

  it('falls back to binary in script mode on RouterOS 6', async () => {
    rosVersion = '6.49.10 (long-term)';
    const out = await withSafeApply(device, { kind: 'port.vlan', summary: 's', mode: 'script' }, async () => 'ok');
    expect(commands).toContain('/system/backup/save');
    expect(out.modeNote).toMatch(/RouterOS 7/);
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

describe('review fixes: revert/commit race and partial apply (H1, M1)', () => {
  const statuses = () => mockedQuery.mock.calls
    .filter(([sql]) => String(sql).includes('UPDATE device_change_guards'))
    .map(([, params]) => (params as unknown[])[1]);

  it('H1: a revert that already removed its scheduler is not committed over', async () => {
    const out = await withSafeApply(device, { kind: 'bond.delete', summary: 's', mode: 'script' }, async () => {
      applyDone = true;
      // What the on-event does first: remove its own scheduler, then restore.
      deviceSchedulers = [];
      return 'ok';
    });
    expect(out.confirmed).toBe(false);
    expect(out.autoReverting).toBe(true);
    expect(statuses()).toContain('uncertain');
    expect(statuses()).not.toContain('committed');
    // The restore steps may be mid-way: they must not be deleted.
    expect(deviceScripts.length).toBeGreaterThan(0);
  });

  it('H1: nothing is committed when apply + verify ran into the revert timer', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const out = await withSafeApply(device, { kind: 'test', summary: 's', timeoutSec: 120 }, async () => {
        applyDone = true;
        offset = 110_000; // 10 s before the revert fires
        return 'ok';
      });
      expect(out.confirmed).toBe(false);
      expect(out.autoReverting).toBe(true);
      expect(out.revertMayFireAt).toBeDefined();
      // Left armed, not disarmed.
      expect(deviceSchedulers).toHaveLength(1);
      expect(statuses()).not.toContain('committed');
    } finally {
      spy.mockRestore();
    }
  });

  it('M1: a writer that fails midway leaves the revert armed instead of keeping a half-applied config', async () => {
    let caught: unknown;
    try {
      await withSafeApply(device, { kind: 'bond.create', summary: 's' }, async () => {
        applyDone = true;
        throw new PartialApplyError('Bond bond1 was created, but adding it to bridge failed');
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PartialApplyRevertError);
    expect(deviceSchedulers).toHaveLength(1);
    expect(deviceFiles).toHaveLength(1);
    expect(statuses()).not.toContain('committed');
    expect(statuses()).not.toContain('failed');
  });

  it('H1: a removal that returns at the fire time is not trusted as a commit', async () => {
    const realNow = Date.now.bind(Date);
    // The clock jumps past the fire time while the scheduler is being removed.
    const spy = jest.spyOn(Date, 'now')
      .mockImplementation(() => realNow() + (commands.includes('/system/scheduler/remove') ? 200_000 : 0));
    try {
      const out = await withSafeApply(device, { kind: 'test', summary: 's', timeoutSec: 120 }, async () => {
        applyDone = true;
        return 'ok';
      });
      expect(out.revertMayFireAt).toBeDefined();
      expect(statuses()).toContain('uncertain');
      expect(statuses()).not.toContain('committed');
      // The restore point stays: the revert may have started.
      expect(deviceFiles).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('M1: a transport error marked as possibly partial (SSH import timeout) keeps the revert armed', async () => {
    const err = Object.assign(new Error('SSH timeout during restore'), { partialApply: true });
    let caught: unknown;
    try {
      await withSafeApply(device, { kind: 'backup.restore', summary: 's' }, async () => {
        applyDone = true;
        throw err;
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PartialApplyRevertError);
    expect(deviceSchedulers).toHaveLength(1);
  });

  it('M1: an ordinary failure on a reachable device still disarms', async () => {
    await expect(
      withSafeApply(device, { kind: 'bond.create', summary: 's' }, async () => {
        throw new Error('name already taken');
      })
    ).rejects.toThrow('name already taken');
    expect(deviceSchedulers).toHaveLength(0);
  });
});
