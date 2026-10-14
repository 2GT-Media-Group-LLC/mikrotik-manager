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
