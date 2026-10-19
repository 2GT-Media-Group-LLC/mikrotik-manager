/**
 * RoMON across the fleet (#311).
 *
 * RoMON gives WinBox and SSH a way into a router over layer 2 when its IP
 * path is broken: the far side of a wireless link, a bad route, a firewall
 * mistake. It only helps if it was turned on beforehand, and technicians
 * forget. So a RoMON setting can be kept per site or per group (one customer's
 * RoMON network usually spans its sites), with a fleet default behind both:
 * keep RoMON on, and the secret devices use. The security checks flag devices
 * that differ, and a fix applies the setting; nothing changes by itself.
 *
 * The secret is stored encrypted like device passwords and never sent back to
 * the browser. A device's own secrets are read only to compare, never stored.
 */
import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';

export interface RomonSetting {
  /** Keep RoMON switched on. */
  enabled: boolean;
  /** The secret devices should use; null leaves their secrets as they are. */
  secret: string | null;
  /** Where the setting came from, for the check's wording. */
  source: { scope: 'site' | 'group' | 'fleet'; name: string | null };
}

interface Row { id: number; site_id: number | null; group_id: number | null; enabled: boolean; secret_encrypted: string | null }

/**
 * The setting that applies to a device in `siteId`: its site's, else its
 * group's, else the fleet default; null when none is set (RoMON unmanaged).
 */
export async function romonSettingFor(siteId: number | null): Promise<RomonSetting | null> {
  const site = siteId == null ? null : await queryOne<{ name: string; group_id: number | null; group_name: string | null }>(
    `SELECT s.name, s.group_id, g.name AS group_name FROM sites s LEFT JOIN site_groups g ON g.id = s.group_id WHERE s.id = $1`, [siteId]);
  const rows = await query<Row>(
    `SELECT id, site_id, group_id, enabled, secret_encrypted FROM romon_settings
      WHERE (site_id IS NULL AND group_id IS NULL)
         OR site_id = $1 OR ($2::int IS NOT NULL AND group_id = $2)`, [siteId, site?.group_id ?? null]);
  const pick = rows.find((r) => r.site_id != null && r.site_id === siteId)
    ?? rows.find((r) => r.group_id != null && r.group_id === site?.group_id)
    ?? rows.find((r) => r.site_id == null && r.group_id == null);
  if (!pick) return null;
  let secret: string | null = null;
  if (pick.secret_encrypted) {
    try { secret = decrypt(pick.secret_encrypted); } catch { secret = null; }
  }
  return {
    enabled: pick.enabled,
    secret,
    source: pick.site_id != null ? { scope: 'site', name: site?.name ?? null }
      : pick.group_id != null ? { scope: 'group', name: site?.group_name ?? null }
      : { scope: 'fleet', name: null },
  };
}

/** The secret a device sends with: the first of its list (RouterOS hashes with that one). */
export function sendingSecret(secrets: string | undefined): string | undefined {
  if (secrets === undefined) return undefined;
  return secrets.split(',')[0] ?? '';
}

export interface RomonCheck {
  id: 'romon-off' | 'romon-secret';
  severity: 'medium' | 'low';
  title: string;
  detail: string;
  fix: 'romon';
}

/**
 * What a device's RoMON state (its /tool/romon row) says against the setting.
 * The secret is compared only when the device shows it: an API user without
 * the "sensitive" policy doesn't see secrets, and saying they differ would be
 * a guess.
 */
export function romonChecks(row: Record<string, string> | null, setting: RomonSetting | null): RomonCheck[] {
  if (!setting || !row) return [];
  const where = setting.source.scope === 'fleet' ? 'the fleet default'
    : `${setting.source.scope === 'site' ? 'site' : 'group'} ${setting.source.name ?? ''}`.trim();
  const on = row['enabled'] === 'true' || row['enabled'] === 'yes';
  if (setting.enabled && !on) {
    return [{
      id: 'romon-off', severity: 'medium', fix: 'romon',
      title: 'RoMON is off',
      detail: `RoMON is a way into this device over layer 2 when its IP path fails, and ${where} expects it on. `
        + `Turning it on${setting.secret != null ? ' with the secret set there' : ''} changes nothing else.`,
    }];
  }
  if (on && setting.secret != null) {
    const device = sendingSecret(row['secrets']);
    if (device !== undefined && device !== setting.secret) {
      return [{
        id: 'romon-secret', severity: 'low', fix: 'romon',
        title: 'RoMON secret differs from its site’s',
        detail: `RoMON is on, but with a different secret from ${where}, so it isn't on the same RoMON network as `
          + 'the devices around it. Applying the setting sets the secret.',
      }];
    }
  }
  return [];
}

/** The /tool/romon/set parameters that apply a setting. */
export function romonSetParams(setting: RomonSetting): Record<string, string> {
  return {
    enabled: setting.enabled ? 'yes' : 'no',
    ...(setting.secret != null ? { secrets: setting.secret } : {}),
  };
}

// ─── Settings storage ───────────────────────────────────────────────────────

export interface RomonSettingRow {
  scope: 'fleet' | 'group' | 'site';
  id: number | null;
  name: string | null;
  enabled: boolean;
  has_secret: boolean;
}

/** Every stored setting, never the secrets themselves. */
export async function listRomonSettings(): Promise<RomonSettingRow[]> {
  const rows = await query<{ site_id: number | null; group_id: number | null; enabled: boolean; has_secret: boolean; site_name: string | null; group_name: string | null }>(
    `SELECT r.site_id, r.group_id, r.enabled, (r.secret_encrypted IS NOT NULL) AS has_secret,
            s.name AS site_name, g.name AS group_name
       FROM romon_settings r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN site_groups g ON g.id = r.group_id
      ORDER BY (r.site_id IS NULL AND r.group_id IS NULL) DESC, g.name, s.name`);
  return rows.map((r) => ({
    scope: r.site_id != null ? 'site' : r.group_id != null ? 'group' : 'fleet',
    id: r.site_id ?? r.group_id ?? null,
    name: r.site_name ?? r.group_name ?? null,
    enabled: r.enabled,
    has_secret: r.has_secret,
  }));
}

/**
 * Save a setting. `secret`: undefined keeps the stored one, null removes it
 * (devices' secrets are then left alone), a string sets it.
 */
export async function saveRomonSetting(scope: 'fleet' | 'group' | 'site', id: number | null, enabled: boolean, secret: string | null | undefined): Promise<void> {
  const where = scope === 'fleet' ? 'site_id IS NULL AND group_id IS NULL' : scope === 'site' ? 'site_id = $1' : 'group_id = $1';
  const params = scope === 'fleet' ? [] : [id];
  const existing = await queryOne<{ id: number }>(`SELECT id FROM romon_settings WHERE ${where}`, params);
  const enc = secret === undefined ? undefined : secret === null ? null : encrypt(secret);
  if (existing) {
    await query(
      `UPDATE romon_settings SET enabled = $2, secret_encrypted = CASE WHEN $3::boolean THEN $4 ELSE secret_encrypted END, updated_at = NOW()
        WHERE id = $1`, [existing.id, enabled, enc !== undefined, enc ?? null]);
  } else {
    await query(`INSERT INTO romon_settings (site_id, group_id, enabled, secret_encrypted) VALUES ($1, $2, $3, $4)`,
      [scope === 'site' ? id : null, scope === 'group' ? id : null, enabled, enc ?? null]);
  }
}

export async function deleteRomonSetting(scope: 'fleet' | 'group' | 'site', id: number | null): Promise<void> {
  const where = scope === 'fleet' ? 'site_id IS NULL AND group_id IS NULL' : scope === 'site' ? 'site_id = $1' : 'group_id = $1';
  await query(`DELETE FROM romon_settings WHERE ${where}`, scope === 'fleet' ? [] : [id]);
}
