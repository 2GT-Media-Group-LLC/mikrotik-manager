/**
 * Recovering runs that a manager restart interrupted (issue #140).
 *
 * Both the firmware orchestrator and the command runner track the active run in
 * memory. If the process stops mid-run — a crash, an OOM kill, or an operator
 * pulling a new image — that state dies with it. The database row stays
 * `running` for ever, devices it never reached stay `pending`, and nothing is
 * logged, because the process that would have logged it is gone.
 *
 * The reporter's words were "didn't try to update it at all, silently. There is
 * no logs, nothing." That is exactly this.
 *
 * It compounds: an unfinished run also blocks its devices from being included in
 * a new one, which is right for a run that is genuinely in progress and wrong
 * for one that can never finish. A transient interruption became a device that
 * could not be upgraded again.
 *
 * Nothing here resumes a run. A device may have been mid-reboot when the process
 * died, and picking a firmware upgrade back up from an unknown state is how
 * hardware gets bricked. The job is to convert silence into an accurate,
 * visible outcome and release the devices.
 */

/** Device-level states that mean work had actually begun. */
const IN_FLIGHT = new Set([
  'running', 'backing_up', 'upgrading', 'rebooting', 'verifying',
]);

export interface InterruptedOutcome {
  status: 'skipped' | 'failed';
  error: string;
}

/**
 * What to record for one device of an interrupted run.
 *
 * The distinction matters to whoever reads it afterwards. A device that was
 * never reached needs nothing but a re-run. A device that was mid-upgrade has an
 * unknown state and should be looked at before anything else is done to it —
 * calling both "skipped" would hide that difference.
 */
export function interruptedOutcome(deviceStatus: string): InterruptedOutcome | null {
  if (deviceStatus === 'pending') {
    return {
      status: 'skipped',
      error: 'Not reached — the run was interrupted when the manager restarted.',
    };
  }
  if (IN_FLIGHT.has(deviceStatus)) {
    return {
      status: 'failed',
      error:
        'Interrupted when the manager restarted, while this device was being worked on. ' +
        'Its actual state is unknown — check the device before re-running.',
    };
  }
  // success, failed, skipped: already finished, leave alone.
  return null;
}

/** The note recorded against the run itself. */
export const INTERRUPTED_RUN_ERROR =
  'Interrupted when the manager restarted. No devices were left in progress; ' +
  're-run it to continue.';
