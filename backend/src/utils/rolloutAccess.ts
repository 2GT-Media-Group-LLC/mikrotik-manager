import { devicesDenied } from './siteAccess';
import { loadSiteRoles } from './siteRoles';
import { query, queryOne } from '../config/database';
import { highestRole, type AuthPayload } from '../middleware/auth';

/**
 * Why this account may not start this rollout, or null. Post-upgrade commands
 * run over SSH as each router's admin login, so a rollout with them needs admin
 * on every device, as creating one does (GHSA-fv5m-vfmw-8h9v); any other needs
 * operator on every device. Checked on a manual start and again when a
 * scheduled rollout comes due, against its creator (GHSA-mcr6-fpx6-h5p9).
 */
export async function rolloutRefusal(user: AuthPayload, deviceIds: number[], hasPostCommand: boolean): Promise<string | null> {
  if (hasPostCommand) {
    return (await devicesDenied(user, deviceIds, 'admin')).length > 0
      ? 'Post-upgrade commands need admin access to every device in the rollout.'
      : null;
  }
  return (await devicesDenied(user, deviceIds, 'operator')).length > 0
    ? 'Starting this rollout needs operator access to every device in it.'
    : null;
}

/**
 * Why a scheduled rollout that has come due may not start as its creator, or
 * null. The creator is checked as they are now: an operator who scheduled one
 * and then lost the site, or whose devices moved away, no longer upgrades them
 * (GHSA-mcr6-fpx6-h5p9). A rollout from before creators were recorded has none
 * and runs as it always did; a creator since removed stops it.
 */
export async function scheduledRolloutRefusal(rolloutId: number): Promise<string | null> {
  const r = await queryOne<{ created_by_user_id: number | null; post_command: string | null }>(
    `SELECT created_by_user_id, post_command FROM firmware_rollouts WHERE id = $1`, [rolloutId]);
  if (!r || r.created_by_user_id == null) return null;
  const u = await queryOne<{ id: number; username: string; role: string }>(
    `SELECT id, username, role FROM users WHERE id = $1`, [r.created_by_user_id]);
  if (!u) return 'The account that scheduled this rollout was removed.';
  const siteRoles = await loadSiteRoles(u.id);
  const user: AuthPayload = {
    userId: u.id, username: u.username,
    role: siteRoles ? highestRole(Object.values(siteRoles)) : u.role,
    ...(siteRoles ? { siteRoles } : {}),
  };
  const devices = await query<{ device_id: number }>(
    `SELECT device_id FROM firmware_rollout_devices WHERE rollout_id = $1`, [rolloutId]);
  const refusal = await rolloutRefusal(user, devices.map((d) => d.device_id), !!r.post_command);
  return refusal ? `${u.username} scheduled it and no longer can: ${refusal}` : null;
}
