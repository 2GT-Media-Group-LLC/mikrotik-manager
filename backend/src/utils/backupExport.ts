/**
 * Which export a backup runs, and whether the result holds secrets (#172).
 *
 * RouterOS v7 leaves passwords and keys (Wi-Fi keys, PPP/VPN secrets,
 * WireGuard private keys, SNMP communities) out of /export unless asked with
 * show-sensitive, so a backup could not restore a device to its exact state.
 * Including them is opt-in (setting backup_include_secrets), and a backup that
 * holds them is encrypted on disk and viewable only by admins.
 *
 * RouterOS v6 is the other way round: its /export includes secrets by default.
 * Its command is left unchanged (there is no v6 hardware here to verify
 * hide-sensitive on), but its backups are now marked as holding secrets, so
 * they get the same encryption and access rules instead of sitting in plain
 * text as before.
 *
 * Config snapshots (Config History) always use the plain v7 export: their text
 * is stored in the database and shown in diffs, where secrets must not appear.
 */

export interface ExportPlan {
  command: string;
  containsSecrets: boolean;
}

export function isRouterOs6(version: string | null | undefined): boolean {
  return /^6\./.test((version ?? '').trim());
}

export function exportPlan(version: string | null | undefined, includeSecrets: boolean): ExportPlan {
  if (isRouterOs6(version)) return { command: '/export compact', containsSecrets: true };
  return includeSecrets
    ? { command: '/export compact show-sensitive', containsSecrets: true }
    : { command: '/export compact', containsSecrets: false };
}
