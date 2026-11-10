/**
 * RouterOS's "not enough permissions (9)" means the user the manager logs in
 * as lacks a policy the command needs, usually because it's in the `write`
 * group (#417: a v6 router refused part of the API-SSL switch). Shown bare it
 * says nothing about what to do, so it's explained, with the step that was
 * refused when known.
 */

/** Mark an error with the step that was running, unless an inner step already did. */
export async function during<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object' && !(err as { during?: string }).during) {
      (err as { during?: string }).during = step;
    }
    throw err;
  }
}

export const isPermissionError = (err: unknown): boolean =>
  /not enough permissions/i.test((err as Error)?.message ?? String(err));

/** The explanation for a refused step, or null when `err` isn't a permission refusal. */
export function permissionProblem(err: unknown, username: string | null | undefined): string | null {
  if (!isPermissionError(err)) return null;
  const step = (err as { during?: string }).during;
  const user = username?.trim() || 'the manager’s user';
  return `RouterOS refused ${step ? `${step} ` : ''}with "not enough permissions": ${user}, the user the manager logs in as, `
    + `lacks a right this needs. Put it in the full group (/user set [find name="${user}"] group=full), or give its group the missing policies.`;
}
