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
  type        VARCHAR(20)  NOT NULL CHECK (type IN ('email','slack','discord','telegram')),
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
