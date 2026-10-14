/**
 * Errors for multi-step device writers that can fail midway.
 *
 * A writer that throws after its first successful write leaves the device in a
 * state that is neither the old configuration nor the requested one. Change
 * Guard must not "disarm because the device is still reachable" in that case:
 * the restore point is the only way back, so the writer marks the failure and
 * the guard leaves the revert armed.
 */
export class PartialApplyError extends Error {
  readonly partialApply = true;
}

export function isPartialApply(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { partialApply?: unknown }).partialApply === true;
}

/**
 * Thrown by withSafeApply, after the change failed part-way and the revert was
 * deliberately left armed. Carries the writer's own error for callers that
 * report on it (a restore keeps RouterOS's verdict).
 */
export class PartialApplyRevertError extends Error {
  constructor(message: string, readonly original: unknown, readonly revertAt: Date) {
    super(message, { cause: original });
  }
}

/**
 * A failed write whose reply never came back (timeout, dropped connection) may
 * well have landed on the device. Only a clear rejection proves nothing changed.
 */
export function isAmbiguousWriteError(err: unknown): boolean {
  return /timeout|timed out|closed|ECONN|EPIPE|reset|socket|disconnect/i.test((err as Error)?.message ?? '');
}

/**
 * The error a multi-step writer throws when a step fails: partial once anything
 * was written (or the failed write may have landed), a plain error otherwise, so
 * Change Guard disarms instead of reverting (and, in binary mode, rebooting) a
 * device nothing was written to.
 */
export function stepFailure(err: unknown, wrote: boolean, message = (err as Error)?.message ?? String(err)): Error {
  if (isPartialApply(err)) return err as Error;
  if (wrote || isAmbiguousWriteError(err)) return new PartialApplyError(message, { cause: err });
  return err instanceof Error && err.message === message ? err : new Error(message, { cause: err });
}
