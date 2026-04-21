export type UserRole = 'admin' | 'operator' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: UserRole;
  created_at?: string;
}

export interface IpAddress {
  '.id': string;
  address: string;
  interface: string;
  network?: string;
  disabled?: string;
  invalid?: string;
  dynamic?: string;
  comment?: string;
}

export interface SystemConfig {
  identity: string;
  ntp: {
    enabled?: string;
    'primary-ntp'?: string;
    'secondary-ntp'?: string;
    [key: string]: string | undefined;
  };
  dns: {
    servers?: string;
    'allow-remote-requests'?: string;
    [key: string]: string | undefined;
  };
}

export interface PortVlanConfig {
  pvid?: number;
  tagged_vlans?: number[];
  untagged_vlans?: number[];
}

export type DeviceStatus = 'online' | 'offline' | 'unknown';
export type DeviceType = 'router' | 'switch' | 'wireless_ap' | 'other';

export interface Device {
  id: number;
  name: string;
  ip_address: string;
  api_port: number;
  api_username: string;
  ssh_port?: number;
  ssh_username?: string;
  model?: string;
  serial_number?: string;
  firmware_version?: string;
  ros_version?: string;
  latest_ros_version?: string;
  firmware_update_available?: boolean;
  device_type: DeviceType;
  status: DeviceStatus;
  last_seen?: string;
  notes?: string;
  location_address?: string;
  location_lat?: number;
  location_lng?: number;
  rack_name?: string;
  rack_slot?: string;
  created_at: string;
  updated_at?: string;
}

export interface Interface {
  id: number;
  device_id: number;
  name: string;
  type?: string;
  mac_address?: string;
  mtu?: number;
  running: boolean;
  disabled: boolean;
  comment?: string;
  speed?: string;
  full_duplex?: boolean;
  config_json?: Record<string, string>;
  updated_at?: string;
}

export interface Vlan {
  id: number;
  device_id: number;
  vlan_id: number;
  name?: string;
  bridge?: string;
  tagged_ports?: string[];
  untagged_ports?: string[];
}

export interface BridgeVlanEntry {
  device_id: number;
  bridge: string;
  port: string;
  pvid?: number;
  vlan_ids?: string[];
  tagged: boolean;
}

export interface SwitchPort extends Interface {
  bridgeInfo?: BridgeVlanEntry | null;
}

export interface PortMonitorData {
  // Link state
  status?: string;
  'auto-negotiation'?: string;
  rate?: string;
  'full-duplex'?: string;
  'tx-flow-control'?: string;
  'rx-flow-control'?: string;
  'fec-mode'?: string;
  // SFP
  'sfp-module-present'?: string;
  'sfp-type'?: string;
  'sfp-connector-type'?: string;
  'sfp-vendor-name'?: string;
  'sfp-vendor-part-number'?: string;
  'sfp-vendor-revision'?: string;
  'sfp-vendor-serial'?: string;
  'sfp-manufacturing-date'?: string;
  'sfp-wavelength'?: string;
  'sfp-temperature'?: string;
  'sfp-supply-voltage'?: string;
  'sfp-tx-bias-current'?: string;
  'sfp-tx-power'?: string;
  'sfp-rx-power'?: string;
  'sfp-link-length-50um'?: string;
  'sfp-link-length-62um'?: string;
  'sfp-link-length-copper'?: string;
  'sfp-link-length-multimode'?: string;
  'sfp-link-length-singlemode'?: string;
  [key: string]: string | undefined;
}

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface DeviceEvent {
  id: number;
  device_id?: number;
  device_name?: string;
  event_time: string;
  severity: EventSeverity;
  topic?: string;
  message: string;
}

export interface Client {
  id: number;
  device_id: number;
  device_name?: string;
  mac_address: string;
  custom_name?: string;
  hostname?: string;
  vendor?: string;
  ip_address?: string;
  interface_name?: string;
  vlan_id?: number;
  tx_bytes: number;
  rx_bytes: number;
  signal_strength?: number;
  client_type: 'wired' | 'wireless';
  active: boolean;
  last_seen?: string;
}

export interface Backup {
  id: number;
  device_id: number;
  device_name?: string;
  filename: string;
  size_bytes?: number;
  backup_type: 'manual' | 'scheduled';
  notes?: string;
  created_at: string;
}

export interface TopologyDevice {
  id: number;
  name: string;
  ip_address: string;
  model?: string;
  device_type: DeviceType;
  status: DeviceStatus;
  ros_version?: string;
  /** Cached /ip/address rows from the device (set by backend sync). */
  ip_addresses_jsonb?: { address: string; interface?: string; dynamic?: boolean }[];
}

export interface TopologyLink {
  id: number;
  from_device_id?: number;
  from_interface?: string;
  to_device_id?: number;
  to_interface?: string;
  neighbor_address?: string;
  neighbor_identity?: string;
  neighbor_platform?: string;
  neighbor_mac?: string;
  stp_role?: string;
  stp_state?: string;
  bridge_name?: string;
  neighbor_caps?: string;
  link_type?: string;
  discovered_by?: string;
  from_device_name?: string;
  to_device_name?: string;
  discovered_at: string;
}

export interface ExternalTopologyNode {
  id: string;
  name: string;
  address: string;
  platform: string;
  mac: string;
  caps?: string;
}

export interface MetricsSummary {
  devices: { total: number; online: number; offline: number };
  clients: { total: number; active: number };
  alerts: { critical: number; warning: number };
}

export interface TimeSeriesPoint {
  time: string;
  value: number;
  deviceId?: string;
}

export interface TrafficPoint {
  time: string;
  rx: number;
  tx: number;
}

export interface ResourcePoint {
  time: string;
  cpu_load?: number;
  memory_used?: number;
  memory_total?: number;
}

// ─── Wireless ─────────────────────────────────────────────────────────────────

export interface WirelessInterface {
  id: number;
  device_id: number;
  name: string;
  ssid?: string;
  mode?: string;
  band?: string;
  frequency?: number;
  channel_width?: string;
  tx_power?: number;
  tx_power_mode?: string;
  antenna_gain?: number;
  country?: string;
  installation?: string;
  disabled: boolean;
  running: boolean;
  mac_address?: string;
  security_profile?: string;
  noise_floor?: number;
  registered_clients: number;
  config_json?: Record<string, string>;
  updated_at?: string;
}

export interface WirelessSecurityProfile {
  id?: number;
  '.id'?: string;
  device_id?: number;
  name: string;
  mode: string;
  authentication_types?: string[];
  'authentication-types'?: string;
  unicast_ciphers?: string[];
  'unicast-ciphers'?: string;
  group_ciphers?: string[];
  'group-ciphers'?: string;
  management_protection?: string;
  'management-protection'?: string;
  config_json?: Record<string, string>;
}

export interface WirelessAP {
  id: number;
  name: string;
  ip_address: string;
  model?: string;
  status: string;
  last_seen?: string;
  ros_version?: string;
  rack_name?: string;
  rack_slot?: string;
  radio_count: number;
  client_count: number;
  ssid_count: number;
}

export interface WirelessMetricPoint {
  time: string;
  interface: string;
  ssid?: string;
  registered_clients?: number;
  noise_floor?: number;
}
