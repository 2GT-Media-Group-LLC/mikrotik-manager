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

export interface UndoProbeResult {
  /** True only when an undo was performed and verified to have taken effect. */
  ok: boolean;
  /** `/system/history/print` is reachable over the binary API. */
  historyReadable: boolean;
  /** The device marked the probe action as undoable. */
  actionUndoable: boolean;
  /** Entries currently in the history buffer (RouterOS caps this at 100). */
  historyDepth: number;
  /** RouterOS version, since history/undo support varies across releases. */
  rosVersion: string | null;
  /** What each candidate undo command did, so a failure says which forms were tried. */
  attempts: { command: string; error: string }[];
  reason?: string;
}

/**
 * In the CLI, `undo` is a global command used after `/system history print` rather
 * than a child of that path, and releases differ on whether it can be pointed at a
 * specific entry or only steps back from the most recent one. Rather than betting on
 * one spelling, the probe tries each form and reports what every one of them did.
 *
 * `targeted: false` means the command takes no entry id and simply undoes the newest
 * undoable action on the device — which is only safe when we know the newest action
 * is ours.
 */
const UNDO_COMMANDS: { command: string; targeted: boolean }[] = [
  { command: '/system/history/undo', targeted: true },
  { command: '/undo', targeted: true },
  { command: '/undo', targeted: false },
  { command: '/system/history/unset', targeted: true },
];

/**
 * Can this device revert a change through `/system history` instead of a binary
 * restore?
 *
 * A binary restore reboots. `/system history` records every action with its exact
 * inverse, so undoing would be surgical and take no outage at all — but MikroTik
 * documents the history/undo pair for the CLI, not the binary API, and the buffer
 * is capped at 100 actions. Whether it works at all is an empirical question, so
 * this answers it on the real device rather than assuming either way.
 *
 * The probe is non-destructive: it adds the same harmless scheduler `probeCapability`
 * uses, undoes that one action, and confirms the scheduler is gone. If the undo does
 * not work the scheduler is removed directly, so the device is unchanged either way.
 *
 * Measured on RouterOS 7.23.1 and 7.23.3 (CRS switches, binary API):
 *   `/system/history/print`      works
 *   `/system/history/undo`       "no such command"
 *   `/undo numbers=<id>`         "unknown parameter numbers"
 *   `/undo`                      works — reverts the newest undoable action, no reboot
 *
 * So undo is real over the API but **untargeted**, and it cannot replace the
 * scheduler-based auto-revert: the dead-man switch has to fire when the manager has
 * *lost* contact, and issuing an undo requires the contact we just lost. Its value is
 * as an operator-driven rollback while the device is still reachable, and only when
 * our action is verifiably the newest entry — which is why the untargeted form is
 * guarded by that check below.
 */
export async function probeUndoCapability(device: GuardDevice): Promise<UndoProbeResult> {
  const client = newClient(device);
  const probeName = `mtm-undo-probe-${token()}`;
  const attempts: { command: string; error: string }[] = [];
  const fail = (over: Partial<UndoProbeResult>): UndoProbeResult => ({
    ok: false, historyReadable: false, actionUndoable: false, historyDepth: 0,
    rosVersion: null, attempts, ...over,
  });

  let rosVersion: string | null = null;
  let created = false;

  try {
    await client.connect();

    rosVersion = (await client.execute('/system/resource/print').catch(() => []))[0]?.['version'] ?? null;

    let before: Record<string, string>[];
    try {
      before = await client.execute('/system/history/print');
    } catch (err) {
      return fail({ rosVersion, reason: `/system/history/print is not available: ${(err as Error).message}` });
    }
    const beforeIds = new Set(before.map((h) => h['.id']).filter(Boolean));

    await client.execute('/system/scheduler/add', {
      name: probeName,
      interval: '1d',
      'on-event': ':log info "mtm-undo-probe"',
    });
    created = true;

    const after = await client.execute('/system/history/print');
    const entry = after.find((h) => h['.id'] && !beforeIds.has(h['.id']));
    const base = {
      historyReadable: true,
      historyDepth: after.length,
      rosVersion,
    };

    if (!entry) {
      return fail({ ...base, reason: 'the scheduler was created but no matching history entry appeared' });
    }
    const actionUndoable = entry['undoable'] !== 'false';
    if (!actionUndoable) {
      return fail({ ...base, reason: 'the device recorded the action as not undoable' });
    }

    for (const { command, targeted } of UNDO_COMMANDS) {
      const label = targeted ? `${command} numbers=<id>` : command;
      // An untargeted undo steps back from whatever is newest on the device, so only
      // try it while our own action is still the most recent entry.
      if (!targeted) {
        const newest = (await client.execute('/system/history/print').catch(() => []))[0];
        if (newest?.['.id'] !== entry['.id']) {
          attempts.push({ command: label, error: 'skipped — our action is no longer the newest history entry' });
          continue;
        }
      }
      try {
        await client.execute(command, targeted ? { numbers: entry['.id'] } : {});
      } catch (err) {
        attempts.push({ command: label, error: (err as Error).message });
        continue;
      }

      // Only the observable result counts: a command that returns without error but
      // leaves the scheduler in place is not an undo we can build a revert mode on.
      const stillThere = (await client.execute('/system/scheduler/print'))
        .some((s) => s['name'] === probeName);
      if (stillThere) {
        attempts.push({ command: label, error: 'accepted, but the change was still applied' });
        continue;
      }

      created = false;
      return { ok: true, ...base, actionUndoable, attempts };
    }

    return fail({
      ...base,
      actionUndoable,
      reason: `no undo command worked — ${attempts.map((a) => `${a.command}: ${a.error}`).join('; ')}`,
    });
  } catch (err) {
    return fail({ rosVersion, reason: (err as Error).message });
  } finally {
    // Never leave the probe behind, whatever went wrong above.
    if (created) {
      const leftover = (await client.execute('/system/scheduler/print').catch(() => []))
        .find((s) => s['name'] === probeName);
      if (leftover?.['.id']) {
        await client.execute('/system/scheduler/remove', { '.id': leftover['.id'] }).catch(() => {});
      }
    }
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
         -- Only a genuine commit is a commit. Stamping this on 'failed' or
         -- 'reverted' made the ledger read as though the change had been kept.
         committed_at = CASE WHEN $2::varchar = 'committed' THEN NOW() ELSE committed_at END,
         resolved_at = CASE WHEN $2::varchar <> 'pending' THEN NOW() ELSE resolved_at END
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
    //
    // A thrown error here does NOT mean the change failed. The most dangerous
    // changes sever the very connection carrying them: deleting the management
    // address makes `/ip/address/remove` succeed on the device and then time out
    // waiting for a reply we can never receive. Proven on hardware — the switch
    // locked itself out, self-restored and came back, while the API reported only
    // "Read timeout waiting for API response".
    //
    // So reachability, not the exception, decides what happened. Disarming here on
    // the assumption of failure would be the worst possible move: it would strip the
    // safety net off a device that has just gone silent.
    let result: T | undefined;
    let applyError: unknown;
    try {
      result = await applyFn();
    } catch (err) {
      applyError = err;
    }

    // ── Verify ─────────────────────────────────────────────────────────────
    const reachable = await verifyReachable(device);
    if (!reachable) {
      // Leave the scheduler armed: the device will restore itself and come back.
      const note = applyError
        ? `Contact lost while applying (${(applyError as Error).message}); left to self-restore`
        : 'Device unreachable after change; left to self-restore';
      await setGuardStatus(guardId, 'reverted', note);
      armed = false; // deliberately not cleaned up
      // `result` is undefined when the change took the connection with it. The
      // caller only reports the outcome in that case, so the guard fields carry the
      // meaning rather than the result.
      return { result: result as T, confirmed: false, autoReverting: true, guardId };
    }

    if (applyError) {
      // Still reachable, so the change genuinely failed and nothing needs undoing.
      // Disarm, or the device would reboot for no reason.
      await cleanup(client, restorePoint, schedulerName, mode).catch(() => {});
      await setGuardStatus(guardId, 'failed', (applyError as Error).message);
      armed = false;
      throw applyError;
    }

    // ── Commit ─────────────────────────────────────────────────────────────
    await cleanup(client, restorePoint, schedulerName, mode);
    armed = false;
    await setGuardStatus(guardId, 'committed');
    // Reaching here means applyFn returned normally, so `result` is assigned; the
    // optional type only exists for the severed-connection path above.
    return { result: result as T, confirmed: true, autoReverting: false, guardId };
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
