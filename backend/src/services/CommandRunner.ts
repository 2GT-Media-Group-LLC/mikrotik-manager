/**
 * Running one command across many devices, in waves.
 *
 * The waves are the point. `for h in $hosts; do ssh $h "$cmd"; done` already
 * exists, costs nothing, and does most of this — but it reaches every device
 * before the first error is visible. What this adds is the ability to stop: a
 * small first wave, a look at what happened, and a halt before the mistake
 * becomes sixty mistakes (#118).
 *
 * Within that, the operator is trusted. Arbitrary commands, because a curated
 * library cannot express "add a channel to LACP" or "rewrite a WireGuard
 * endpoint". Change Guard on by default because bulk shutdown and firewall edits
 * are on the list of things people actually run, and off in one click because a
 * sharp tool that refuses to cut is not a tool.
 */
import { query, queryOne } from '../config/database';
import { runSshCommand, looksLikeFailure, type SshExecDevice } from './sshExec';
import { withSafeApply, type GuardDevice } from './changeGuard/ChangeGuard';

interface RunRow {
  id: number;
  name: string;
  command: string;
  wave_size: number;
  halt_on_failure: boolean;
  use_change_guard: boolean;
  status: string;
}

interface RunDeviceRow {
  id: number;
  device_id: number;
  wave: number;
}

type DeviceRow = SshExecDevice & GuardDevice;

export class CommandRunner {
  private activeRunId: number | null = null;
  private cancelRequested = false;

  get isRunning(): boolean {
    return this.activeRunId !== null;
  }

  async start(runId: number): Promise<void> {
    if (this.activeRunId) throw new Error(`Run #${this.activeRunId} is already in progress`);
    const run = await queryOne<RunRow>(`SELECT * FROM command_runs WHERE id = $1`, [runId]);
    if (!run) throw new Error('Run not found');
    if (run.status !== 'pending') throw new Error(`Run is ${run.status} — only pending runs can start`);

    this.activeRunId = runId;
    this.cancelRequested = false;
    await query(`UPDATE command_runs SET status='running', started_at=NOW() WHERE id=$1`, [runId]);

    // Fire and forget; callers poll. A bulk run outlives any HTTP request.
    void this.run(run)
      .catch(async (e) => {
        console.error(`[Command] run #${runId} crashed:`, e);
        await query(`UPDATE command_runs SET status='failed', finished_at=NOW() WHERE id=$1`, [runId]);
      })
      .finally(() => { this.activeRunId = null; });
  }

  cancel(runId: number): void {
    if (this.activeRunId === runId) this.cancelRequested = true;
  }

  private async run(run: RunRow): Promise<void> {
    const items = await query<RunDeviceRow>(
      `SELECT id, device_id, wave FROM command_run_devices WHERE run_id = $1 ORDER BY wave, id`,
      [run.id]
    );

    const waves = [...new Set(items.map((i) => i.wave))].sort((a, b) => a - b);
    let halted = false;

    for (const wave of waves) {
      if (this.cancelRequested || halted) break;
      const inWave = items.filter((i) => i.wave === wave);

      // Devices inside a wave run together; waves themselves are strictly
      // sequential. That is what gives the operator a decision point.
      const results = await Promise.all(inWave.map((item) => this.runOne(run, item)));

      if (run.halt_on_failure && results.some((ok) => !ok)) {
        halted = true;
        console.warn(`[Command] run #${run.id}: halting after failures in wave ${wave}`);
      }
    }

    // Anything not reached is skipped, not failed — it never ran.
    await query(
      `UPDATE command_run_devices SET status='skipped', finished_at=NOW()
        WHERE run_id=$1 AND status='pending'`, [run.id]);

    const status = this.cancelRequested ? 'cancelled' : halted ? 'halted' : 'completed';
    await query(`UPDATE command_runs SET status=$2, finished_at=NOW() WHERE id=$1`, [run.id, status]);
    console.log(`[Command] run #${run.id} ${status}`);
  }

  /** Returns true when the device succeeded. */
  private async runOne(run: RunRow, item: RunDeviceRow): Promise<boolean> {
    const device = await queryOne<DeviceRow>(
      `SELECT id, name, ip_address, api_port, api_username, api_password_encrypted,
              ssh_port, ssh_username, ssh_password_encrypted
         FROM devices WHERE id = $1`,
      [item.device_id]
    );
    if (!device) {
      await this.finish(item.id, 'failed', null, 'Device no longer exists');
      return false;
    }

    await query(
      `UPDATE command_run_devices SET status='running', started_at=NOW(), guarded=$2 WHERE id=$1`,
      [item.id, run.use_change_guard]
    );

    const execute = async () => {
      const { output } = await runSshCommand(device, run.command);
      // RouterOS reports most errors in the text rather than an exit code, so an
      // unread output is an unnoticed failure.
      if (looksLikeFailure(output)) throw new Error(output.slice(0, 500));
      return output;
    };

    try {
      if (!run.use_change_guard) {
        const output = await execute();
        await this.finish(item.id, 'success', output, null);
        return true;
      }

      const outcome = await withSafeApply(device, {
        kind: 'command.bulk',
        summary: `Bulk command: ${run.command.slice(0, 80)}`,
      }, execute);

      if (outcome.autoReverting) {
        // The device stopped answering and is restoring itself. That is the
        // guard working, and it must be reported as loudly as a failure.
        await this.finish(
          item.id, 'reverted', outcome.result ?? null,
          'Device stopped responding after the command and is restoring itself.',
          true
        );
        return false;
      }

      await this.finish(item.id, 'success', outcome.result ?? null,
        outcome.unprotectedReason ? `Ran unprotected: ${outcome.unprotectedReason}` : null);
      return true;
    } catch (e) {
      await this.finish(item.id, 'failed', null, (e as Error).message);
      return false;
    }
  }

  private async finish(
    id: number, status: string, output: string | null, error: string | null, reverted = false,
  ): Promise<void> {
    await query(
      `UPDATE command_run_devices
          SET status=$2, output=$3, error=$4, auto_reverted=$5, finished_at=NOW()
        WHERE id=$1`,
      [id, status, output, error, reverted]
    );
  }
}

export const commandRunner = new CommandRunner();
