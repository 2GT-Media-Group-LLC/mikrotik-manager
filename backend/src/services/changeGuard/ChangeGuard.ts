/**
 * Change Guard — a device-side dead-man switch for risky configuration changes.
 *
 * A user change can sever the manager's own path to a device (deleting a bond that
 * carried the uplink, enabling vlan-filtering, dropping the management IP...). No
 * static analysis catches every case, so before applying such a change we make the
 * device able to rescue itself:
 *
 *   1. save a restore point ON the device
 *   2. arm a scheduler that restores it after N seconds
 *   3. apply the change
 *   4. prove we can still reach the device on a NEW connection
 *   5. commit  -> disarm the scheduler and delete the restore point
 *      abandon -> do nothing; the device restores itself and comes back
 *
 * The restore point is created *before* the scheduler, so a binary restore rolls
 * back to a config containing neither the scheduler nor the change: self-cleaning,
 * with no possibility of a revert loop. (Script mode has no reboot to clear the
 * scheduler, so its on-event removes itself explicitly.)
 *
 * Everything here runs over the RouterOS API — no SSH — because many deployments
 * never configure SSH credentials and would otherwise have no protection at all.
 */
import { randomBytes } from 'crypto';
import { RouterOSClient } from '../mikrotik/RouterOSClient';
import { decrypt } from '../../utils/crypto';
import { query, queryOne } from '../../config/database';
import { redis } from '../../config/redis';

export type GuardMode = 'binary' | 'script';

export interface GuardDevice {
  id: number;
  name: string;
  ip_address: string;
  api_port: number;
  api_username: string;
  api_password_encrypted: string;
}

export interface ChangeMeta {
  /** Stable identifier for the kind of change, e.g. 'bond.delete'. */
  kind: string;
  /** Human-readable one-liner shown in the UI and stored for correlation. */
  summary: string;
  userId?: number | null;
  mode?: GuardMode;
  timeoutSec?: number;
}

export interface GuardOutcome<T> {
  result: T;
  /** True when the change was applied and the device confirmed reachable. */
  confirmed: boolean;
  /** True when we could not confirm reachability and left the device to self-revert. */
  autoReverting: boolean;
  /** Set when protection could not be armed; the change ran unprotected. */
  unprotectedReason?: string;
  guardId?: number;
}

const DEFAULT_TIMEOUT_SEC = 120;
const VERIFY_ATTEMPTS = 4;
const VERIFY_CONNECT_TIMEOUT_MS = 8_000;
const LOCK_TTL_SEC = 600;

function token(): string {
  return randomBytes(5).toString('hex');
}

function newClient(device: GuardDevice, connectTimeoutMs = 15_000): RouterOSClient {
  return new RouterOSClient(
    device.ip_address,
    device.api_port,
    device.api_username,
    decrypt(device.api_password_encrypted),
    connectTimeoutMs,
    30_000
  );
}

/** Settings are read per call so an operator can change them without a restart. */
async function readSettings(): Promise<{ enabled: boolean; mode: GuardMode; timeoutSec: number }> {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings
     WHERE key IN ('change_guard_enabled', 'change_guard_mode', 'change_guard_timeout_sec')`
  ).catch(() => []);
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  const mode = map['change_guard_mode'] === 'script' ? 'script' : 'binary';
  const timeoutSec = Number(map['change_guard_timeout_sec']) || DEFAULT_TIMEOUT_SEC;
  return { enabled: map['change_guard_enabled'] !== false, mode, timeoutSec };
}

/**
 * Can this device protect itself? Requires the API user to be able to write a
 * restore point and add/remove a scheduler. Probes with a harmless scheduler
 * (logs a line, fires in a day) that is removed immediately.
 */
export async function probeCapability(device: GuardDevice): Promise<{ ok: boolean; reason?: string }> {
  const client = newClient(device);
  const probeName = `mtm-probe-${token()}`;
  try {
    await client.connect();
    await client.execute('/system/scheduler/add', {
      name: probeName,
      interval: '1d',
      'on-event': ':log info "mtm-guard-probe"',
    });
    const found = (await client.execute('/system/scheduler/print')).find((s) => s['name'] === probeName);
    if (!found?.['.id']) return { ok: false, reason: 'could not create a scheduler on the device' };
    await client.execute('/system/scheduler/remove', { '.id': found['.id'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    client.disconnect();
  }
}

/** Prove reachability on a brand-new connection, retried across the window. */
async function verifyReachable(device: GuardDevice, attempts = VERIFY_ATTEMPTS): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const client = newClient(device, VERIFY_CONNECT_TIMEOUT_MS);
    try {
      await client.connect();
      const rows = await client.execute('/system/identity/print');
      if (rows.length > 0) return true;
    } catch {
      /* fall through to retry */
    } finally {
      client.disconnect();
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

async function acquireLock(deviceId: number): Promise<boolean> {
  try {
    const res = await redis.set(`changeguard:lock:${deviceId}`, '1', 'EX', LOCK_TTL_SEC, 'NX');
    return res === 'OK';
  } catch {
    return true; // Redis unavailable — don't block legitimate changes
  }
}

async function releaseLock(deviceId: number): Promise<void> {
  await redis.del(`changeguard:lock:${deviceId}`).catch(() => {});
}

async function recordGuard(
  device: GuardDevice, meta: ChangeMeta, mode: GuardMode, restorePoint: string,
  schedulerName: string, timeoutSec: number
): Promise<number | undefined> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO device_change_guards
       (device_id, token, mode, restore_point, scheduler_name, status, change_kind,
        change_summary, user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8, NOW() + ($9 || ' seconds')::interval)
     RETURNING id`,
    [device.id, schedulerName, mode, restorePoint, schedulerName, meta.kind,
     meta.summary, meta.userId ?? null, String(timeoutSec)]
  ).catch(() => null);
  return row?.id;
}

async function setGuardStatus(id: number | undefined, status: string, note?: string): Promise<void> {
  if (!id) return;
  // Casts are required: an untyped NULL in COALESCE makes Postgres fail to infer
  // the parameter type. Failures are logged, never swallowed — a guard row stuck
  // at 'pending' would later be misread as an unfinished change.
  await query(
    `UPDATE device_change_guards
     SET status = $2::varchar,
         note = COALESCE($3::text, note),
         committed_at = CASE WHEN $2::varchar <> 'pending' THEN NOW() ELSE committed_at END
     WHERE id = $1`,
    [id, status, note ?? null]
  ).catch((e) => {
    console.error(`[ChangeGuard] Failed to record guard ${id} as '${status}':`, (e as Error).message);
  });
}

/**
 * Run `applyFn` with a self-restore safety net armed on the device.
 *
 * If protection can't be armed the change still runs (refusing would make the
 * platform less useful than before), but the caller is told via
 * `unprotectedReason` so the UI can say so plainly.
 */
export async function withSafeApply<T>(
  device: GuardDevice,
  meta: ChangeMeta,
  applyFn: () => Promise<T>
): Promise<GuardOutcome<T>> {
  const settings = await readSettings();
  const mode: GuardMode = meta.mode ?? settings.mode;
  const timeoutSec = meta.timeoutSec ?? settings.timeoutSec;

  if (!settings.enabled) {
    return { result: await applyFn(), confirmed: false, autoReverting: false, unprotectedReason: 'Change Guard is disabled in settings' };
  }
  if (!(await acquireLock(device.id))) {
    throw new Error('Another protected change is already in progress on this device. Please wait for it to finish.');
  }

  const id = token();
  const restorePoint = `mtm-rp-${id}`;
  const schedulerName = `mtm-revert-${id}`;
  const client = newClient(device);
  let armed = false;
  let guardId: number | undefined;

  try {
    // ── Arm ────────────────────────────────────────────────────────────────
    try {
      await client.connect();
      if (mode === 'binary') {
        await client.execute('/system/backup/save', { name: restorePoint });
      } else {
        await client.execute('/export', { file: restorePoint });
      }

      const onEvent = mode === 'binary'
        // Restores exactly (recovers deleted interfaces) and reboots. The restored
        // config predates this scheduler, so it disappears with the restore.
        ? `/system backup load name=${restorePoint} password=""`
        // No reboot, but /import is additive, so the scheduler must remove itself.
        : `/import file-name=${restorePoint}.rsc\n/system scheduler remove [find name="${schedulerName}"]`;

      await client.execute('/system/scheduler/add', {
        name: schedulerName,
        interval: `${timeoutSec}s`,
        'on-event': onEvent,
      });
      armed = true;
      guardId = await recordGuard(device, meta, mode, restorePoint, schedulerName, timeoutSec);
    } catch (err) {
      // Couldn't arm — clean up any half-created artifacts and run unprotected.
      await cleanup(client, restorePoint, schedulerName, mode).catch(() => {});
      const result = await applyFn();
      return {
        result, confirmed: false, autoReverting: false,
        unprotectedReason: `Could not arm auto-revert on this device (${(err as Error).message})`,
      };
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    let result: T;
    try {
      result = await applyFn();
    } catch (err) {
      // The change itself failed. Disarm so the device isn't rebooted for nothing.
      await cleanup(client, restorePoint, schedulerName, mode).catch(() => {});
      await setGuardStatus(guardId, 'failed', (err as Error).message);
      armed = false;
      throw err;
    }

    // ── Verify ─────────────────────────────────────────────────────────────
    const reachable = await verifyReachable(device);
    if (!reachable) {
      // Leave the scheduler armed: the device will restore itself and come back.
      await setGuardStatus(guardId, 'reverted', 'Device unreachable after change; left to self-restore');
      armed = false; // deliberately not cleaned up
      return { result, confirmed: false, autoReverting: true, guardId };
    }

    // ── Commit ─────────────────────────────────────────────────────────────
    await cleanup(client, restorePoint, schedulerName, mode);
    armed = false;
    await setGuardStatus(guardId, 'committed');
    return { result, confirmed: true, autoReverting: false, guardId };
  } finally {
    if (armed) await setGuardStatus(guardId, 'pending');
    client.disconnect();
    await releaseLock(device.id);
  }
}

/** Disarm: remove the scheduler, then the restore point. Uses a fresh connection if needed. */
async function cleanup(
  client: RouterOSClient, restorePoint: string, schedulerName: string, mode: GuardMode
): Promise<void> {
  if (!client.isConnected()) await client.connect();
  const scheds = await client.execute('/system/scheduler/print').catch(() => []);
  for (const s of scheds) {
    if (s['name'] === schedulerName && s['.id']) {
      await client.execute('/system/scheduler/remove', { '.id': s['.id'] });
    }
  }
  const wanted = mode === 'binary' ? `${restorePoint}.backup` : `${restorePoint}.rsc`;
  const files = await client.execute('/file/print').catch(() => []);
  for (const f of files) {
    if ((f['name'] === wanted || f['name'] === restorePoint) && f['.id']) {
      await client.execute('/file/remove', { '.id': f['.id'] }).catch(() => {});
    }
  }
}

/**
 * Startup reconciliation: guards still 'pending' after their window elapsed belong
 * to a manager that crashed mid-change. The device has since restored itself.
 */
export async function reconcileStaleGuards(): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE device_change_guards
     SET status = 'reverted', committed_at = NOW(),
         note = COALESCE(note, 'Manager restarted before commit; device self-restored')
     WHERE status = 'pending' AND expires_at < NOW()
     RETURNING id`
  ).catch(() => []);
  if (rows.length > 0) {
    console.log(`[ChangeGuard] Reconciled ${rows.length} stale guard(s) left pending by a restart`);
  }
  return rows.length;
}
