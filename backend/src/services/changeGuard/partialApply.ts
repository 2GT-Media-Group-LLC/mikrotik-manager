import { RouterOSError, RouterOSTrapError } from '../mikrotik/RouterOSClient';

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
 * Only an answer from the device (a !trap) or a failure before anything was
 * sent proves a write changed nothing. Every other failure (timeout, dropped
 * connection, protocol error, !fatal) may have come after the write landed, so
 * it is treated as ambiguous by default.
 */
export function isAmbiguousWriteError(err: unknown): boolean {
  if (err instanceof RouterOSTrapError) return false;
  if (err instanceof RouterOSError && err.message === 'Not connected') return false;
  return true;
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
