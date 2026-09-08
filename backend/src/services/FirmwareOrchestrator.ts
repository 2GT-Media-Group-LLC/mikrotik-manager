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

const REBOOT_GRACE_MS = 25_000;      // let the device actually go down
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // large images on slow links
const DOWNLOAD_POLL_MS = 10_000;

/** Reads better than a bare version in a sentence that may have none. */
const latestLabel = (v: string) => (v ? `Version ${v}` : 'The update');
const REBOOT_POLL_MS = 15_000;       // probe cadence while waiting
const REBOOT_TIMEOUT_MS = 12 * 60_000; // give slow flash writes room

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface RolloutRow {
  id: number; name: string; status: string;
  halt_on_failure: boolean; pre_backup: boolean;
  /** Follow the RouterOS upgrade with the pending RouterBOOT upgrade (issue #113). */
  routerboot_after: boolean;
  /** How many devices in a wave may upgrade at once; 1 is sequential (#135). */
  wave_concurrency: number;
}
interface RolloutDeviceRow {
  id: number; rollout_id: number; device_id: number; wave: number; status: string;
}

export class FirmwareOrchestrator {
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

  private async startDueRollouts(): Promise<void> {
    if (this.activeRolloutId) return;
    const due = await queryOne<{ id: number }>(
      `SELECT id FROM firmware_rollouts
       WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC LIMIT 1`);
    if (due) await this.start(due.id).catch(e => console.error(`[Firmware] scheduled start of #${due.id} failed:`, e));
  }

  async start(rolloutId: number): Promise<void> {
    if (this.activeRolloutId) throw new Error(`Rollout #${this.activeRolloutId} is already running`);
    const rollout = await queryOne<RolloutRow>(`SELECT * FROM firmware_rollouts WHERE id = $1`, [rolloutId]);
    if (!rollout) throw new Error('Rollout not found');
    if (rollout.status !== 'pending') throw new Error(`Rollout is ${rollout.status} — only pending rollouts can start`);

    this.activeRolloutId = rolloutId;
    this.cancelRequested = false;
    await query(`UPDATE firmware_rollouts SET status='running', started_at=NOW() WHERE id=$1`, [rolloutId]);

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
    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      const status = await collector.checkForUpdates();
      const installed = (status['installed-version'] || '').trim();
      const latest = (status['latest-version'] || '').trim();
      if (!latest || latest === installed) {
        await this.setItem(item.id, { status: 'skipped', error: 'Already up to date', to_version: installed || null });
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

      // The download command blocks until the image has landed, which on an
      // ordinary link is a minute or more. If that outruns its budget the
      // connection can no longer be trusted, so it is replaced rather than
      // reused -- but a timed-out download is *not* evidence of failure. The
      // device is asked on a fresh connection what actually happened, because
      // declaring failure here is what made a working download look broken
      // when several devices ran in one wave (#136).
      let downloaded = false;
      try {
        await collector.downloadUpdate(DOWNLOAD_TIMEOUT_MS);
      } catch (e) {
        console.warn(`[Firmware] ${device.name}: download command did not return cleanly ` +
                     `(${(e as Error).message}); re-checking on a new connection`);
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

      // Confirm the image is on the device. Normally this is true immediately,
      // because the download command only returns once it is; the wait covers
      // RouterOS versions that return early and report progress instead.
      const dlDeadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
      while (Date.now() < dlDeadline) {
        if (this.cancelRequested) break;
        const s = await collector.getUpdateStatus().catch(() => '');
        if (/downloaded/i.test(s)) { downloaded = true; break; }
        if (/error|fail/i.test(s)) {
          collector.disconnect();
          return fail(`Device could not download ${latest}: ${s}.${spaceNote}`);
        }
        await sleep(DOWNLOAD_POLL_MS);
      }
      if (!downloaded) {
        collector.disconnect();
        return fail(
          `Device did not finish downloading ${latest} within ` +
          `${Math.round(DOWNLOAD_TIMEOUT_MS / 60000)} minutes. Nothing was rebooted.${spaceNote}` +
          (freeMb > 0 && freeMb < 20 ? ' That is unlikely to be enough for a RouterOS image.' : '')
        );
      }

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
    const deadline = Date.now() + REBOOT_TIMEOUT_MS;
    let backOnline = false;
    let rebootProven = false;
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
        rebootProven = uptimeBefore == null || uptimeNow == null || uptimeNow < uptimeBefore;
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
      return fail(`Device did not come back online within ${Math.round(REBOOT_TIMEOUT_MS / 60000)} minutes after the upgrade — check it manually (a pre-upgrade backup ${rollout.pre_backup ? 'exists' : 'was NOT taken'})`);
    }

    // 4. Verify the version actually moved
    if (newVersion && fromVersion && newVersion === fromVersion) {
      return fail(`Device rebooted but still reports ${newVersion} — the update did not apply`);
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

    await this.setItem(item.id, { status: 'success', to_version: newVersion || null });
    await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
    await query(`UPDATE devices SET ros_version=COALESCE(NULLIF($2,''), ros_version), firmware_update_available=FALSE, status='online', last_seen=NOW() WHERE id=$1`,
      [device.id, newVersion]);
    console.log(`[Firmware] ${device.name}: upgraded to ${newVersion || 'unknown'}`);
    return true;
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
    let before: string;
    try {
      const probe = new DeviceCollector(device);
      await probe.connect();
      const status = await probe.checkRouterboardUpgrade();
      before = status.currentFirmware;
      if (!status.upgradeAvailable) {
        probe.disconnect();
        console.log(`[Firmware] ${device.name}: RouterBOOT already current (${before || 'unknown'})`);
        return { ok: true };
      }
      await this.setItem(item.id, { status: 'routerboot' });
      await probe.installRouterboardUpgrade();   // upgrades, then reboots
      probe.disconnect();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    // Second reboot of this upgrade. Same budget as the first.
    const deadline = Date.now() + REBOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.cancelRequested) return { ok: false, error: 'cancelled while rebooting' };
      const probe = new DeviceCollector(device);
      try {
        await probe.connect();
        const after = await probe.checkRouterboardUpgrade();
        probe.disconnect();
        if (after.currentFirmware && before && after.currentFirmware === before) {
          return { ok: false, error: `device rebooted but RouterBOOT still reports ${after.currentFirmware}` };
        }
        await query(
          `UPDATE devices SET routerboard_upgrade_available = FALSE, firmware_version = COALESCE(NULLIF($2,''), firmware_version) WHERE id = $1`,
          [device.id, after.currentFirmware]
        );
        console.log(`[Firmware] ${device.name}: RouterBOOT ${before || '?'} → ${after.currentFirmware || '?'}`);
        return { ok: true };
      } catch {
        probe.disconnect();
        await sleep(REBOOT_POLL_MS);
      }
    }
    return { ok: false, error: `device did not come back within ${Math.round(REBOOT_TIMEOUT_MS / 60000)} minutes after the RouterBOOT upgrade` };
  }
}

export const firmwareOrchestrator = new FirmwareOrchestrator();
