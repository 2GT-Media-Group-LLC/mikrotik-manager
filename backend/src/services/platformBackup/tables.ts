/**
 * What a platform backup holds.
 *
 * Configuration: how MikroTik Manager is set up, in dependency order (parents
 * first). These tables only reference each other, so a configuration restore
 * can replace them without touching history.
 *
 * Database: every table, except this server's own platform-backup setup
 * (NEVER_RESTORED below), which a restore leaves as it is.
 */
export const CONFIG_TABLES = [
  'site_groups',
  'sites',
  'users',
  'tags',
  'credential_presets',
  'devices',
  'device_ca',
  'managed_device_certs',
  'user_site_roles',
  'user_group_roles',
  'api_tokens',
  'device_tags',
  'device_ssh_keys',
  'device_identity_pins',
  'alert_channels',
  'alert_rules',
  'app_settings',
  'webhooks',
  'report_schedules',
  'maintenance_windows',
  'command_templates',
  'command_secrets',
  'config_templates',
  'firmware_mirrors',
  'firmware_mirror_clients',
  'lte_data_cap_rules',
  'security_check_suppressions',
  'insight_dismissals',
  'topology_nodes',
  'topology_positions',
  'topology_hand_links',
  'topology_hidden_links',
  'topology_neighbour_overrides',
  'topology_edge_anchors',
] as const;

/**
 * Never exported or restored: this server's platform-backup setup and list.
 * A full restore TRUNCATEs every other table, which Postgres refuses while a
 * table left alone has a foreign key into one of them, so these must never
 * reference another table.
 */
export const NEVER_RESTORED = new Set([
  'platform_backups',
  'platform_backup_destinations',
  'platform_backup_settings',
]);

/** app_settings rows that are state, not settings: kept as they are on restore. */
export const APP_SETTINGS_STATE_KEYS = new Set([
  'cve_feed_fetched_at',
  'cve_feed_last_error',
  'version_check_cache',
  'proxy_backfill_done',
  'proxy_sources_ready',
  'proxy_usage_ready',
]);
