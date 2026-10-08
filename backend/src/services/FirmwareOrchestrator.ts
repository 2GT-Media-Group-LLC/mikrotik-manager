// Staged firmware rollout orchestrator.
//
// Executes a rollout wave-by-wave (wave 1 = canary). Devices within a wave run
// sequentially by default, or up to wave_concurrency at once (#135):
//   pre-upgrade backup → install RouterOS update → wait through the reboot →
//   verify it came back healthy on the new version → next device.
// A failure marks the device failed and (with halt_on_failure) stops the whole
// rollout so a bad build never reaches the rest of the fleet. One rollout runs
// at a time; a lightweight scheduler starts rollouts whose scheduled_at has
// arrived (pair with a maintenance window by scheduling inside it).

import { query, queryOne } from '../config/database';
import { DeviceCollector, DeviceRow } from './mikrotik/DeviceCollector';
import { BackupService } from './BackupService';
import { mapWithConcurrency, clampConcurrency } from '../utils/concurrency';
import { interruptedOutcome, INTERRUPTED_RUN_ERROR } from '../utils/interrupted';
import { describeUpdateStatus, type UpdateStatus } from '../utils/updateStatus';
import { upgradeDecision, verifyUpgrade, scheduleDecision } from '../utils/firmwarePlan';
import { mirrorForDevice, newestCompleteVersion, type MirrorRow } from './firmwareMirror';
import { matchLocalUpdate, packageFileName } from '../utils/firmwareMirror';
import { runSshCommand, looksLikeFailure, type SshExecDevice } from './sshExec';
import { withSafeApply, type GuardDevice } from './changeGuard/ChangeGuard';

const REBOOT_GRACE_MS = 25_000;      // let the device actually go down
/**
 * Defaults only. Both are settings now — see readTimeouts().
 *
 * A user with CRS switches reported them taking a full twelve minutes to come
 * back, which was precisely the old reboot ceiling, so a slow board failed at
 * the boundary. Their download reports also showed MikroTik's servers stalling
 * on one or two devices in a dozen.
 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // large images on slow links
const DOWNLOAD_POLL_MS = 10_000;
/**
 * How long to keep asking after the download command claims there is merely an
 * update "available". Long enough for a build that returns early to get started,
 * short enough that a genuine refusal is still reported promptly.
 */
const AVAILABLE_GRACE_POLLS = 3;

/** Reads better than a bare version in a sentence that may have none. */
const latestLabel = (v: string) => (v ? `Version ${v}` : 'The update');
const REBOOT_POLL_MS = 15_000;       // probe cadence while waiting
// A device that has just booted can accept an API connection and drop it while
// its services are still starting (#141). Settle before the RouterBOOT step,
// and retry its first connection rather than failing on it.
const ROUTERBOOT_SETTLE_MS = 10_000;
const ROUTERBOOT_CONNECT_ATTEMPTS = 3;
const REBOOT_TIMEOUT_MS = 12 * 60_000; // give slow flash writes room

/**
 * Operator overrides, read per rollout so a change needs no restart.
 *
 * Clamped rather than trusted: a zero would fail every device instantly, and an
 * unbounded value would hang a rollout forever on a device that is never coming
 * back.
 */
async function readTimeouts(): Promise<{ downloadMs: number; rebootMs: number }> {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings
      WHERE key IN ('firmware_download_timeout_min', 'firmware_reboot_timeout_min')`
  ).catch(() => []);
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  const minutes = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 120 ? n : fallback;
  };
  return {
    downloadMs: minutes(map['firmware_download_timeout_min'], DOWNLOAD_TIMEOUT_MS / 60_000) * 60_000,
    rebootMs: minutes(map['firmware_reboot_timeout_min'], REBOOT_TIMEOUT_MS / 60_000) * 60_000,
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface RolloutRow {
  id: number; name: string; status: string;
  halt_on_failure: boolean; pre_backup: boolean;
  /** Follow the RouterOS upgrade with the pending RouterBOOT upgrade (issue #113). */
  routerboot_after: boolean;
  /** How many devices in a wave may upgrade at once; 1 is sequential (#135). */
  wave_concurrency: number;
  /** 'mirror': devices set up for the local mirror pull from it (#193). */
  package_source: string;
  /** Commands to run on each device after its upgrade is verified (#163). */
  post_command: string | null;
  post_template_name: string | null;
}

/** The outcome of staging an image from the local mirror. */
type MirrorStage =
  | { kind: 'staged'; installed: string; latest: string; uptimeBefore: number | null }
  | { kind: 'skip'; installed: string; reason: string }
  | { kind: 'fail'; error: string };

const MIRROR_LIST_WAIT_MS = 60_000;
interface RolloutDeviceRow {
  id: number; rollout_id: number; device_id: number; wave: number; status: string;
}

export class FirmwareOrchestrator {
  /**
   * Resolved once per rollout rather than per device, so a rollout cannot
   * change its own rules halfway through.
   */
  private downloadMs = DOWNLOAD_TIMEOUT_MS;
  private rebootMs = REBOOT_TIMEOUT_MS;
  /** Pause before (and between) RouterBOOT connection attempts; a field so tests can shorten it. */
  routerbootSettleMs = ROUTERBOOT_SETTLE_MS;
  private activeRolloutId: number | null = null;
  private cancelRequested = false;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private backupService = new BackupService();

  get running(): number | null { return this.activeRolloutId; }

  /**
   * Close out rollouts that a manager restart interrupted (#140).
   *
   * A rollout marked `running` at startup cannot be running: the orchestrator
   * that would be driving it has only just been constructed. Left alone the row
   * stays `running` for ever, its unreached devices stay `pending`, nothing is
   * logged — and, because an unfinished rollout blocks its devices from joining
   * a new one, those devices can never be upgraded again.
   *
   * Deliberately does not resume. A device may have been mid-reboot when the
   * process died; continuing a firmware upgrade from an unknown state is how
   * hardware gets bricked.
   */
  async reconcileInterrupted(): Promise<void> {
    const stale = await query<{ id: number; name: string }>(
      `SELECT id, name FROM firmware_rollouts WHERE status = 'running'`
    );
    if (stale.length === 0) return;

    for (const r of stale) {
      const devices = await query<{ id: number; status: string }>(
        `SELECT id, status FROM firmware_rollout_devices WHERE rollout_id = $1`, [r.id]
      );
      for (const d of devices) {
        const outcome = interruptedOutcome(d.status);
        if (!outcome) continue;
        await query(
          `UPDATE firmware_rollout_devices
              SET status = $2, error = $3, finished_at = NOW()
            WHERE id = $1`,
          [d.id, outcome.status, outcome.error]
        );
      }
      await query(
        `UPDATE firmware_rollouts SET status = 'failed', finished_at = NOW() WHERE id = $1`,
        [r.id]
      );
      console.warn(
        `[Firmware] rollout #${r.id} ("${r.name}") was still marked running at startup — ` +
        `closing it out as interrupted. ${INTERRUPTED_RUN_ERROR}`
      );
    }
  }

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      this.startDueRollouts().catch(e => console.error('[Firmware] scheduler error:', e));
    }, 60_000);
  }

  stopScheduler(): void {
    if (this.schedulerTimer) { clearInterval(this.schedulerTimer); this.schedulerTimer = null; }
  }

  /**
   * Start the next scheduled rollout that is inside its window. One whose window
   * has passed (manager downtime, or an earlier rollout that ran long) is marked
   * 'missed' instead: starting late would reboot devices at a time nobody chose.
   */
  private async startDueRollouts(): Promise<void> {
    if (this.activeRolloutId) return;
    const due = await query<{ id: number; name: string; scheduled_at: string; scheduled_until: string | null }>(
      `SELECT id, name, scheduled_at, scheduled_until FROM firmware_rollouts
       WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC`);
    for (const r of due) {
      const decision = scheduleDecision(new Date(r.scheduled_at), r.scheduled_until ? new Date(r.scheduled_until) : null);
      if (decision === 'missed') {
        await query(
          `UPDATE firmware_rollouts SET status = 'missed', finished_at = NOW() WHERE id = $1 AND status = 'pending'`,
          [r.id]
        );
        await query(
          `UPDATE firmware_rollout_devices SET status = 'skipped', error = 'The rollout missed its start window', finished_at = NOW()
            WHERE rollout_id = $1 AND status = 'pending'`,
          [r.id]
        );
        console.warn(`[Firmware] rollout #${r.id} ("${r.name}") missed its start window and was not started`);
        continue;
      }
      if (decision === 'start') {
        await this.start(r.id).catch(e => console.error(`[Firmware] scheduled start of #${r.id} failed:`, e));
        return;
      }
    }
  }

  async start(rolloutId: number): Promise<void> {
    if (this.activeRolloutId) throw new Error(`Rollout #${this.activeRolloutId} is already running`);
    // Reserve before the first await, and claim the row only if it is still
    // pending: a manual start racing the scheduler ran the rollout twice
    // (outside review S10).
    this.activeRolloutId = rolloutId;
    let rollout: RolloutRow | null;
    try {
      rollout = await queryOne<RolloutRow>(
        `UPDATE firmware_rollouts SET status='running', started_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [rolloutId]);
      if (!rollout) {
        const cur = await queryOne<{ status: string }>(`SELECT status FROM firmware_rollouts WHERE id = $1`, [rolloutId]);
        throw new Error(cur ? `Rollout is ${cur.status} — only pending rollouts can start` : 'Rollout not found');
      }
    } catch (e) {
      this.activeRolloutId = null;
      throw e;
    }
    this.cancelRequested = false;

    // Fire-and-forget the run loop; callers poll status via the API.
    void this.run(rollout).catch(async (e) => {
      console.error(`[Firmware] rollout #${rolloutId} crashed:`, e);
      await query(`UPDATE firmware_rollouts SET status='failed', finished_at=NOW() WHERE id=$1`, [rolloutId]);
    }).finally(() => { this.activeRolloutId = null; });
  }

  cancel(rolloutId: number): void {
    if (this.activeRolloutId === rolloutId) this.cancelRequested = true;
  }

  private async run(rollout: RolloutRow): Promise<void> {
    ({ downloadMs: this.downloadMs, rebootMs: this.rebootMs } = await readTimeouts());
    console.log(
      `[Firmware] timeouts: download ${Math.round(this.downloadMs / 60000)}min, ` +
      `reboot ${Math.round(this.rebootMs / 60000)}min`
    );
    const items = await query<RolloutDeviceRow>(
      `SELECT * FROM firmware_rollout_devices WHERE rollout_id=$1 ORDER BY wave ASC, id ASC`,
      [rollout.id]);

    const concurrency = clampConcurrency(rollout.wave_concurrency);
    const waves = [...new Set(items.map((i) => i.wave))].sort((a, b) => a - b);
    let halted = false;

    // Waves stay strictly sequential -- that is the decision point, and it is
    // what makes wave 1 a canary. Concurrency applies only *within* a wave.
    //
    // Halt-on-failure stops *starting* further devices the moment a failure is
    // known, rather than at the end of the wave. Devices already in flight are
    // allowed to finish, because interrupting a device mid-write is how you
    // brick it.
    //
    // At the default concurrency of 1 that is exactly the previous behaviour:
    // a failure stops the next device immediately. Only devices genuinely
    // running side by side can carry a bad build, which is the unavoidable part
    // of the trade in #135 -- not a wider blast radius imposed on rollouts that
    // never asked for concurrency.
    for (const wave of waves) {
      if (this.cancelRequested || halted) break;
      const inWave = items.filter((i) => i.wave === wave);

      if (concurrency > 1 && inWave.length > 1) {
        console.log(`[Firmware] rollout #${rollout.id}: wave ${wave} — ` +
                    `${inWave.length} device(s), up to ${concurrency} at once`);
      }

      let failedInWave = false;
      const results = await mapWithConcurrency(inWave, concurrency, async (item) => {
        if (this.cancelRequested) return false;
        // Do not begin another device once this wave has already failed.
        if (rollout.halt_on_failure && failedInWave) return false;
        const ok = await this.upgradeDevice(rollout, item);
        if (!ok) failedInWave = true;
        return ok;
      });

      if (rollout.halt_on_failure && results.some((ok) => !ok)) {
        halted = true;
        console.warn(`[Firmware] rollout #${rollout.id}: halting after failures in wave ${wave}`);
      }
    }

    // Anything never reached is skipped rather than failed -- it did not run.
    await query(
      `UPDATE firmware_rollout_devices SET status='skipped', error=$2, finished_at=NOW()
        WHERE rollout_id=$1 AND status='pending'`,
      [rollout.id, this.cancelRequested ? 'Rollout cancelled' : 'Halted: earlier device failed']);

    const finalStatus = this.cancelRequested ? 'cancelled' : halted ? 'failed' : 'completed';
    await query(`UPDATE firmware_rollouts SET status=$2, finished_at=NOW() WHERE id=$1`, [rollout.id, finalStatus]);
    console.log(`[Firmware] rollout #${rollout.id} ${finalStatus}`);

    if (finalStatus === 'completed' || finalStatus === 'failed') {
      const counts = await queryOne<{ ok: string; failed: string }>(
        `SELECT COUNT(*) FILTER (WHERE status='success')::text AS ok,
                COUNT(*) FILTER (WHERE status='failed')::text  AS failed
         FROM firmware_rollout_devices WHERE rollout_id=$1`, [rollout.id]);
      void import('./WebhookService').then(({ webhookService }) =>
        webhookService.dispatch(finalStatus === 'completed' ? 'rollout_completed' : 'rollout_failed', {
          rollout_id: rollout.id, name: rollout.name,
          succeeded: parseInt(counts?.ok || '0', 10), failed: parseInt(counts?.failed || '0', 10),
        })
      ).catch(() => {});
    }
  }

  private async setItem(id: number, fields: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
    await query(`UPDATE firmware_rollout_devices SET ${sets} WHERE id=$1`, [id, ...keys.map(k => fields[k])]);
  }

  private async upgradeDevice(rollout: RolloutRow, item: RolloutDeviceRow): Promise<boolean> {
    const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id=$1`, [item.device_id]);
    if (!device) {
      await this.setItem(item.id, { status: 'failed', error: 'Device no longer exists' });
      return false;
    }
    const fail = async (error: string) => {
      console.error(`[Firmware] ${device.name}: ${error}`);
      await this.setItem(item.id, { status: 'failed', error });
      await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
      return false;
    };

    await query(`UPDATE firmware_rollout_devices SET started_at=NOW() WHERE id=$1`, [item.id]);
    const fromVersion = (device.ros_version || '').trim();
    await this.setItem(item.id, { from_version: fromVersion || null });

    // 1. Pre-upgrade backup
    if (rollout.pre_backup) {
      await this.setItem(item.id, { status: 'backing_up' });
      try {
        await this.backupService.createBackup({
          id: device.id, name: device.name, ip_address: device.ip_address,
          ssh_port: device.ssh_port ?? 22, ssh_username: device.ssh_username,
          ssh_password_encrypted: device.ssh_password_encrypted,
          api_username: device.api_username, api_password_encrypted: device.api_password_encrypted,
        }, `Pre-upgrade backup (rollout "${rollout.name}")`, 'pre-upgrade');
      } catch (e) {
        return fail(`Pre-upgrade backup failed: ${(e as Error).message}`);
      }
    }

    // 2. Download the image, and confirm it is actually on the device.
    //
    // Deliberately not `/system/package/update/install`, which bundles download
    // and reboot into one call whose progress cannot be observed. A CCR2216 was
    // seen to accept it, neither download nor reboot, and report nothing — which
    // surfaced as "rebooted but still reports 7.24.1" because the check below
    // could not tell a device that never restarted from one that restarted
    // unchanged. Downloading first makes success verifiable *before* anything
    // reboots, and means a device is never restarted for an image it lacks.
    await this.setItem(item.id, { status: 'upgrading' });
    let uptimeBefore: number | null;
    // Read from the device just before the download, not the stored copy: the
    // "before" version and the target are what the result is checked against.
    let installed: string;
    let latest: string;
    const collector = new DeviceCollector(device);
    const step = (msg: string) => console.log(`[Firmware] ${device.name}: ${msg}`);
    // Pull from the local mirror when the rollout asks for it and this device
    // is set up for one; anything else downloads from MikroTik as before (#193).
    const mirror = rollout.package_source === 'mirror' ? await mirrorForDevice(device.id).catch(() => null) : null;
    if (rollout.package_source === 'mirror' && !mirror) {
      step('not set up for the local mirror; downloading from MikroTik');
    }
    try {
      await collector.connect();
      if (mirror) {
        const staged = await this.stageFromMirror(collector, device, item, mirror, step);
        if (staged.kind === 'fail') { collector.disconnect(); return fail(staged.error); }
        if (staged.kind === 'skip') {
          await this.setItem(item.id, { status: 'skipped', error: staged.reason, to_version: staged.installed || null });
          await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
          collector.disconnect();
          return true;
        }
        installed = staged.installed;
        latest = staged.latest;
        uptimeBefore = staged.uptimeBefore;
      } else {
      const status = await collector.checkForUpdates();
      installed = (status['installed-version'] || '').trim();
      latest = (status['latest-version'] || '').trim();
      if (installed) await this.setItem(item.id, { from_version: installed });
      // Only a genuinely newer version is installed. A channel offering an older
      // release (long-term, say) would otherwise downgrade the device.
      const decision = upgradeDecision(installed, latest);
      if (decision.action === 'skip') {
        await this.setItem(item.id, { status: 'skipped', error: decision.reason, to_version: installed || null });
        await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
        collector.disconnect();
        return true;
      }

      uptimeBefore = await collector.getUptimeSeconds();

      // Free space is the usual reason a download never completes, and "did not
      // finish in ten minutes" sends someone hunting the network when the device
      // simply has nowhere to put the image.
      const res = await collector.getSystemResource().catch(() => ({} as Record<string, string>));
      const freeMb = Math.round((parseInt(res['free-hdd-space'] || '0', 10) / 1048576) * 10) / 10;
      const spaceNote = freeMb > 0 ? ` The device reports ${freeMb} MB free.` : '';

      // Take the answer from the command itself.
      //
      // /system/package/update/download streams a row per progress update and
      // ends with the outcome, so the device tells us directly whether the image
      // landed. The previous version discarded all of it and inferred completion
      // by polling for /downloaded/i -- which matches "Downloaded 86% (11.6MiB)".
      // A poll landing mid-download therefore looked like success, and the
      // device was rebooted on a partial image; it came back on the old version
      // and was reported as "rebooted but still reports X", which was true and
      // was our doing (#141).
      step(`downloading ${latest} (installed ${installed || 'unknown'}, ${freeMb || '?'} MB free)`);

      let outcome: UpdateStatus | null = null;
      let reachedPercent: number | null = null;
      try {
        const result = await collector.downloadUpdate(this.downloadMs);
        outcome = result.status;
        reachedPercent = result.peakPercent;
        step(`download command finished after ${result.rows} progress update(s): ${describeUpdateStatus(outcome)}`);
      } catch (e) {
        // A timed-out or dropped command is not evidence of failure -- the image
        // may well have landed. Ask again on a fresh connection.
        step(`download command did not return cleanly (${(e as Error).message}); re-checking on a new connection`);
        collector.disconnect();
        try {
          await collector.connect();
        } catch (re) {
          return fail(
            `Lost contact with the device while downloading ${latest}: ${(re as Error).message}. ` +
            `Nothing was rebooted.${spaceNote}`
          );
        }
      }

      if (outcome?.state === 'error') {
        collector.disconnect();
        const got = reachedPercent != null ? ` It reached ${reachedPercent}%.` : '';
        return fail(`Device could not download ${latest}: ${outcome.message}.${got}${spaceNote}`);
      }

      // "New version is available" after the command returned usually means the
      // download stopped without landing the image -- but only usually.
      //
      // The command blocks and streams progress on the RouterOS versions tested
      // here, so a final "available" is conclusive. It is not safe to assume
      // every build behaves that way: one that dispatches the download and
      // returns straight away would report "available" for a download that is
      // merely starting, and treating that as failure turns a working upgrade
      // into an instant, confident error.
      //
      // So the claim is checked rather than trusted. A short grace period asks
      // whether progress appears; if it does, this was an early return and the
      // normal wait takes over. Only a status that stays put is a failure.
      if (outcome?.state === 'available' || outcome?.state === 'up-to-date') {
        step(`download command returned "${outcome.message}" — checking whether it started anyway`);
        let started = false;
        for (let i = 0; i < AVAILABLE_GRACE_POLLS; i++) {
          await sleep(DOWNLOAD_POLL_MS);
          if (this.cancelRequested) break;
          const s = await collector.getUpdateStatusParsed().catch(() => null);
          if (!s) continue;
          if (s.state === 'downloading' || s.state === 'downloaded') {
            step(`it did: ${describeUpdateStatus(s)}`);
            if (s.percent != null) reachedPercent = s.percent;
            outcome = s;
            started = true;
            break;
          }
          if (s.state === 'error') {
            collector.disconnect();
            return fail(`Device could not download ${latest}: ${s.message}.${spaceNote}`);
          }
        }

        if (!started) {
          collector.disconnect();
          const got = reachedPercent != null
            ? ` It stopped at ${reachedPercent}%.`
            : ' It never reported any progress.';
          return fail(
            `Device did not download ${latest} — it still reports "${outcome.message}" ` +
            `${Math.round((AVAILABLE_GRACE_POLLS * DOWNLOAD_POLL_MS) / 1000)}s after the download ` +
            `command finished.${got} Nothing was rebooted.${spaceNote}` +
            (freeMb > 0 && freeMb < 20 ? ' That is very unlikely to be enough for a RouterOS image.' : '')
          );
        }
      }

      // Poll only when the command did not already say it finished, and report
      // the percentage each time so a stalled download is visibly stalled rather
      // than merely slow.
      let downloaded = outcome?.state === 'downloaded';
      let lastSeen = '';
      let unreadable = 0;
      const dlDeadline = Date.now() + this.downloadMs;
      while (!downloaded && Date.now() < dlDeadline) {
        if (this.cancelRequested) break;
        let s: UpdateStatus;
        try {
          s = await collector.getUpdateStatusParsed();
          unreadable = 0;
        } catch (e) {
          // Not knowing is not the same as "still downloading". A connection
          // that has stopped answering used to be swallowed into an empty
          // string and waited out for the full ten minutes.
          unreadable++;
          step(`status unreadable (${(e as Error).message})`);
          if (unreadable >= 3) {
            collector.disconnect();
            return fail(
              `Lost contact with the device while downloading ${latest}. Nothing was rebooted.${spaceNote}`
            );
          }
          await sleep(DOWNLOAD_POLL_MS);
          continue;
        }

        const described = describeUpdateStatus(s);
        if (described !== lastSeen) { step(described); lastSeen = described; }
        if (s.percent != null) reachedPercent = s.percent;

        if (s.state === 'downloaded') { downloaded = true; break; }
        if (s.state === 'error') {
          collector.disconnect();
          return fail(`Device could not download ${latest}: ${s.message}.${spaceNote}`);
        }
        await sleep(DOWNLOAD_POLL_MS);
      }

      if (!downloaded) {
        collector.disconnect();
        const got = reachedPercent != null
          ? ` It reached ${reachedPercent}% before stopping.`
          : ' It never reported any progress.';
        return fail(
          `Device did not finish downloading ${latest} within ` +
          `${Math.round(this.downloadMs / 60000)} minutes.${got} Nothing was rebooted.${spaceNote}` +
          (freeMb > 0 && freeMb < 20 ? ' That is unlikely to be enough for a RouterOS image.' : '')
        );
      }

      }

      step(`image confirmed on device; rebooting into ${latest}`);
      await this.setItem(item.id, { to_version: latest });
      await collector.reboot();
    } catch (e) {
      collector.disconnect();
      return fail(`Update failed before reboot: ${(e as Error).message}`);
    }
    collector.disconnect();

    // 3. Ride out the reboot, and prove one happened.
    await this.setItem(item.id, { status: 'rebooting' });
    await sleep(REBOOT_GRACE_MS);
    const deadline = Date.now() + this.rebootMs;
    let backOnline = false;
    let rebootProven = false;
    /** False when a missing uptime reading made the restart an assumption. */
    let uptimeComparable = false;
    let newVersion = '';
    while (Date.now() < deadline) {
      if (this.cancelRequested) break;
      const probe = new DeviceCollector(device);
      try {
        await probe.connect();
        const resource = await probe.getSystemResource();
        newVersion = (resource['version'] || '').split(' ')[0];
        const uptimeNow = await probe.getUptimeSeconds();
        probe.disconnect();

        // An uptime that did not fall means we are talking to the same running
        // system, not a restarted one — so keep waiting rather than reading the
        // old version and calling it a failed upgrade.
        //
        // Where either reading is missing the restart is *assumed*, not proven,
        // and that distinction has to survive: the failure message below used to
        // state "Device rebooted but still reports X" on the strength of an
        // assumption, asserting the very thing this check exists to establish.
        uptimeComparable = uptimeBefore != null && uptimeNow != null;
        rebootProven = !uptimeComparable || uptimeNow! < uptimeBefore!;
        if (rebootProven) { await this.setItem(item.id, { status: 'verifying' }); backOnline = true; break; }
        await sleep(REBOOT_POLL_MS);
      } catch {
        probe.disconnect();
        await sleep(REBOOT_POLL_MS);
      }
    }

    if (backOnline && !rebootProven) {
      return fail(
        `${latestLabel(newVersion)} was downloaded, but the device never restarted. ` +
        `It is still running and reachable — reboot it to complete the upgrade.`
      );
    }
    if (!backOnline) {
      return fail(`Device did not come back online within ${Math.round(this.rebootMs / 60000)} minutes after the upgrade — check it manually (a pre-upgrade backup ${rollout.pre_backup ? 'exists' : 'was NOT taken'})`);
    }

    // 4. Verify the device is on the version we installed. Compared with the
    // target, not the stored version: an upgrade that never moved, or landed on
    // something else, or whose version can't be read, is not a success.
    const verdict = verifyUpgrade(latest, newVersion, installed || fromVersion);
    if (!verdict.ok) {
      return fail(
        uptimeComparable
          ? `${verdict.error}. The image was confirmed on the device beforehand, so check its free space and logs.`
          : `${verdict.error}. Its uptime could not be read either, so whether it restarted at all is unknown.`
      );
    }
    // 5. RouterBOOT, if asked for (issue #113).
    //
    // Deliberately after the RouterOS upgrade and its verification: the bootloader
    // ships inside the RouterOS package, so upgrading it first would apply the old
    // one. This is a second flash and a second reboot, so it only runs once the OS
    // half is confirmed good.
    if (rollout.routerboot_after) {
      const rbResult = await this.upgradeRouterboot(device, item);
      if (!rbResult.ok) {
        // The RouterOS upgrade did land. Say so, rather than reporting the device as
        // simply failed and sending someone to re-run an upgrade it already has.
        return fail(`RouterOS upgraded to ${newVersion || 'unknown'} successfully, but the RouterBOOT upgrade failed: ${rbResult.error}`);
      }
    }

    await query(`UPDATE devices SET ros_version=COALESCE(NULLIF($2,''), ros_version), firmware_update_available=FALSE, status='online', last_seen=NOW() WHERE id=$1`,
      [device.id, newVersion]);
    console.log(`[Firmware] ${device.name}: upgraded to ${newVersion || 'unknown'}`);

    // 6. Post-upgrade commands (#163), only on a device that really upgraded
    // and only once its new version is confirmed. A failure doesn't undo the
    // upgrade, but it counts toward halt-on-failure: the same commands would
    // likely fail on the next device too.
    let postOk = true;
    if (rollout.post_command) {
      await this.setItem(item.id, { status: 'post_commands', to_version: newVersion || null });
      const post = await this.runPostCommands(device, rollout);
      postOk = post.ok;
      await query(`UPDATE firmware_rollout_devices SET post_status=$2, post_output=$3, post_error=$4 WHERE id=$1`,
        [item.id, post.ok ? 'ok' : 'failed', post.output, post.error]);
    }

    await this.setItem(item.id, {
      status: 'success', to_version: newVersion || null,
      error: postOk ? null : `Upgraded to ${newVersion || 'the new version'}, but the post-upgrade commands failed`,
    });
    await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
    return postOk;
  }

  /**
   * Run the rollout's post-upgrade commands on one device (#163), over SSH and
   * under Change Guard, the same way a bulk command runs.
   */
  private async runPostCommands(device: DeviceRow, rollout: RolloutRow): Promise<{ ok: boolean; output: string | null; error: string | null }> {
    const execute = async () => {
      const { output } = await runSshCommand(device as unknown as SshExecDevice, rollout.post_command!);
      if (looksLikeFailure(output)) throw new Error(output.slice(0, 500));
      return output;
    };
    try {
      const outcome = await withSafeApply(device as unknown as GuardDevice, {
        kind: 'command.bulk',
        summary: `Post-upgrade commands${rollout.post_template_name ? ` (${rollout.post_template_name})` : ''}`,
        requireProtection: false,
      }, execute);
      if (outcome.autoReverting) {
        return { ok: false, output: outcome.result ?? null, error: 'The device stopped responding after the commands and is restoring itself.' };
      }
      return { ok: true, output: outcome.result ?? null, error: null };
    } catch (e) {
      console.error(`[Firmware] ${device.name}: post-upgrade commands failed: ${(e as Error).message}`);
      return { ok: false, output: null, error: (e as Error).message.slice(0, 1000) };
    }
  }

  /**
   * Stage the newest complete version from the device's local mirror (#193).
   *
   * Every installed package must be on the mirror at that version: uploading
   * routeros alone would leave, say, wifi-qcom behind, and RouterOS disables a
   * mismatched package on reboot. local-update/download runs in the background
   * and can fail without a word, so success is the files themselves on the
   * device at the size the mirror recorded, never the command's reply. Nothing
   * reboots unless every file is there.
   */
  private async stageFromMirror(
    collector: DeviceCollector,
    device: DeviceRow,
    item: RolloutDeviceRow,
    mirror: MirrorRow,
    step: (msg: string) => void,
  ): Promise<MirrorStage> {
    const res = await collector.getSystemResource();
    const installed = (res['version'] || '').split(' ')[0].trim();
    const arch = (res['architecture-name'] || '').trim().toLowerCase();
    const packages = await collector.getInstalledPackages();
    if (installed) await this.setItem(item.id, { from_version: installed });

    const target = await newestCompleteVersion(mirror.id, arch, packages);
    if (!target) {
      return { kind: 'fail', error: `The local mirror has no version with every package this device runs (${packages.join(', ')} for ${arch || 'unknown architecture'}). Sync the mirror, or roll out from MikroTik.` };
    }
    const decision = upgradeDecision(installed, target);
    if (decision.action === 'skip') return { kind: 'skip', installed, reason: decision.reason };

    const expected = await query<{ package: string; filename: string; size_bytes: string }>(
      `SELECT package, filename, size_bytes FROM firmware_mirror_files WHERE mirror_id = $1 AND version = $2`, [mirror.id, target]);
    const want = packages.map((p) => {
      const name = packageFileName(p, target, arch)!;
      return { pkg: p, name, size: Number(expected.find((e) => e.filename === name)?.size_bytes || 0) };
    });
    const needBytes = want.reduce((n, w) => n + w.size, 0);
    const free = Number(res['free-hdd-space'] || 0);
    if (free && needBytes > free) {
      return { kind: 'fail', error: `Not enough space for ${target}: the packages need ${Math.round(needBytes / 1048576)} MB and the device has ${Math.round(free / 1048576)} MB free. Nothing was downloaded.` };
    }
    const uptimeBefore = await collector.getUptimeSeconds();

    step(`asking the local mirror for ${target} (${packages.join(', ')}, ${arch})`);
    await collector.refreshLocalUpdate();
    let match: ReturnType<typeof matchLocalUpdate> = { ok: false, missing: packages };
    const listDeadline = Date.now() + MIRROR_LIST_WAIT_MS;
    while (Date.now() < listDeadline) {
      match = matchLocalUpdate(await collector.getLocalUpdatePackages(), packages, target);
      if (match.ok) break;
      await sleep(5_000);
    }
    if (!match.ok) {
      return { kind: 'fail', error: `The device couldn’t see ${match.missing.join(', ')} ${target} on the local mirror. Check it can reach the package server, then try again. Nothing was downloaded.` };
    }

    // A partial set left in the root would be installed by the next reboot,
    // whoever causes it: a new routeros without its wifi-qcom is an access
    // point with no wireless. So a download that doesn't complete is undone.
    const removeLanded = async () => {
      const files = await collector.getFiles().catch(() => [] as Record<string, string>[]);
      for (const f of files) {
        if (f['.id'] && want.some((w) => w.name === f['name'])) await collector.removeFileById(f['.id']).catch(() => {});
      }
    };

    try {
      for (const m of match.ids) await collector.downloadLocalUpdate(m.id);
    } catch (e) {
      // One may already be on its way; give it a moment, then take it back off.
      await sleep(DOWNLOAD_POLL_MS);
      await removeLanded();
      return { kind: 'fail', error: `The device refused to download ${target} from the local mirror: ${(e as Error).message}. Nothing was rebooted.` };
    }
    step(`downloading ${target} from the local mirror`);

    const deadline = Date.now() + this.downloadMs;
    let landed: string[] = [];
    while (Date.now() < deadline) {
      if (this.cancelRequested) {
        await removeLanded();
        return { kind: 'fail', error: 'Rollout cancelled while downloading. Nothing was rebooted.' };
      }
      await sleep(DOWNLOAD_POLL_MS);
      const files = await collector.getFiles().catch(() => null);
      if (!files) continue;
      landed = want.filter((w) => files.some((f) => f['name'] === w.name && (!w.size || Number(f['size'] || 0) === w.size))).map((w) => w.name);
      if (landed.length === want.length) {
        step(`all ${want.length} package(s) on the device`);
        return { kind: 'staged', installed, latest: target, uptimeBefore };
      }
    }
    const missingFiles = want.map((w) => w.name).filter((n) => !landed.includes(n));
    await removeLanded();
    return {
      kind: 'fail',
      error: `Didn’t finish downloading ${target} from the local mirror within ${Math.round(this.downloadMs / 60000)} minutes: ${missingFiles.join(', ')} never arrived. The packages that did were removed, and nothing was rebooted.`,
    };
  }

  /**
   * Apply a pending RouterBOOT upgrade and ride out the reboot it causes.
   *
   * A device with nothing pending is a success, not a failure — most of a fleet will
   * already be current, and treating "nothing to do" as an error would halt rollouts
   * for no reason.
   */
  private async upgradeRouterboot(
    device: DeviceRow,
    item: RolloutDeviceRow
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    await sleep(this.routerbootSettleMs);

    // Connect and check, with retries: this runs moments after the RouterOS
    // reboot, when the device may still be starting its services.
    let probe: DeviceCollector | null = null;
    let status: Awaited<ReturnType<DeviceCollector['checkRouterboardUpgrade']>> | null = null;
    let lastError = '';
    for (let attempt = 1; attempt <= ROUTERBOOT_CONNECT_ATTEMPTS && !status; attempt++) {
      if (this.cancelRequested) return { ok: false, error: 'cancelled before the RouterBOOT upgrade' };
      probe = new DeviceCollector(device);
      try {
        await probe.connect();
        status = await probe.checkRouterboardUpgrade();
      } catch (e) {
        lastError = (e as Error).message;
        probe.disconnect();
        probe = null;
        if (attempt < ROUTERBOOT_CONNECT_ATTEMPTS) await sleep(this.routerbootSettleMs);
      }
    }
    if (!status || !probe) {
      return { ok: false, error: `could not reach the device after ${ROUTERBOOT_CONNECT_ATTEMPTS} attempts (${lastError})` };
    }

    const before = status.currentFirmware;
    const target = status.upgradeFirmware;
    if (!status.upgradeAvailable) {
      probe.disconnect();
      console.log(`[Firmware] ${device.name}: RouterBOOT already current (${before || 'unknown'})`);
      return { ok: true };
    }
    const uptimeBefore: number | null = await probe.getUptimeSeconds().catch(() => null);
    try {
      await this.setItem(item.id, { status: 'routerboot' });
      await probe.installRouterboardUpgrade();   // upgrades, then reboots
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      probe.disconnect();
    }

    // Second reboot of this upgrade. Same budget as the first. The device may
    // still be up for a few seconds after the reboot command, so a reading only
    // counts once uptime proves it restarted; otherwise the old bootloader
    // version would be read and reported as a failed upgrade.
    const deadline = Date.now() + this.rebootMs;
    while (Date.now() < deadline) {
      if (this.cancelRequested) return { ok: false, error: 'cancelled while rebooting' };
      await sleep(REBOOT_POLL_MS);
      const probe = new DeviceCollector(device);
      try {
        await probe.connect();
        const uptimeNow = await probe.getUptimeSeconds().catch(() => null);
        if (uptimeBefore != null && uptimeNow != null && uptimeNow >= uptimeBefore) {
          probe.disconnect();
          continue;   // not restarted yet
        }
        const after = await probe.checkRouterboardUpgrade();
        probe.disconnect();
        // Checked against the target, and an unreadable version is not a pass.
        if (!after.currentFirmware) {
          return { ok: false, error: 'the device came back but its RouterBOOT version could not be read, so the upgrade can\u2019t be confirmed' };
        }
        if (before && after.currentFirmware === before) {
          return { ok: false, error: `device rebooted but RouterBOOT still reports ${after.currentFirmware}` };
        }
        if (target && after.currentFirmware !== target) {
          return { ok: false, error: `expected RouterBOOT ${target}, but the device reports ${after.currentFirmware}` };
        }
        await query(
          `UPDATE devices SET routerboard_upgrade_available = FALSE, firmware_version = COALESCE(NULLIF($2,''), firmware_version) WHERE id = $1`,
          [device.id, after.currentFirmware]
        );
        console.log(`[Firmware] ${device.name}: RouterBOOT ${before || '?'} → ${after.currentFirmware || '?'}`);
        return { ok: true };
      } catch {
        probe.disconnect();
      }
    }
    return { ok: false, error: `device did not come back within ${Math.round(this.rebootMs / 60000)} minutes after the RouterBOOT upgrade` };
  }
}

export const firmwareOrchestrator = new FirmwareOrchestrator();
