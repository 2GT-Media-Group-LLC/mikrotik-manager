/**
 * The settings in force for one device (#261): global, then its site's
 * overrides, then its own.
 */
import { query, queryOne } from '../config/database';
import { cleanOverrides, resolveEffective, effectiveValues, type Effective, type Overrides } from '../utils/pollOverrides';

export async function globalSettings(): Promise<Record<string, unknown>> {
  const rows = await query<{ key: string; value: unknown }>(`SELECT key, value FROM app_settings`).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Overrides and effective values for a device, or null when it doesn't exist. */
export async function deviceSettings(deviceId: number): Promise<{
  device: Overrides; site: Overrides; siteId: number | null; siteName: string | null; effective: Effective;
  /** What each setting would be without this device's own overrides: its site's, or global. */
  inherited: Effective;
} | null> {
  const row = await queryOne<{ poll_overrides: unknown; site_id: number | null; site_overrides: unknown; site_name: string | null }>(
    `SELECT d.poll_overrides, d.site_id, s.poll_overrides AS site_overrides, s.name AS site_name
       FROM devices d LEFT JOIN sites s ON s.id = d.site_id WHERE d.id = $1`, [deviceId]);
  if (!row) return null;
  const device = cleanOverrides(row.poll_overrides);
  const site = cleanOverrides(row.site_overrides);
  const global = await globalSettings();
  return {
    device, site, siteId: row.site_id, siteName: row.site_name,
    effective: resolveEffective(global, site, device), inherited: resolveEffective(global, site, null),
  };
}

/** The effective values for a device, for the poller and backups. */
export async function deviceValues(deviceId: number) {
  const s = await deviceSettings(deviceId);
  return effectiveValues(await globalSettings(), s?.site ?? null, s?.device ?? null);
}
