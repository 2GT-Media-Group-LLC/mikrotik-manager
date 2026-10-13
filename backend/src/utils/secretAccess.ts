import type { Request } from 'express';
import { secretNames, missingSecrets } from '../services/commandSecrets';
import { isSiteScoped } from '../middleware/auth';

/**
 * Whether a command's {{secret:name}} references may be used by this account
 * (#259): only a fleet admin, since a command can print a secret in pieces,
 * and only names that exist. Null when it may.
 */
export async function refuseSecrets(req: Request, command: string | null | undefined): Promise<{ status: number; error: string } | null> {
  if (!command || secretNames(command).length === 0) return null;
  if (req.user?.role !== 'admin' || isSiteScoped(req.user)) {
    return { status: 403, error: 'Only a fleet admin can run commands that use secrets ({{secret:…}}).' };
  }
  const missing = await missingSecrets(command);
  if (missing.length) return { status: 400, error: `Secret${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} under Templates → Secrets.` };
  return null;
}
