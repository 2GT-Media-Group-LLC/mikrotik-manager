import { pool } from '../config/database';
import bcrypt from 'bcryptjs';

const MIGRATION_SQL = `
-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Devices
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  api_port INTEGER NOT NULL DEFAULT 8728,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  api_username VARCHAR(50) NOT NULL,
  api_password_encrypted TEXT NOT NULL,
  ssh_username VARCHAR(50),
  ssh_password_encrypted TEXT,
  model VARCHAR(100),
  serial_number VARCHAR(50),
  firmware_version VARCHAR(50),
  ros_version VARCHAR(20),
  device_type VARCHAR(20) DEFAULT 'router',
  status VARCHAR(20) DEFAULT 'unknown',
  last_seen TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device full config snapshots
CREATE TABLE IF NOT EXISTS device_configs (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  config_json JSONB NOT NULL,
  collected_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_configs_device ON device_configs(device_id, collected_at DESC);

-- Network interfaces
CREATE TABLE IF NOT EXISTS interfaces (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  type VARCHAR(30),
  mac_address VARCHAR(17),
  mtu INTEGER,
  running BOOLEAN DEFAULT FALSE,
  disabled BOOLEAN DEFAULT FALSE,
  comment TEXT,
  speed VARCHAR(20),
  full_duplex BOOLEAN,
  config_json JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, name)
);

-- VLANs
CREATE TABLE IF NOT EXISTS vlans (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  vlan_id INTEGER NOT NULL,
  name VARCHAR(100),
  bridge VARCHAR(50),
  tagged_ports TEXT[],
  untagged_ports TEXT[],
  config_json JSONB,
  UNIQUE(device_id, vlan_id)
);

-- Bridge VLAN table entries (for switch port VLAN mapping)
CREATE TABLE IF NOT EXISTS bridge_vlan_entries (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  bridge VARCHAR(50) NOT NULL,
  port VARCHAR(50) NOT NULL,
  vlan_ids TEXT[],
  pvid INTEGER,
  tagged BOOLEAN DEFAULT FALSE,
  config_json JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, bridge, port)
);

-- Network clients (ARP/DHCP/wireless leases)
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  mac_address VARCHAR(17) NOT NULL,
  hostname VARCHAR(255),
  ip_address VARCHAR(45),
  interface_name VARCHAR(50),
  tx_bytes BIGINT DEFAULT 0,
  rx_bytes BIGINT DEFAULT 0,
  signal_strength INTEGER,
  comment TEXT,
  client_type VARCHAR(20) DEFAULT 'wired',
  active BOOLEAN DEFAULT FALSE,
  last_seen TIMESTAMPTZ,
  UNIQUE(device_id, mac_address)
);
CREATE INDEX IF NOT EXISTS idx_clients_active ON clients(active, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_clients_mac ON clients(mac_address);

-- Events and alerts
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  topic VARCHAR(100),
  message TEXT NOT NULL,
  raw_json JSONB
);
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity, event_time DESC);

-- Backups
CREATE TABLE IF NOT EXISTS backups (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  size_bytes INTEGER,
  backup_type VARCHAR(20) DEFAULT 'manual',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Topology links (discovered via LLDP/CDP/neighbor)
CREATE TABLE IF NOT EXISTS topology_links (
  id SERIAL PRIMARY KEY,
  from_device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  from_interface VARCHAR(50),
  to_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  to_interface VARCHAR(50),
  neighbor_address VARCHAR(45),
  neighbor_identity VARCHAR(255),
  neighbor_platform VARCHAR(255),
  link_type VARCHAR(20) DEFAULT 'lldp',
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_device_id, from_interface)
);

-- Application settings
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Incremental schema updates
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vendor VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vlan_id INTEGER;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS custom_name VARCHAR(255);
-- first_seen: when this client was first discovered ("connected since"); set once, preserved across polls
ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ;
UPDATE clients SET first_seen = last_seen WHERE first_seen IS NULL;
-- custom_category: user override of the fingerprinted device category
ALTER TABLE clients ADD COLUMN IF NOT EXISTS custom_category VARCHAR(30);

-- Firmware orchestration: staged fleet upgrades in waves
CREATE TABLE IF NOT EXISTS firmware_rollouts (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|cancelled
  halt_on_failure BOOLEAN NOT NULL DEFAULT TRUE,
  pre_backup      BOOLEAN NOT NULL DEFAULT TRUE,
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS firmware_rollout_devices (
  id           SERIAL PRIMARY KEY,
  rollout_id   INTEGER NOT NULL REFERENCES firmware_rollouts(id) ON DELETE CASCADE,
  device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  wave         INTEGER NOT NULL DEFAULT 1,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|backing_up|upgrading|rebooting|verifying|success|failed|skipped
  from_version VARCHAR(30),
  to_version   VARCHAR(30),
  error        TEXT,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fw_rollout_devices ON firmware_rollout_devices(rollout_id, wave, id);

-- Platform & automation: scoped API tokens, outbound webhooks, scheduled reports
CREATE TABLE IF NOT EXISTS api_tokens (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,
  prefix       VARCHAR(12) NOT NULL,
  scope        VARCHAR(10) NOT NULL DEFAULT 'read', -- read|write
  created_by   VARCHAR(50),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS webhooks (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  url           TEXT NOT NULL,
  secret        VARCHAR(128),
  events        TEXT[] NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_status   INTEGER,
  last_fired_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS report_schedules (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  frequency    VARCHAR(10) NOT NULL DEFAULT 'weekly', -- daily|weekly|monthly
  recipients   TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  next_run_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS log_id VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_device_log_id ON events(device_id, log_id);
ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS neighbor_mac VARCHAR(17);
ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS stp_role VARCHAR(20);
ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS stp_state VARCHAR(20);
ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS bridge_name VARCHAR(50);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_address TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_lat NUMERIC(10,7);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_lng NUMERIC(10,7);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS rack_name VARCHAR(100);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS rack_slot VARCHAR(20);
ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS neighbor_caps VARCHAR(255);
ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS discovered_by VARCHAR(50);
-- RouterOS can return a long comma-separated discovered-by list; 50 chars was too small.
ALTER TABLE topology_links ALTER COLUMN discovered_by TYPE VARCHAR(512);
-- Interface names from neighbor discovery can exceed 50 chars (long bridge/bond names).
ALTER TABLE topology_links ALTER COLUMN from_interface TYPE VARCHAR(512);
ALTER TABLE topology_links ALTER COLUMN to_interface TYPE VARCHAR(512);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_update_available BOOLEAN DEFAULT FALSE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS latest_ros_version VARCHAR(20);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS routerboard_upgrade_available BOOLEAN DEFAULT FALSE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS upgrade_firmware_version VARCHAR(20);

-- Config history / drift detection: each snapshot stores the canonical /export
-- .rsc text (config_text), deduped by content hash, and links to the restorable
-- backup that holds the same .rsc. The snapshot and its backup are one artifact,
-- so deleting the backup cascades to remove the snapshot (kept consistent).
ALTER TABLE device_configs ADD COLUMN IF NOT EXISTS config_hash VARCHAR(64);
ALTER TABLE device_configs ADD COLUMN IF NOT EXISTS change_summary TEXT;
ALTER TABLE device_configs ADD COLUMN IF NOT EXISTS config_text TEXT;
ALTER TABLE device_configs ADD COLUMN IF NOT EXISTS backup_id INTEGER REFERENCES backups(id) ON DELETE SET NULL;
-- Upgrade the backup_id FK from SET NULL to CASCADE so a snapshot and its backup
-- stay in lockstep (deleting the backup removes the now-unrestorable snapshot).
ALTER TABLE device_configs DROP CONSTRAINT IF EXISTS device_configs_backup_id_fkey;
ALTER TABLE device_configs ADD CONSTRAINT device_configs_backup_id_fkey
  FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE;

-- Cached IPv4/IPv6 addresses from /ip/address (per device) for topology resolution:
-- neighbors seen only by IP (CDP/MNDP) can be matched to managed devices even
-- when the address is not the device's management IP.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ip_addresses_jsonb JSONB;

-- Allow multiple neighbors per interface (one row per neighbor, not per port)
ALTER TABLE topology_links DROP CONSTRAINT IF EXISTS topology_links_from_device_id_from_interface_key;

-- Alert rules — one row per event type
CREATE TABLE IF NOT EXISTS alert_rules (
  event_type    VARCHAR(50) PRIMARY KEY,
  enabled       BOOLEAN     NOT NULL DEFAULT false,
  threshold     INTEGER,
  cooldown_min  INTEGER     NOT NULL DEFAULT 15,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Alert channels — email / Slack / Discord / Telegram
CREATE TABLE IF NOT EXISTS alert_channels (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  type        VARCHAR(20)  NOT NULL CHECK (type IN ('email','slack','discord','telegram','ntfy')),
  enabled     BOOLEAN      NOT NULL DEFAULT true,
  config      JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Alert send history
CREATE TABLE IF NOT EXISTS alert_history (
  id                  SERIAL PRIMARY KEY,
  event_type          VARCHAR(50) NOT NULL,
  device_id           INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  device_name         VARCHAR(255),
  message             TEXT NOT NULL,
  channels_notified   JSONB,
  sent_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_history_sent ON alert_history(sent_at DESC);

-- Wireless interfaces (radio hardware config + SSID settings)
CREATE TABLE IF NOT EXISTS wireless_interfaces (
  id                 SERIAL PRIMARY KEY,
  device_id          INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name               VARCHAR(50) NOT NULL,
  ssid               VARCHAR(100),
  mode               VARCHAR(30),
  band               VARCHAR(50),
  frequency          INTEGER,
  channel_width      VARCHAR(30),
  tx_power           INTEGER,
  tx_power_mode      VARCHAR(30),
  antenna_gain       INTEGER,
  country            VARCHAR(50),
  installation       VARCHAR(20) DEFAULT 'indoor',
  disabled           BOOLEAN DEFAULT FALSE,
  running            BOOLEAN DEFAULT FALSE,
  mac_address        VARCHAR(17),
  security_profile   VARCHAR(100),
  noise_floor        INTEGER,
  registered_clients INTEGER DEFAULT 0,
  config_json        JSONB,
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, name)
);

-- Spectral scan snapshots
CREATE TABLE IF NOT EXISTS spectral_scan_data (
  id             SERIAL PRIMARY KEY,
  device_id      INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  interface_name TEXT NOT NULL,
  scanned_at     TIMESTAMPTZ DEFAULT NOW(),
  data           JSONB NOT NULL,
  scan_type      TEXT DEFAULT 'scheduled'
);
CREATE INDEX IF NOT EXISTS idx_spectral_scan_device
  ON spectral_scan_data(device_id, interface_name, scanned_at DESC);

-- AP scan results (nearby access points discovered by wireless scan)
CREATE TABLE IF NOT EXISTS ap_scan_data (
  id         SERIAL PRIMARY KEY,
  device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  data       JSONB NOT NULL,
  scan_type  TEXT DEFAULT 'scheduled'
);
CREATE INDEX IF NOT EXISTS idx_ap_scan_device
  ON ap_scan_data(device_id, scanned_at DESC);

-- Device credential presets — reusable API/SSH credential sets, referenced
-- by name when adding or editing a managed device. Passwords are stored
-- encrypted at rest (same scheme as devices.api_password_encrypted) so the
-- plaintext never leaves the backend.
CREATE TABLE IF NOT EXISTS credential_presets (
  id                      SERIAL PRIMARY KEY,
  name                    VARCHAR(100) NOT NULL UNIQUE,
  api_username            VARCHAR(50)  NOT NULL,
  api_password_encrypted  TEXT         NOT NULL,
  api_port                INTEGER,
  ssh_username            VARCHAR(50),
  ssh_password_encrypted  TEXT,
  ssh_port                INTEGER,
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE credential_presets ADD COLUMN IF NOT EXISTS allow_operator_use BOOLEAN NOT NULL DEFAULT TRUE;

-- Maintenance windows — suppress alerts for planned downtime
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  device_ids     INTEGER[] NOT NULL DEFAULT '{}',
  start_at       TIMESTAMPTZ NOT NULL,
  end_at         TIMESTAMPTZ NOT NULL,
  recurring_cron VARCHAR(100),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_windows_active ON maintenance_windows(active, start_at, end_at);

-- Device tags
CREATE TABLE IF NOT EXISTS tags (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(50) NOT NULL UNIQUE,
  color      VARCHAR(20) NOT NULL DEFAULT '#6366f1',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_tags (
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_device_tags_tag ON device_tags(tag_id);

-- Audit log — records all write operations performed by authenticated users
CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER,
  username     VARCHAR(50),
  method       VARCHAR(10) NOT NULL,
  path         TEXT NOT NULL,
  entity_type  VARCHAR(50),
  entity_id    INTEGER,
  summary      TEXT,
  ip_address   VARCHAR(45),
  status_code  INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at DESC);

-- Device availability (offline/online outage tracking)
CREATE TABLE IF NOT EXISTS device_availability (
  id                  SERIAL PRIMARY KEY,
  device_id           INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  went_offline_at     TIMESTAMPTZ NOT NULL,
  came_back_online_at TIMESTAMPTZ,
  duration_seconds    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_availability_device ON device_availability(device_id, went_offline_at DESC);

-- Manual topology links — user-drawn connections for devices with no auto-discovery
CREATE TABLE IF NOT EXISTS manual_topology_links (
  id               SERIAL PRIMARY KEY,
  from_device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  to_device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  label            VARCHAR(100),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_device_id, to_device_id)
);
CREATE INDEX IF NOT EXISTS idx_manual_topology_links_from ON manual_topology_links(from_device_id);
CREATE INDEX IF NOT EXISTS idx_manual_topology_links_to   ON manual_topology_links(to_device_id);

-- Configuration templates (reusable config sets pushed to devices or groups)
CREATE TABLE IF NOT EXISTS config_templates (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(100) NOT NULL UNIQUE,
  description      TEXT,
  applies_to_type  VARCHAR(20),
  template_json    JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- TOTP two-factor authentication
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- OIDC / SSO identity mapping. Local users keep password_hash; SSO users are
-- keyed by (oidc_issuer, oidc_subject) and have a null password_hash.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_subject VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_issuer VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) NOT NULL DEFAULT 'local';
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc ON users (oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;

-- Per-client daily traffic rollups from the NetFlow collector. mac_address
-- also holds the pseudo-clients 'unknown' (unmapped local IPs) and 'other'
-- (clients folded by the top-N cardinality cap).
CREATE TABLE IF NOT EXISTS client_traffic_daily (
  mac_address    VARCHAR(17) NOT NULL,
  day            DATE        NOT NULL,
  upload_bytes   BIGINT      NOT NULL DEFAULT 0,
  download_bytes BIGINT      NOT NULL DEFAULT 0,
  app_breakdown  JSONB       NOT NULL DEFAULT '{}',
  PRIMARY KEY (mac_address, day)
);
CREATE INDEX IF NOT EXISTS idx_client_traffic_daily_day ON client_traffic_daily(day DESC);

-- Change Guard: in-flight and historical "safe apply" operations. A pending row
-- means a restore point + auto-revert scheduler are armed on the device; the
-- manager either commits (disarms) or leaves the device to restore itself.
CREATE TABLE IF NOT EXISTS device_change_guards (
  id             SERIAL PRIMARY KEY,
  device_id      INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token          VARCHAR(64) NOT NULL,
  mode           VARCHAR(10) NOT NULL DEFAULT 'binary',
  restore_point  VARCHAR(64),
  scheduler_name VARCHAR(64),
  status         VARCHAR(16) NOT NULL DEFAULT 'pending',
  change_kind    VARCHAR(64),
  change_summary TEXT,
  note           TEXT,
  user_id        INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ,
  committed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_change_guards_device ON device_change_guards(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_guards_pending ON device_change_guards(status, expires_at);

-- CAPsMAN support (github issue #94).
--
-- A CAPsMAN-managed AP holds none of its own wireless configuration, so reading
-- /interface/wifi/print on it yields blank SSID/security/band. Recording the
-- device's role, and marking which interfaces are provisioned rather than local,
-- lets the UI say "managed by CAPsMAN" instead of showing an AP that looks broken.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wifi_role VARCHAR(16);
ALTER TABLE wireless_interfaces ADD COLUMN IF NOT EXISTS managed_by_capsman BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wireless_interfaces ADD COLUMN IF NOT EXISTS radio_mac VARCHAR(17);
ALTER TABLE wireless_interfaces ADD COLUMN IF NOT EXISTS capsman_controller_mac VARCHAR(17);

-- Radios a controller manages, local and remote. matched_device_id is resolved by
-- radio MAC against the fleet's interface MACs; it stays NULL for a CAP that is not
-- itself a managed device, which is a legitimate state rather than an error.
CREATE TABLE IF NOT EXISTS capsman_radios (
  id                   SERIAL PRIMARY KEY,
  controller_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  radio_mac            VARCHAR(17) NOT NULL,
  interface_name       VARCHAR(64),
  local                BOOLEAN NOT NULL DEFAULT FALSE,
  hw_type              VARCHAR(64),
  current_channel      TEXT,
  remote_cap_name      VARCHAR(128),
  matched_device_id    INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  config_json          JSONB,
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(controller_device_id, radio_mac)
);
CREATE INDEX IF NOT EXISTS idx_capsman_radios_device ON capsman_radios(matched_device_id);

-- Named configurations and the provisioning rules that bind them to radios. Both
-- are read-only for now; editing them would push to every bound AP at once.
CREATE TABLE IF NOT EXISTS capsman_configurations (
  id                   SERIAL PRIMARY KEY,
  controller_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name                 VARCHAR(128) NOT NULL,
  ssid                 VARCHAR(128),
  mode                 VARCHAR(32),
  band                 VARCHAR(64),
  security             VARCHAR(128),
  authentication_types VARCHAR(128),
  config_json          JSONB,
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(controller_device_id, name)
);

CREATE TABLE IF NOT EXISTS capsman_provisioning (
  id                   SERIAL PRIMARY KEY,
  controller_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ros_id               VARCHAR(32) NOT NULL,
  action               VARCHAR(64),
  master_configuration VARCHAR(128),
  slave_configurations TEXT,
  radio_mac            VARCHAR(17),
  comment              TEXT,
  disabled             BOOLEAN NOT NULL DEFAULT FALSE,
  config_json          JSONB,
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(controller_device_id, ros_id)
);

-- CAPsMAN radio live state (issue #94 follow-up). current-channels from
-- /interface/wifi/radio is the list of channels the radio *supports* — kilobytes of
-- text — not the one it is operating on. The operating channel, link state, peer
-- counts and TX power come from /interface/wifi/monitor instead.
ALTER TABLE capsman_radios ADD COLUMN IF NOT EXISTS state VARCHAR(32);
ALTER TABLE capsman_radios ADD COLUMN IF NOT EXISTS registered_peers INTEGER;
ALTER TABLE capsman_radios ADD COLUMN IF NOT EXISTS authorized_peers INTEGER;
ALTER TABLE capsman_radios ADD COLUMN IF NOT EXISTS tx_power INTEGER;
-- Stored channel is now the operating channel; drop the capability lists already
-- collected so no one is left looking at two kilobytes of text.
UPDATE capsman_radios SET current_channel = NULL WHERE length(current_channel) > 64;

-- A CAP holds no local configuration, so its interface rows carry no SSID. The
-- controller does know it, on its own mirror of the CAP interface (#94).
ALTER TABLE capsman_radios ADD COLUMN IF NOT EXISTS ssid VARCHAR(128);

-- ntfy.sh notification channel (github issue #93). The channel type is a CHECK
-- constraint rather than a lookup table, so widening it means replacing it.
ALTER TABLE alert_channels DROP CONSTRAINT IF EXISTS alert_channels_type_check;
ALTER TABLE alert_channels ADD CONSTRAINT alert_channels_type_check
  CHECK (type IN ('email','slack','discord','telegram','ntfy'));

-- Change Guard ledger: committed_at used to be stamped for every terminal status,
-- so an abandoned or failed guard read as though the change had been kept. It now
-- means what it says, and resolved_at records when the guard finished either way.
ALTER TABLE device_change_guards ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
UPDATE device_change_guards
   SET resolved_at = COALESCE(resolved_at, committed_at)
 WHERE status <> 'pending' AND resolved_at IS NULL;
UPDATE device_change_guards SET committed_at = NULL WHERE status <> 'committed';

-- VLAN cache correctness.
--
-- The original key, UNIQUE(device_id, vlan_id), assumed a VID is unique per device.
-- It is not: RouterOS keys the bridge VLAN table on (bridge, vlan-ids), so the same
-- VID on two bridges collapsed onto one row and each poll overwrote the other. The
-- collector also stored only the first VID of a spec like "10-20"; it now expands
-- ranges into one row per VID and records the spec it came from in vlan_ids.
ALTER TABLE vlans ADD COLUMN IF NOT EXISTS vlan_ids TEXT;
ALTER TABLE vlans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
UPDATE vlans SET bridge = '' WHERE bridge IS NULL;
ALTER TABLE vlans ALTER COLUMN bridge SET DEFAULT '';
ALTER TABLE vlans ALTER COLUMN bridge SET NOT NULL;
ALTER TABLE vlans DROP CONSTRAINT IF EXISTS vlans_device_id_vlan_id_key;
-- Collapse rows the old key could not distinguish, keeping the most recent.
DELETE FROM vlans a USING vlans b
  WHERE a.id < b.id AND a.device_id = b.device_id AND a.bridge = b.bridge AND a.vlan_id = b.vlan_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vlans_device_bridge_vid ON vlans (device_id, bridge, vlan_id);

-- Per-port VLAN membership. vlan_ids was declared but never written and tagged
-- was hardcoded false, which left the port editor unable to tell a trunk from an
-- access port. Both are now derived from the bridge VLAN table.
ALTER TABLE bridge_vlan_entries ADD COLUMN IF NOT EXISTS tagged_vlan_ids TEXT[];
ALTER TABLE bridge_vlan_entries ADD COLUMN IF NOT EXISTS untagged_vlan_ids TEXT[];

-- Bridge VLAN filtering lived only inside interfaces.config_json, so nothing could
-- query for it. Null for non-bridge interfaces.
ALTER TABLE interfaces ADD COLUMN IF NOT EXISTS vlan_filtering BOOLEAN;

-- Config Health: standing audit findings, one row per (device, distinct problem).
-- Rows are refreshed in place so first_seen shows how long a problem has existed,
-- and findings absent from the latest scan are pruned.
CREATE TABLE IF NOT EXISTS device_config_findings (
  id           SERIAL PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  rule         VARCHAR(64)  NOT NULL,
  fingerprint  VARCHAR(160) NOT NULL,
  severity     VARCHAR(16)  NOT NULL,
  title        TEXT         NOT NULL,
  detail       TEXT         NOT NULL,
  remediation  TEXT,
  doc_url      TEXT,
  objects      TEXT[]       NOT NULL DEFAULT '{}',
  first_seen   TIMESTAMPTZ  DEFAULT NOW(),
  last_seen    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(device_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_config_findings_device ON device_config_findings(device_id, severity);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS config_health_checked_at TIMESTAMPTZ;

-- Wireless security profiles (WPA/WPA2/WPA3 config)
CREATE TABLE IF NOT EXISTS wireless_security_profiles (
  id                    SERIAL PRIMARY KEY,
  device_id             INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name                  VARCHAR(100) NOT NULL,
  mode                  VARCHAR(30) DEFAULT 'none',
  authentication_types  TEXT[] DEFAULT '{}',
  unicast_ciphers       TEXT[] DEFAULT '{}',
  group_ciphers         TEXT[] DEFAULT '{}',
  management_protection VARCHAR(20) DEFAULT 'disabled',
  config_json           JSONB,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, name)
);
`;

const DEFAULT_SETTINGS = [
  { key: 'polling_fast_interval', value: 30 },
  { key: 'polling_slow_interval', value: 300 },
  { key: 'polling_logs_interval', value: 60 },
  { key: 'retention_events_days', value: 30 },
  { key: 'backup_schedule_enabled', value: false },
  { key: 'backup_schedule_cron', value: '0 2 * * *' },
  { key: 'mac_scan_enabled', value: true },
  { key: 'mac_scan_interval', value: 300 },
  { key: 'reverse_dns_enabled', value: false },
  { key: 'retention_clients_days', value: 7 },
  { key: 'spectral_scan_enabled', value: false },
  { key: 'spectral_scan_interval_hours', value: 24 },
  { key: 'ap_scan_enabled', value: false },
  { key: 'ap_scan_interval_hours', value: 24 },
  { key: 'login_rate_limit_window_sec', value: 60 },
  { key: 'login_rate_limit_max', value: 10 },
  { key: 'config_snapshot_enabled', value: true },
  { key: 'config_snapshot_interval_min', value: 60 },
  { key: 'config_snapshot_retention', value: 30 },
  { key: 'netflow_enabled', value: false },
  { key: 'netflow_collector_address', value: '' },
  { key: 'netflow_collector_port', value: 2055 },
  { key: 'netflow_version', value: '9' },
  { key: 'netflow_active_timeout', value: '1m' },
  { key: 'netflow_inactive_timeout', value: '15s' },
  { key: 'netflow_topn_clients', value: 50 },
  { key: 'netflow_accept_unknown', value: true },
  { key: 'netflow_retention_days', value: 30 },
  { key: 'netflow_daily_retention_days', value: 365 },
  { key: 'change_guard_enabled', value: true },
  { key: 'change_guard_mode', value: 'binary' },
  { key: 'change_guard_timeout_sec', value: 120 },
  { key: 'config_health_enabled', value: true },
  { key: 'config_health_interval_min', value: 60 },
];

export async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_SQL);
    console.log('Schema created/verified');

    // Insert default settings
    for (const setting of DEFAULT_SETTINGS) {
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [setting.key, JSON.stringify(setting.value)]
      );
    }

    // Create default admin user if no users exist
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count, 10) === 0) {
      const hash = await bcrypt.hash('admin', 12);
      await client.query(
        `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)`,
        ['admin', hash, 'admin']
      );
      console.log('Default admin user created (username: admin, password: admin)');
      console.log('⚠️  Please change the default password after first login!');
    }

    console.log('Database migrations completed successfully');
  } finally {
    client.release();
  }
}

// Run directly if called as script
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
