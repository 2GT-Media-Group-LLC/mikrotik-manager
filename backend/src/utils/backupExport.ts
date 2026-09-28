/**
 * Which export a backup runs, and whether the result holds secrets (#172).
 *
 * RouterOS v7 leaves passwords and keys (Wi-Fi keys, PPP/VPN secrets,
 * WireGuard private keys, SNMP communities) out of /export unless asked with
 * show-sensitive, so a backup could not restore a device to its exact state.
 * Including them is opt-in (setting backup_include_secrets), and a backup that
 * holds them is encrypted on disk and viewable only by admins.
 *
 * RouterOS v6 is the other way round: its /export includes secrets unless
 * told `hide-sensitive`. So v6 uses hide-sensitive when secrets were not asked
 * for, and the plain export (which carries them) when they were. Previously a
 * v6 export always carried them, and since Config History snapshots are stored
 * as text and shown to every user, a viewer could read a v6 device's passwords.
 *
 * An unknown version (the device has not been read yet) could be either, so
 * its export is treated as holding secrets: encrypted, admin-only, and never
 * used as a Config History snapshot.
 */

export interface ExportPlan {
  command: string;
  containsSecrets: boolean;
}

export function isRouterOs6(version: string | null | undefined): boolean {
  return /^6\./.test((version ?? '').trim());
}

export function exportPlan(version: string | null | undefined, includeSecrets: boolean): ExportPlan {
  if (isRouterOs6(version)) {
    return includeSecrets
      ? { command: '/export compact', containsSecrets: true }
      : { command: '/export compact hide-sensitive', containsSecrets: false };
  }
  // Works on both versions; on v6 it carries secrets, so assume it does.
  if (!(version ?? '').trim()) return { command: '/export compact', containsSecrets: true };
  return includeSecrets
    ? { command: '/export compact show-sensitive', containsSecrets: true }
    : { command: '/export compact', containsSecrets: false };
}
