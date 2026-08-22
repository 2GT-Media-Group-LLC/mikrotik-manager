import axios, { AxiosError } from 'axios';
import { useAuthStore } from '../store/authStore';
import type {
  Device,
  Interface,
  Vlan,
  Client,
  DeviceEvent,
  Backup,
  MetricsSummary,
  DeviceAvailability,
  TimeSeriesPoint,
  TrafficPoint,
  ResourcePoint,
  SwitchPort,
  SystemConfig,
  IpAddress,
  PortVlanConfig,
  PortMonitorData,
  ConfigSnapshotMeta,
  ConfigSnapshotFull,
  ConfigDiffResponse,
  ConfigCaptureResult,
  UserRole,
} from '../types';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  login: (username: string, password: string) =>
    api.post<{ token?: string; user?: import('../types').User; requires_totp?: boolean; totp_token?: string }>(
      '/auth/login',
      { username, password }
    ),
  totpVerify: (totp_token: string, code: string) =>
    api.post<{ token: string; user: import('../types').User }>('/auth/totp/verify', { totp_token, code }),
  totpSetup: (password: string) =>
    api.post<{ secret: string; uri: string; qr: string }>('/auth/totp/setup', { password }),
  totpConfirm: (code: string) =>
    api.post<{ ok: boolean }>('/auth/totp/confirm', { code }),
  totpDisable: (password: string) =>
    api.post<{ ok: boolean }>('/auth/totp/disable', { password }),
  totpStatus: () =>
    api.get<{ totp_enabled: boolean }>('/auth/totp/status'),
  me: () => api.get('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/password', { currentPassword, newPassword }),
  securityStatus: () =>
    api.get<{ warnings: string[] }>('/auth/security-status'),
  oidcStatus: () =>
    api.get<{ enabled: boolean; button_label: string }>('/auth/oidc/status'),
};

export interface OidcConfigView {
  enabled: boolean;
  issuer_url: string;
  client_id: string;
  has_secret: boolean;
  scopes: string;
  username_claim: string;
  email_claim: string;
  groups_claim: string;
  group_role_map: Record<string, UserRole>;
  default_role: UserRole;
  auto_provision: boolean;
  link_by_verified_email: boolean;
  allowed_email_domains: string[];
  button_label: string;
  public_base_url: string;
  redirect_uri: string;
}

export const oidcApi = {
  getConfig: () => api.get<OidcConfigView>('/auth/oidc/config'),
  updateConfig: (data: Partial<OidcConfigView> & { client_secret?: string }) =>
    api.put<OidcConfigView>('/auth/oidc/config', data),
  test: (issuer_url?: string) =>
    api.post<{ ok: boolean; issuer?: string; claims_supported?: string[]; error?: string }>(
      '/auth/oidc/test',
      { issuer_url }
    ),
};

// ─── Devices ──────────────────────────────────────────────────────────────────
export interface DiscoveredDevice {
  identity: string;
  address: string;
  mac_address: string;
  platform: string;
  discovered_at: string;
  seen_by: string;
  // When the neighbor matches a device that's already managed (by interface
  // MAC, primary IP, or system identity) the backend fills these in so the
  // UI can hide the row as a duplicate.
  duplicate_of_device_id: number | null;
  duplicate_of_device_name: string | null;
}

export interface DuplicateSerialDeviceInfo {
  id: number;
  name: string;
  ip_address: string;
  serial_number: string;
  model?: string;
  ros_version?: string;
}

export interface DuplicateSerialError {
  error: string;
  code: 'duplicate_serial';
  existing_device: DuplicateSerialDeviceInfo;
  candidate: {
    serial_number: string;
    identity: string;
    model?: string;
    ros_version?: string;
    ip_address: string;
  };
}

export interface BulkAddDeviceItem {
  name?: string;
  ip_address?: string;
  device_type?: string;
  notes?: string;
  credential_preset_id?: number;
  api_username?: string;
  api_password?: string;
  api_port?: number;
  ssh_username?: string;
  ssh_password?: string;
  ssh_port?: number;
}

export interface BulkAddJobResponse {
  job_id: string;
  total: number;
}

export interface BulkAddJobStatus {
  job_id: string;
  status?: string;
  total?: number;
  processed?: number;
  current_name?: string | null;
  results?: { ip: string; identity: string; ok: boolean; message: string }[];
  error?: string;
  [key: string]: unknown;
}

export interface SecurityCheck {
  id: string;
  severity: 'high' | 'medium' | 'low' | 'ok';
  title: string;
  detail: string;
  serviceId?: string;
  /** Operator judged this inapplicable — still shown, but excluded from the score. */
  suppressed?: boolean;
  suppressed_scope?: 'device' | 'fleet';
  suppressed_reason?: string | null;
}

export interface SecuritySuppression {
  id: number;
  check_id: string;
  device_id: number | null;
  device_name: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * A configuration RouterOS accepted but that does not work. Produced by the
 * standing Config Health audit, which encodes MikroTik's documented Layer2
 * misconfigurations plus the latent lockout cases.
 */
export interface ConfigFinding {
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  remediation: string | null;
  doc_url: string | null;
  objects: string[];
  first_seen: string | null;
  last_seen: string | null;
}

export interface ConfigHealthResponse {
  findings: ConfigFinding[];
  checked_at: string | null;
}

export const devicesApi = {
  list: () => api.get<Device[]>('/devices'),
  discovered: () => api.get<DiscoveredDevice[]>('/devices/discovered'),
  get: (id: number) => api.get<Device>(`/devices/${id}`),
  bulkAddEnqueue: (items: BulkAddDeviceItem[]) =>
    api.post<BulkAddJobResponse>('/devices/bulk-add/jobs', { items }),
  bulkAddStatus: (jobId: string) =>
    api.get<BulkAddJobStatus>(`/devices/bulk-add/jobs/${encodeURIComponent(jobId)}`),
  bulkAddCancel: (jobId: string) =>
    api.post<{ message: string }>(`/devices/bulk-add/jobs/${encodeURIComponent(jobId)}/cancel`),
  create: (
    data: (Partial<Device> & {
      api_password?: string;
      ssh_password?: string;
      credential_preset_id?: number;
      force_replace_existing_by_serial?: boolean;
      combine_with_device_id?: number;
    })
  ) => api.post<Device>('/devices', data),
  update: (
    id: number,
    data: Partial<Device> & { api_password?: string; ssh_password?: string; credential_preset_id?: number | null }
  ) => api.put<Device>(`/devices/${id}`, data),
  delete: (id: number) => api.delete(`/devices/${id}`),
  sync: (id: number) => api.post(`/devices/${id}/sync`, undefined, { timeout: 60_000 }),
  test: (id: number) => api.post<{ success: boolean; identity?: string; error?: string }>(`/devices/${id}/test`),
  getInterfaces: (id: number) => api.get<Interface[]>(`/devices/${id}/interfaces`),
  updateInterface: (id: number, name: string, data: Partial<Interface>) =>
    api.put(`/devices/${id}/interfaces/${encodeURIComponent(name)}`, data),
  getVlans: (id: number) => api.get<Vlan[]>(`/devices/${id}/vlans`),
  getPorts: (id: number) =>
    api.get<{ ports: SwitchPort[]; vlans: Vlan[] }>(`/devices/${id}/ports`),
  getRouting: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/routing`),
  getFirewall: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/firewall`),
  addFirewallRule: (id: number, data: Record<string, unknown>) =>
    api.post<Record<string, string>[]>(`/devices/${id}/firewall`, data),
  updateFirewallRule: (id: number, ruleId: string, data: Record<string, unknown>) =>
    api.put<Record<string, string>[]>(`/devices/${id}/firewall/${encodeURIComponent(ruleId)}`, data),
  deleteFirewallRule: (id: number, ruleId: string) =>
    api.delete(`/devices/${id}/firewall/${encodeURIComponent(ruleId)}`),
  getResources: (id: number) => api.get<Record<string, string>>(`/devices/${id}/resources`),
  configurePortVlan: (id: number, name: string, data: PortVlanConfig & { confirm_lockout?: boolean }) =>
    api.put(`/devices/${id}/ports/${encodeURIComponent(name)}/vlan`, data),
  getSystemConfig: (id: number) => api.get<SystemConfig>(`/devices/${id}/system-config`),
  updateSystemConfig: (id: number, data: Partial<{
    identity: string;
    ntp_enabled: boolean;
    ntp_primary: string;
    ntp_secondary: string;
    dns_servers: string;
    dns_allow_remote: boolean;
  }>) => api.put(`/devices/${id}/system-config`, data),
  getIpAddresses: (id: number) => api.get<IpAddress[]>(`/devices/${id}/ip-addresses`),
  addIpAddress: (id: number, data: { address: string; interface: string; confirm_lockout?: boolean }) =>
    api.post<IpAddress[]>(`/devices/${id}/ip-addresses`, data),
  removeIpAddress: (id: number, addrId: string, confirmLockout = false) =>
    api.delete(`/devices/${id}/ip-addresses/${encodeURIComponent(addrId)}`,
      confirmLockout ? { data: { confirm_lockout: true } } : undefined),
  checkUpdate: (id: number) =>
    api.post<Record<string, string>>(`/devices/${id}/check-update`),
  checkRouterboard: (id: number) =>
    api.post<{ currentFirmware: string; upgradeFirmware: string; upgradeAvailable: boolean }>(`/devices/${id}/check-routerboard`),
  installRouterboard: (id: number) => api.post(`/devices/${id}/install-routerboard`),
  getHardware: (id: number) =>
    api.get<{ health: Record<string, string>[]; disks: Record<string, string>[] }>(`/devices/${id}/hardware`),
  installUpdate: (id: number) => api.post(`/devices/${id}/install-update`),
  getClock: (id: number) => api.get<{ date: string; time: string; timezone: string }>(`/devices/${id}/clock`),
  setClock: (id: number, data: { date?: string; time?: string; timezone?: string }) =>
    api.put(`/devices/${id}/clock`, data),
  addRoute: (id: number, data: { dst_address: string; gateway: string; distance?: number; comment?: string; confirm_lockout?: boolean }) =>
    api.post(`/devices/${id}/routing`, data),
  deleteRoute: (id: number, routeId: string, confirmLockout = false) =>
    api.delete(`/devices/${id}/routing/${encodeURIComponent(routeId)}`,
      confirmLockout ? { data: { confirm_lockout: true } } : undefined),
  // confirm_lockout overrides a predicted-lockout refusal (HTTP 409) after the user
  // has seen and accepted the verdict.
  addVlan: (id: number, data: { bridge: string; vlan_id: number; tagged_ports?: string[]; untagged_ports?: string[]; confirm_lockout?: boolean }) =>
    api.post(`/devices/${id}/vlans`, data),
  updateVlan: (id: number, vlanDbId: number, data: { tagged_ports: string[]; untagged_ports: string[]; confirm_lockout?: boolean }) =>
    api.put(`/devices/${id}/vlans/${vlanDbId}`, data),
  deleteVlan: (id: number, vlanDbId: number, confirmLockout = false) =>
    api.delete(`/devices/${id}/vlans/${vlanDbId}`, confirmLockout ? { data: { confirm_lockout: true } } : undefined),
  copyVlans: (id: number, operations: Array<{ action: 'add' | 'update'; vlan_id: number; bridge: string; tagged_ports: string[]; untagged_ports: string[] }>) =>
    api.post<{ results: Array<{ vlan_id: number; action: string; success: boolean; error?: string }>; vlans: Vlan[] }>(`/devices/${id}/vlans/copy`, { operations }),
  reboot: (id: number) => api.post<{ message: string }>(`/devices/${id}/reboot`),
  getPortMonitor: (id: number, name: string) =>
    api.get<PortMonitorData>(`/devices/${id}/ports/${encodeURIComponent(name)}/monitor`),
  getPortClients: (id: number, name: string, all = false) =>
    api.get<import('../types').PortClientsResult>(`/devices/${id}/ports/${encodeURIComponent(name)}/clients`, { params: { all: all || undefined } }),
  createBond: (id: number, data: {
    name: string; mode: string; slaves: string[];
    lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number;
    confirm_lockout?: boolean;
  }) => api.post(`/devices/${id}/bonds`, data),
  updateBond: (id: number, bondName: string, data: {
    mode: string; slaves: string[];
    lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number;
  }) => api.put(`/devices/${id}/bonds/${encodeURIComponent(bondName)}`, data),
  deleteBond: (id: number, bondName: string, confirmLockout = false) =>
    api.delete(`/devices/${id}/bonds/${encodeURIComponent(bondName)}`,
      confirmLockout ? { data: { confirm_lockout: true } } : undefined),
  setBridgeVlanFiltering: (id: number, bridgeName: string, enabled: boolean, confirmLockout = false) =>
    api.put(`/devices/${id}/bridge/${encodeURIComponent(bridgeName)}/vlan-filtering`,
      { enabled, ...(confirmLockout ? { confirm_lockout: true } : {}) }),
  getNat: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/nat`),
  addNatRule: (id: number, data: Record<string, unknown>) =>
    api.post<Record<string, string>[]>(`/devices/${id}/nat`, data),
  updateNatRule: (id: number, ruleId: string, data: Record<string, unknown>) =>
    api.put<Record<string, string>[]>(`/devices/${id}/nat/${encodeURIComponent(ruleId)}`, data),
  deleteNatRule: (id: number, ruleId: string) =>
    api.delete(`/devices/${id}/nat/${encodeURIComponent(ruleId)}`),
  // Firewall: reorder + counters (order is decisive in RouterOS)
  moveFirewallRule: (id: number, ruleId: string, destination?: string) =>
    api.post<Record<string, string>[]>(`/devices/${id}/firewall/move`, { id: ruleId, destination }),
  resetFirewallCounters: (id: number) =>
    api.post<Record<string, string>[]>(`/devices/${id}/firewall/reset-counters`),
  moveNatRule: (id: number, ruleId: string, destination?: string) =>
    api.post<Record<string, string>[]>(`/devices/${id}/nat/move`, { id: ruleId, destination }),
  // Firewall address lists (reusable address objects)
  getAddressLists: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/address-lists`),
  addAddressListEntry: (id: number, data: { list: string; address: string; comment?: string; timeout?: string }) =>
    api.post<Record<string, string>[]>(`/devices/${id}/address-lists`, data),
  updateAddressListEntry: (id: number, entryId: string, data: Record<string, unknown>) =>
    api.put<Record<string, string>[]>(`/devices/${id}/address-lists/${encodeURIComponent(entryId)}`, data),
  removeAddressListEntry: (id: number, entryId: string) =>
    api.delete(`/devices/${id}/address-lists/${encodeURIComponent(entryId)}`),
  // Active connections (read-only)
  getConnections: (id: number, limit = 500) =>
    api.get<{ total: number; connections: Record<string, string>[]; tracking: Record<string, string> }>(`/devices/${id}/connections`, { params: { limit } }),
  // Simple queues (bandwidth control)
  getQueues: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/queues`),
  addQueue: (id: number, data: Record<string, unknown>) =>
    api.post<Record<string, string>[]>(`/devices/${id}/queues`, data),
  updateQueue: (id: number, queueId: string, data: Record<string, unknown>) =>
    api.put<Record<string, string>[]>(`/devices/${id}/queues/${encodeURIComponent(queueId)}`, data),
  removeQueue: (id: number, queueId: string) =>
    api.delete(`/devices/${id}/queues/${encodeURIComponent(queueId)}`),
  // IP services + security posture
  getServices: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/services`),
  setServiceDisabled: (id: number, serviceId: string, disabled: boolean, confirmLockout = false) =>
    api.put<Record<string, string>[]>(`/devices/${id}/services/${encodeURIComponent(serviceId)}`,
      { disabled, ...(confirmLockout ? { confirm_lockout: true } : {}) }),
  listSecuritySuppressions: () =>
    api.get<SecuritySuppression[]>('/devices/security/suppressions'),
  suppressSecurityCheck: (check_id: string, device_id: number | null, reason?: string) =>
    api.post('/devices/security/suppressions', { check_id, device_id, reason }),
  unsuppressSecurityCheck: (id: number) =>
    api.delete(`/devices/security/suppressions/${id}`),
  getSecurityPosture: (id: number) =>
    api.get<{ score: number; checks: SecurityCheck[] }>(`/devices/${id}/security-posture`),
  // Config Health — cached findings load instantly; the scan re-reads the device.
  getConfigHealth: (id: number) =>
    api.get<ConfigHealthResponse>(`/devices/${id}/config-health`),
  scanConfigHealth: (id: number) =>
    api.post<ConfigHealthResponse>(`/devices/${id}/config-health/scan`),
  patchLocation: (id: number, data: {
    location_address?: string | null;
    location_lat?: number | null;
    location_lng?: number | null;
    rack_name?: string | null;
    rack_slot?: string | null;
    notes?: string | null;
  }) => api.patch<Device>(`/devices/${id}/location`, data),
};

// ─── Credential Presets ──────────────────────────────────────────────────────
export interface CredentialPreset {
  id: number;
  name: string;
  api_username: string;
  api_port: number | null;
  ssh_username: string | null;
  ssh_port: number | null;
  notes: string | null;
  /** When false, only admins may select this preset in Add Device flows. */
  allow_operator_use: boolean;
  has_api_password: boolean;
  has_ssh_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface CredentialPresetInput {
  name?: string;
  api_username?: string;
  api_password?: string;
  api_port?: number | null;
  ssh_username?: string | null;
  ssh_password?: string | null;
  ssh_port?: number | null;
  notes?: string | null;
  clear_ssh_password?: boolean;
  allow_operator_use?: boolean;
}

export const credentialPresetsApi = {
  list: () => api.get<CredentialPreset[]>('/credential-presets'),
  create: (data: CredentialPresetInput) =>
    api.post<CredentialPreset>('/credential-presets', data),
  update: (id: number, data: CredentialPresetInput) =>
    api.put<CredentialPreset>(`/credential-presets/${id}`, data),
  delete: (id: number) => api.delete(`/credential-presets/${id}`),
};

// ─── Clients ──────────────────────────────────────────────────────────────────
export interface ClientDetail extends Client {
  device_type?: string;
  ssid?: string;
  vlan_name?: string;
  upstream_device_id?: number;
  upstream_interface?: string;
  upstream_device_name?: string;
  upstream_device_type?: string;
  upstream_device_ip?: string;
  comment?: string;
}

export interface PresencePoint { time: string; online: number; }
export interface TrafficPoint2 { time: string; tx_bytes: number; rx_bytes: number; }
export interface SignalPoint { time: string; signal_strength: number; }

export const clientsApi = {
  list: (params?: {
    deviceId?: number;
    active?: boolean;
    search?: string;
    client_type?: string;
    limit?: number;
    offset?: number;
    sort?: string;
    dir?: 'asc' | 'desc';
  }) =>
    api.get<{ clients: Client[]; total: number }>('/clients', { params }),
  get: (mac: string) => api.get<ClientDetail>(`/clients/${mac}`),
  getPresence: (mac: string, range = '24h') =>
    api.get<PresencePoint[]>(`/clients/${mac}/presence`, { params: { range } }),
  getTraffic: (mac: string, range = '24h') =>
    api.get<TrafficPoint2[]>(`/clients/${mac}/traffic`, { params: { range } }),
  getSignal: (mac: string, range = '24h') =>
    api.get<SignalPoint[]>(`/clients/${mac}/signal`, { params: { range } }),
  wol: (mac: string) => api.post<{ success: boolean; message: string }>(`/clients/${mac}/wol`),
  updateNotes: (mac: string, notes: string) =>
    api.put<Client>(`/clients/${mac}/notes`, { notes }),
  updateHostname: (mac: string, hostname: string) =>
    api.put<Client>(`/clients/${mac}/hostname`, { hostname }),
  updateCategory: (mac: string, category: string | null) =>
    api.put<Client>(`/clients/${encodeURIComponent(mac)}/category`, { category }),
  purgeStale: () => api.post<{ message: string; count: number }>('/clients/purge'),
};

// ─── Device Network Tools ─────────────────────────────────────────────────────
// Long timeout (120s) since traceroute/ip-scan can run for a while
const TOOL_TIMEOUT = 120_000;
export const deviceToolsApi = {
  ping: (id: number, body: { address: string; count?: number; interface?: string }) =>
    api.post<Record<string, string>[]>(`/devices/${id}/tools/ping`, body, { timeout: TOOL_TIMEOUT }),
  traceroute: (id: number, body: { address: string }) =>
    api.post<Record<string, string>[]>(`/devices/${id}/tools/traceroute`, body, { timeout: TOOL_TIMEOUT }),
  ipScan: (id: number, body: { addressRange: string; interface: string; rdns?: boolean }) =>
    api.post<Record<string, string>[]>(`/devices/${id}/tools/ip-scan`, body, { timeout: TOOL_TIMEOUT }),
  wol: (id: number, body: { mac: string; interface: string }) =>
    api.post<{ success: boolean; message: string }>(`/devices/${id}/tools/wol`, body, { timeout: TOOL_TIMEOUT }),
  capture: (id: number, body: { interface?: string; filter_ip?: string; duration?: number }) =>
    api.post(`/devices/${id}/tools/capture`, body, { timeout: 120_000, responseType: 'blob' }),
  btest: (id: number, body: { target_device_id?: number; address?: string; direction?: string; duration?: number; protocol?: string }) =>
    api.post<{ tx_mbps: number; rx_mbps: number; direction: string; protocol: string; duration: number; target_ip: string; raw: Record<string, string> | null }>(
      `/devices/${id}/tools/btest`, body, { timeout: 75_000 }
    ),
};

// ─── System ───────────────────────────────────────────────────────────────────
export const systemApi = {
  versionCheck: () =>
    api.get<{ current: string; latest: string | null; update_available: boolean }>('/system/version-check'),
};

// ─── Events ───────────────────────────────────────────────────────────────────
export const eventsApi = {
  list: (params?: {
    deviceId?: number;
    severity?: string;
    topic?: string;
    search?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }) =>
    api.get<{ events: DeviceEvent[]; total: number; criticalCount: number }>('/events', { params }),
  clear: (deviceId?: number) => api.delete('/events', { params: deviceId ? { deviceId } : {} }),
};

// ─── Backups ──────────────────────────────────────────────────────────────────
// ─── Guest WiFi (Hotspot) ───────────────────────────────────────────────────────
type HS = Record<string, string>;
export interface GuestWifiOverview {
  servers: HS[];
  profiles: HS[];
  userProfiles: HS[];
  userCount: number;
  activeCount: number;
  interfaces: { name: string; type: string }[];
}

export const guestWifiApi = {
  overview: (deviceId: number) =>
    api.get<GuestWifiOverview>('/guest-wifi/overview', { params: { deviceId }, timeout: 60_000 }),
  setup: (deviceId: number, data: {
    name: string; gatewayCidr: string; poolRange: string; dnsName?: string; rateLimit?: string;
    interfaceName?: string; ssid?: { ssid: string; passphrase?: string }; vlanId?: number; masquerade?: boolean;
  }) =>
    api.post<{
      server: string; profile: string; userProfile: string; pool: string;
      targetInterface: string; ssidInterfaces: string[]; vlanInterface?: string; warnings: string[];
    }>('/guest-wifi/setup', { deviceId, ...data }, { timeout: 120_000 }),
  users: (deviceId: number) => api.get<HS[]>('/guest-wifi/users', { params: { deviceId } }),
  createVouchers: (deviceId: number, data: { count: number; durationHours?: number; dataCapMB?: number; userProfile?: string }) =>
    api.post<{ created: number; codes: string[] }>('/guest-wifi/vouchers', { deviceId, ...data }, { timeout: 120_000 }),
  deleteUser: (deviceId: number, id: string) =>
    api.delete(`/guest-wifi/users/${encodeURIComponent(id)}`, { params: { deviceId } }),
  active: (deviceId: number) => api.get<HS[]>('/guest-wifi/active', { params: { deviceId } }),
  disconnect: (deviceId: number, id: string) =>
    api.delete(`/guest-wifi/active/${encodeURIComponent(id)}`, { params: { deviceId } }),
  walledGarden: (deviceId: number) => api.get<HS[]>('/guest-wifi/walled-garden', { params: { deviceId } }),
  addWalledGarden: (deviceId: number, dstHost: string, comment?: string) =>
    api.post('/guest-wifi/walled-garden', { deviceId, dstHost, comment }),
  removeWalledGarden: (deviceId: number, id: string) =>
    api.delete(`/guest-wifi/walled-garden/${encodeURIComponent(id)}`, { params: { deviceId } }),
  setServerDisabled: (deviceId: number, id: string, disabled: boolean) =>
    api.put(`/guest-wifi/servers/${encodeURIComponent(id)}`, { deviceId, disabled }),
  removeServer: (deviceId: number, id: string) =>
    api.delete(`/guest-wifi/servers/${encodeURIComponent(id)}`, { params: { deviceId } }),
};

// ─── Platform & automation ──────────────────────────────────────────────────────
export interface ApiToken {
  id: number; name: string; prefix: string; scope: 'read' | 'write';
  created_by: string | null; last_used_at: string | null; expires_at: string | null; created_at: string;
}
export interface Webhook {
  id: number; name: string; url: string; has_secret: boolean;
  events: string[]; enabled: boolean; last_status: number | null; last_fired_at: string | null; created_at: string;
}
export interface ReportSchedule {
  id: number; name: string; frequency: 'daily' | 'weekly' | 'monthly';
  recipients: string; enabled: boolean; last_sent_at: string | null; next_run_at: string; created_at: string;
}

export const automationApi = {
  // tokens (admin only)
  listTokens: () => api.get<ApiToken[]>('/automation/tokens'),
  createToken: (data: { name: string; scope: 'read' | 'write'; expires_days?: number }) =>
    api.post<{ id: number; token: string }>('/automation/tokens', data),
  deleteToken: (id: number) => api.delete(`/automation/tokens/${id}`),
  // webhooks
  listWebhooks: () => api.get<{ webhooks: Webhook[]; availableEvents: string[] }>('/automation/webhooks'),
  createWebhook: (data: { name: string; url: string; secret?: string; events: string[] }) =>
    api.post<{ id: number }>('/automation/webhooks', data),
  updateWebhook: (id: number, data: Partial<{ name: string; url: string; secret: string; events: string[]; enabled: boolean }>) =>
    api.put(`/automation/webhooks/${id}`, data),
  deleteWebhook: (id: number) => api.delete(`/automation/webhooks/${id}`),
  testWebhook: (id: number) => api.post<{ ok: boolean; status: number }>(`/automation/webhooks/${id}/test`),
  // reports
  listReports: () => api.get<ReportSchedule[]>('/automation/reports'),
  createReport: (data: { name: string; frequency: string; recipients: string }) =>
    api.post<{ id: number }>('/automation/reports', data),
  updateReport: (id: number, data: { enabled?: boolean }) => api.put(`/automation/reports/${id}`, data),
  deleteReport: (id: number) => api.delete(`/automation/reports/${id}`),
  sendReportNow: (id: number) => api.post(`/automation/reports/${id}/send-now`, undefined, { timeout: 60_000 }),
};

// ─── Firmware orchestration ─────────────────────────────────────────────────────
export interface FirmwareDeviceRow {
  id: number; name: string; device_type: string; status: string; model: string | null;
  ros_version: string | null; latest_ros_version: string | null;
  firmware_update_available: boolean;
  firmware_version: string | null; upgrade_firmware_version: string | null;
  routerboard_upgrade_available: boolean;
}
export interface FirmwareRollout {
  id: number; name: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  halt_on_failure: boolean; pre_backup: boolean;
  scheduled_at: string | null; started_at: string | null; finished_at: string | null; created_at: string;
  device_count?: number; success_count?: number; failed_count?: number;
}
export interface FirmwareRolloutDevice {
  id: number; rollout_id: number; device_id: number; wave: number;
  status: 'pending' | 'backing_up' | 'upgrading' | 'rebooting' | 'verifying' | 'success' | 'failed' | 'skipped';
  from_version: string | null; to_version: string | null; error: string | null;
  started_at: string | null; finished_at: string | null;
  device_name: string; device_type: string; model: string | null;
}

export const firmwareApi = {
  overview: () =>
    api.get<{ devices: FirmwareDeviceRow[]; latestRolloutId: number | null; runningRolloutId: number | null }>('/firmware/overview'),
  checkAll: () =>
    api.post<{ results: { name: string; ok: boolean; installed?: string; latest?: string; available?: boolean; error?: string }[] }>(
      '/firmware/check-all', undefined, { timeout: 180_000 }),
  createRollout: (data: {
    name: string; halt_on_failure: boolean; pre_backup: boolean;
    scheduled_at?: string | null; start?: boolean;
    devices: { device_id: number; wave: number }[];
  }) => api.post<{ id: number }>('/firmware/rollouts', data),
  listRollouts: () => api.get<FirmwareRollout[]>('/firmware/rollouts'),
  getRollout: (id: number) =>
    api.get<FirmwareRollout & { devices: FirmwareRolloutDevice[] }>(`/firmware/rollouts/${id}`),
  startRollout: (id: number) => api.post(`/firmware/rollouts/${id}/start`),
  cancelRollout: (id: number) => api.post(`/firmware/rollouts/${id}/cancel`),
  changelog: (version: string) =>
    api.get<{ version: string; url: string; text: string }>(`/firmware/changelog/${encodeURIComponent(version)}`),
};

// ─── Operations ────────────────────────────────────────────────────────────────
export interface OpsAttentionItem {
  sev: 'error' | 'warn' | 'info';
  category: string;
  title: string;
  body: string;
  action: string;
  path: string;
}
export interface OpsCapacityRow { id: number; name: string; cpu: number; mem_pct: number }
export interface OpsActivityItem {
  at: string;
  kind: 'config' | 'audit' | 'alert';
  sev?: string;
  title: string;
  sub: string;
}
export interface OpsInsights {
  attention: OpsAttentionItem[];
  capacity: OpsCapacityRow[];
  activity: OpsActivityItem[];
}
export interface OpsActionResult { total: number; results: { name: string; ok: boolean; error?: string }[] }

export const operationsApi = {
  insights: () => api.get<OpsInsights>('/operations/insights'),
  backupAll: () => api.post<OpsActionResult>('/operations/backup-all', undefined, { timeout: 180_000 }),
  syncAll: () => api.post<OpsActionResult>('/operations/sync-all', undefined, { timeout: 180_000 }),
};

export const backupsApi = {
  list: (deviceId?: number) =>
    api.get<Backup[]>('/backups', { params: deviceId ? { deviceId } : {} }),
  create: (deviceId: number, notes?: string) =>
    api.post<Backup>('/backups', { deviceId, notes }),
  download: (id: number) =>
    api.get(`/backups/${id}/download`, { responseType: 'blob' }),
  restore: (id: number) => api.post(`/backups/${id}/restore`),
  delete: (id: number) => api.delete(`/backups/${id}`),
};

// ─── Config History ────────────────────────────────────────────────────────────
export const configHistoryApi = {
  list: (deviceId: number) =>
    api.get<ConfigSnapshotMeta[]>(`/config-history/${deviceId}`),
  get: (deviceId: number, id: number) =>
    api.get<ConfigSnapshotFull>(`/config-history/${deviceId}/${id}`),
  diff: (deviceId: number, fromId: number, toId: number) =>
    api.get<ConfigDiffResponse>(`/config-history/${deviceId}/${fromId}/diff/${toId}`),
  capture: (deviceId: number) =>
    api.post<ConfigCaptureResult>(`/config-history/${deviceId}/capture`),
  rollback: (deviceId: number, id: number) =>
    api.post<{ message: string }>(`/config-history/${deviceId}/${id}/rollback`),
  delete: (deviceId: number, id: number) =>
    api.delete(`/config-history/${deviceId}/${id}`),
};

// ─── Metrics ─────────────────────────────────────────────────────────────────
export const metricsApi = {
  summary: () => api.get<MetricsSummary>('/metrics/summary'),
  clientsOverTime: (range = '24h') =>
    api.get<TimeSeriesPoint[]>('/metrics/clients-over-time', { params: { range } }),
  topClients: (limit = 10) =>
    api.get<(Client & { total_bytes: number })[]>('/metrics/top-clients', { params: { limit } }),
  interfaceTraffic: (deviceId: number, iface: string, range = '1h') =>
    api.get<TrafficPoint[]>(`/metrics/interface/${deviceId}/${encodeURIComponent(iface)}`, {
      params: { range },
    }),
  interfacePackets: (deviceId: number, iface: string, range = '1h') =>
    api.get<TrafficPoint[]>(`/metrics/interface/${deviceId}/${encodeURIComponent(iface)}/packets`, {
      params: { range },
    }),
  deviceResources: (deviceId: number, range = '24h') =>
    api.get<ResourcePoint[]>(`/metrics/device/${deviceId}/resources`, { params: { range } }),
  deviceAvailability: (deviceId: number, range = '30d') =>
    api.get<DeviceAvailability>(`/metrics/device/${deviceId}/availability`, { params: { range } }),
  devicePoe: (deviceId: number) =>
    api.get<{ ports: { port: string; watts: number; current_ma: number; voltage_v: number }[]; totalWatts: number; history: { time: string; port: string; watts: number }[] }>(`/metrics/device/${deviceId}/poe`),
};

// ─── Topology ────────────────────────────────────────────────────────────────
export const topologyApi = {
  get: () =>
    api.get<{
      devices: Device[];
      links: import('../types').TopologyLink[];
      externalNodes: import('../types').ExternalTopologyNode[];
      segConns: { src: string; dst: string; port: string }[];
      manualLinkIds: { id: number; from_device_id: number; to_device_id: number }[];
    }>('/topology'),
  discover: () => api.post('/topology/discover'),
  createManualLink: (from_device_id: number, to_device_id: number, label?: string) =>
    api.post<{ id: number; from_device_id: number; to_device_id: number; label: string | null }>(
      '/topology/manual-links', { from_device_id, to_device_id, label }
    ),
  deleteManualLink: (id: number) => api.delete(`/topology/manual-links/${id}`),
};

// ─── Search ──────────────────────────────────────────────────────────────────
export const searchApi = {
  search: (q: string) =>
    api.get<{
      devices: {
        id: number; name: string; ip_address: string;
        model?: string; device_type: string; status: string;
      }[];
      clients: {
        mac_address: string; hostname?: string; ip_address?: string;
        device_id: number; device_name?: string; active: boolean;
      }[];
      events: {
        id: number; message: string; severity: string;
        event_time: string; topic?: string; device_name?: string;
      }[];
    }>('/search', { params: { q } }),
};

// ─── Routers ──────────────────────────────────────────────────────────────────
export const routersApi = {
  overview: () => api.get<Record<string, unknown>[]>('/devices/routers/overview'),
  getLldpStatus: () => api.get<{
    id: number; name: string; ip_address: string;
    enabled: boolean | null; protocol: string | null; error?: string;
  }[]>('/routers/lldp'),
  setLldp: (enabled: boolean) => api.put<{
    applied: number; total: number;
    results: { id: number; name: string; success: boolean; error?: string }[];
  }>('/routers/lldp', { enabled }),
  getSnmpStatus: () => api.get<{
    id: number; name: string; ip_address: string;
    enabled: boolean | null; community_name?: string; version?: string;
    auth_protocol?: string; priv_protocol?: string;
    contact?: string; location?: string; trap_target?: string;
    error?: string;
  }[]>('/routers/snmp'),
  setSnmp: (config: {
    enabled: boolean; community_name: string; version: 'v1' | 'v2c' | 'v3';
    contact?: string; location?: string; trap_target?: string;
    auth_protocol?: string; auth_password?: string;
    priv_protocol?: string; priv_password?: string;
  }) => api.put<{
    applied: number; total: number;
    results: { id: number; name: string; success: boolean; error?: string }[];
  }>('/routers/snmp', config),
};

// ─── Routing Protocols (per-device) ───────────────────────────────────────────
Object.assign(devicesApi, {
  getOspf: (id: number) => api.get<Record<string, unknown>>(`/devices/${id}/routing/ospf`),
  addOspfInstance: (id: number, data: Record<string, unknown>) =>
    api.post(`/devices/${id}/routing/ospf/instance`, data),
  removeOspfInstance: (id: number, itemId: string) =>
    api.delete(`/devices/${id}/routing/ospf/instance/${encodeURIComponent(itemId)}`),
  addOspfArea: (id: number, data: Record<string, unknown>) =>
    api.post(`/devices/${id}/routing/ospf/area`, data),
  removeOspfArea: (id: number, itemId: string) =>
    api.delete(`/devices/${id}/routing/ospf/area/${encodeURIComponent(itemId)}`),
  getBgp: (id: number) => api.get<Record<string, unknown>>(`/devices/${id}/routing/bgp`),
  addBgpConnection: (id: number, data: Record<string, unknown>) =>
    api.post(`/devices/${id}/routing/bgp/connection`, data),
  removeBgpConnection: (id: number, itemId: string) =>
    api.delete(`/devices/${id}/routing/bgp/connection/${encodeURIComponent(itemId)}`),
  getRoutingTables: (id: number) =>
    api.get<Record<string, string>[]>(`/devices/${id}/routing/tables`),
  addRoutingTable: (id: number, data: { name: string; fib?: boolean }) =>
    api.post(`/devices/${id}/routing/tables`, data),
  removeRoutingTable: (id: number, itemId: string) =>
    api.delete(`/devices/${id}/routing/tables/${encodeURIComponent(itemId)}`),
  getRouteFilters: (id: number) =>
    api.get<Record<string, unknown>>(`/devices/${id}/routing/filters`),
  addFilterRule: (id: number, data: Record<string, unknown>) =>
    api.post(`/devices/${id}/routing/filters/rule`, data),
  updateFilterRule: (id: number, itemId: string, data: Record<string, unknown>) =>
    api.put(`/devices/${id}/routing/filters/rule/${encodeURIComponent(itemId)}`, data),
  removeFilterRule: (id: number, itemId: string) =>
    api.delete(`/devices/${id}/routing/filters/rule/${encodeURIComponent(itemId)}`),
  getRouterIds: (id: number) =>
    api.get<Record<string, string>[]>(`/devices/${id}/routing/router-id`),
});

// ─── Switches ─────────────────────────────────────────────────────────────────
export const switchesApi = {
  list: () => api.get<Record<string, unknown>[]>('/switches'),
  getLldpStatus: () => api.get<{
    id: number; name: string; ip_address: string;
    enabled: boolean | null; protocol: string | null; error?: string;
  }[]>('/switches/lldp'),
  setLldp: (enabled: boolean) => api.put<{
    applied: number; total: number;
    results: { id: number; name: string; success: boolean; error?: string }[];
  }>('/switches/lldp', { enabled }),
  getSnmpStatus: () => api.get<{
    id: number; name: string; ip_address: string;
    enabled: boolean | null; community_name?: string; version?: string;
    auth_protocol?: string; priv_protocol?: string;
    contact?: string; location?: string; trap_target?: string;
    error?: string;
  }[]>('/switches/snmp'),
  setSnmp: (config: {
    enabled: boolean; community_name: string; version: 'v1' | 'v2c' | 'v3';
    contact?: string; location?: string; trap_target?: string;
    auth_protocol?: string; auth_password?: string;
    priv_protocol?: string; priv_password?: string;
  }) => api.put<{
    applied: number; total: number;
    results: { id: number; name: string; success: boolean; error?: string }[];
  }>('/switches/snmp', config),
};

// ─── Alerts ──────────────────────────────────────────────────────────────────
export interface AlertRule {
  event_type: string;
  enabled: boolean;
  threshold: number | null;
  cooldown_min: number;
  updated_at: string;
}

export interface AlertChannel {
  id: number;
  name: string;
  type: 'email' | 'slack' | 'discord' | 'telegram' | 'ntfy';
  enabled: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AlertHistoryEntry {
  id: number;
  event_type: string;
  device_id: number | null;
  device_name: string | null;
  message: string;
  channels_notified: string[];
  sent_at: string;
}

export const alertsApi = {
  getRules: () => api.get<AlertRule[]>('/alerts/rules'),
  updateRule: (type: string, data: Partial<Pick<AlertRule, 'enabled' | 'threshold' | 'cooldown_min'>>) =>
    api.put<AlertRule>(`/alerts/rules/${encodeURIComponent(type)}`, data),
  getChannels: () => api.get<AlertChannel[]>('/alerts/channels'),
  createChannel: (data: { name: string; type: AlertChannel['type']; enabled?: boolean; config?: Record<string, unknown> }) =>
    api.post<AlertChannel>('/alerts/channels', data),
  updateChannel: (id: number, data: Partial<Pick<AlertChannel, 'name' | 'enabled' | 'config'>>) =>
    api.put<AlertChannel>(`/alerts/channels/${id}`, data),
  deleteChannel: (id: number) => api.delete(`/alerts/channels/${id}`),
  testChannel: (id: number) => api.post<{ message: string }>(`/alerts/channels/${id}/test`),
  getHistory: (limit = 50) => api.get<AlertHistoryEntry[]>('/alerts/history', { params: { limit } }),
};

// ─── Settings ────────────────────────────────────────────────────────────────
export const settingsApi = {
  get: () => api.get<Record<string, unknown>>('/settings'),
  update: (data: Record<string, unknown>) => api.put('/settings', data),
  getUsers: () => api.get('/settings/users'),
  createUser: (data: { username: string; password: string; role?: string }) =>
    api.post('/settings/users', data),
  updateUser: (id: number, data: { role?: string; password?: string }) =>
    api.put(`/settings/users/${id}`, data),
  deleteUser: (id: number) => api.delete(`/settings/users/${id}`),
};

export interface CertInfo {
  exists: boolean;
  subject?: string;
  subject_full?: string;
  issuer?: string;
  issuer_full?: string;
  serial_number?: string;
  valid_from?: string;
  valid_to?: string;
  days_remaining?: number;
  is_self_signed?: boolean;
  san?: string | null;
}

export const certApi = {
  get: () => api.get<CertInfo>('/cert'),
  regenerate: () => api.post<CertInfo & { message: string }>('/cert/regenerate'),
  upload: (certificate: string, private_key: string) =>
    api.post<CertInfo & { message: string }>('/cert/upload', { certificate, private_key }),
};

// ─── Wireless ─────────────────────────────────────────────────────────────────
/**
 * A CAPsMAN controller and the access points it provisions. Read-only: the
 * configuration lives on the controller and pushing an edit would reach every bound
 * AP at once, so that is deliberately not exposed yet (issue #94).
 */
export interface CapsmanRadio {
  radio_mac: string;
  interface_name: string | null;
  local: boolean;
  hw_type: string | null;
  /** Operating channel from /interface/wifi/monitor, not the supported-channel list. */
  current_channel: string | null;
  state: string | null;
  /** SSID the controller provisioned onto this radio; the CAP itself does not know it. */
  ssid: string | null;
  registered_peers: number | null;
  authorized_peers: number | null;
  tx_power: number | null;
  remote_cap_name: string | null;
  matched_device_id: number | null;
  matched_device_name: string | null;
  matched_device_status: string | null;
}

export interface CapsmanAccessPoint {
  device_id: number | null;
  device_name: string;
  radios: CapsmanRadio[];
  /** Clients as the controller sees them; a CAP's own table is empty under central forwarding. */
  client_count: number;
}

export interface CapsmanConfiguration {
  name: string;
  ssid: string | null;
  mode: string | null;
  band: string | null;
  security: string | null;
  authentication_types: string | null;
  /** Provisioning rules that apply this configuration. */
  rules: CapsmanProvisioning[];
}

export interface CapsmanProvisioning {
  ros_id: string;
  action: string | null;
  master_configuration: string | null;
  slave_configurations: string | null;
  radio_mac: string | null;
  comment: string | null;
  disabled: boolean;
}

export interface CapsmanSsid {
  device_id: number;
  device_name: string;
  name: string;
  /** Radio this interface sits on, used to join live channel and client counts. */
  radio_mac: string | null;
  ssid: string | null;
  band: string | null;
  frequency: number | null;
  disabled: boolean;
  running: boolean;
  registered_clients: number | null;
}

export interface CapsmanController {
  id: number;
  name: string;
  ip_address: string;
  model: string | null;
  status: string;
  wifi_role: string | null;
  client_count: number;
  access_points: CapsmanAccessPoint[];
  configurations: CapsmanConfiguration[];
  provisioning: CapsmanProvisioning[];
  ssids: CapsmanSsid[];
}

export const wirelessApi = {
  // Section overview
  list: () => api.get('/wireless'),
  // CAPsMAN controllers with the APs they provision (read-only)
  capsman: () => api.get<{ controllers: CapsmanController[] }>('/wireless/capsman'),

  // Multi-AP SSID deployment
  bulkCreateInterfaces: (data: { apIds: number[] } & Record<string, unknown>) =>
    api.post('/wireless/ssid/bulk', data),

  // Per-AP: wireless interfaces (SSIDs)
  getInterfaces:    (apId: number) => api.get(`/wireless/${apId}/interfaces`),
  createInterface:  (apId: number, data: Record<string, unknown>) =>
    api.post(`/wireless/${apId}/interfaces`, data),
  updateInterface:  (apId: number, name: string, data: Record<string, unknown>) =>
    api.put(`/wireless/${apId}/interfaces/${encodeURIComponent(name)}`, data),
  deleteInterface:  (apId: number, name: string) =>
    api.delete(`/wireless/${apId}/interfaces/${encodeURIComponent(name)}`),

  // Per-AP: security profiles
  getSecurityProfiles:    (apId: number) => api.get(`/wireless/${apId}/security-profiles`),
  createSecurityProfile:  (apId: number, data: Record<string, unknown>) =>
    api.post(`/wireless/${apId}/security-profiles`, data),
  updateSecurityProfile:  (apId: number, name: string, data: Record<string, unknown>) =>
    api.put(`/wireless/${apId}/security-profiles/${encodeURIComponent(name)}`, data),
  deleteSecurityProfile:  (apId: number, name: string) =>
    api.delete(`/wireless/${apId}/security-profiles/${encodeURIComponent(name)}`),

  // Hardware radio capabilities (wifi package)
  getRadios: (apId: number) => api.get(`/wireless/${apId}/radios`),

  // Bridge list + port memberships
  getBridges: (apId: number) => api.get(`/wireless/${apId}/bridges`),

  // Radio monitoring
  getRegistrationTable: (apId: number) => api.get(`/wireless/${apId}/registration-table`),
  getMonitor:           (apId: number, iface: string) =>
    api.get(`/wireless/${apId}/monitor/${encodeURIComponent(iface)}`),
  scan:                 (apId: number, iface: string) =>
    api.get(`/wireless/${apId}/scan/${encodeURIComponent(iface)}`),

  // Cached wireless data (for device detail Radios tab)
  getCachedInterfaces: (deviceId: number) => api.get(`/devices/${deviceId}/wireless`),
  getMetrics:          (deviceId: number, iface?: string, range?: string) =>
    api.get(`/devices/${deviceId}/wireless/metrics`, { params: { iface, range } }),

  // Spectral scan
  runSpectralScan:    (apId: number, iface: string) =>
    api.post(`/wireless/${apId}/spectral-scan/${encodeURIComponent(iface)}`),
  getSpectralHistory: (apId: number, iface: string, limit = 5) =>
    api.get(`/wireless/${apId}/spectral-history/${encodeURIComponent(iface)}`, { params: { limit } }),

  // AP scan
  runAPScan:         (apId: number) => api.post(`/wireless/${apId}/ap-scan`),
  getAPScanHistory:  (apId: number, limit = 5) =>
    api.get(`/wireless/${apId}/ap-scan-history`, { params: { limit } }),

  // Rogue / neighbor AP detection (classified from stored AP scans)
  getRogueAps: () =>
    api.get<import('../types').RogueApReport>('/wireless/rf/rogue'),

  // RF Health (fleet-wide, or scoped to one AP via deviceId)
  getChannelUsage: (deviceId?: number) =>
    api.get<import('../types').RfChannelUsage>('/wireless/rf/channels', { params: { deviceId } }),
  getRfCapabilities: () =>
    api.get<{ packages: Record<string, number>; legacyRadios: number; txRetriesAvailable: boolean }>(
      '/wireless/rf/capabilities'),
  getClientSignals: (deviceId?: number) =>
    api.get<import('../types').RfSignalRow[]>('/wireless/rf/signals', { params: { deviceId } }),
  getTxQuality: (deviceId?: number, range = '6h') =>
    api.get<import('../types').RfTxQualityRow[]>('/wireless/rf/tx-quality', { params: { deviceId, range } }),
  getConnectivity: (deviceId?: number, range = '24h') =>
    api.get<import('../types').RfConnectivity>('/wireless/rf/connectivity', { params: { deviceId, range } }),
};

// ─── Network Services ─────────────────────────────────────────────────────────

type NS = Record<string, string>;

export const networkServicesApi = {
  // Overview
  overview: () =>
    api.get<Record<string, unknown>[]>('/network-services/overview', { timeout: 60_000 }),

  // ── DHCP ──────────────────────────────────────────────────────────────────
  getDhcp: (deviceId: number) =>
    api.get<{ ipv4: NS[]; ipv6: NS[]; pools_v4: NS[]; pools_v6: NS[]; interfaces: NS[] }>(
      '/network-services/dhcp', { params: { deviceId } }
    ),
  addDhcpServer: (deviceId: number, body: NS & { protocol: 'ipv4' | 'ipv6' }) =>
    api.post<NS[]>('/network-services/dhcp/server', body, { params: { deviceId } }),
  updateDhcpServer: (deviceId: number, id: string, body: NS & { protocol: 'ipv4' | 'ipv6' }) =>
    api.put<NS[]>(`/network-services/dhcp/server/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteDhcpServer: (deviceId: number, id: string, protocol: 'ipv4' | 'ipv6') =>
    api.delete(`/network-services/dhcp/server/${encodeURIComponent(id)}`, { params: { deviceId, protocol } }),
  toggleDhcpServer: (deviceId: number, serverId: string, disabled: boolean, protocol: 'ipv4' | 'ipv6') =>
    api.put('/network-services/dhcp/server', { serverId, disabled, protocol }, { params: { deviceId } }),
  addDhcpPool: (deviceId: number, body: NS & { protocol: 'ipv4' | 'ipv6' }) =>
    api.post<NS[]>('/network-services/dhcp/pool', body, { params: { deviceId } }),
  deleteDhcpPool: (deviceId: number, id: string, protocol: 'ipv4' | 'ipv6') =>
    api.delete(`/network-services/dhcp/pool/${encodeURIComponent(id)}`, { params: { deviceId, protocol } }),
  getLeases: (deviceId: number, protocol: 'ipv4' | 'ipv6') =>
    api.get<NS[]>('/network-services/dhcp/leases', { params: { deviceId, protocol } }),
  addStaticLease: (deviceId: number, body: NS & { protocol: 'ipv4' | 'ipv6' }) =>
    api.post('/network-services/dhcp/static-lease', body, { params: { deviceId } }),
  deleteStaticLease: (deviceId: number, id: string, protocol: 'ipv4' | 'ipv6') =>
    api.delete(`/network-services/dhcp/static-lease/${encodeURIComponent(id)}`, { params: { deviceId, protocol } }),

  // ── DNS ───────────────────────────────────────────────────────────────────
  getDns: (deviceId: number) =>
    api.get<{ settings: NS; statics: NS[] }>('/network-services/dns', { params: { deviceId } }),
  setDns: (deviceId: number, settings: {
    servers?: string; allow_remote_requests?: boolean;
    max_udp_packet_size?: string; cache_size?: string; cache_max_ttl?: string;
  }) =>
    api.put<NS>('/network-services/dns', settings, { params: { deviceId } }),
  flushDns: (deviceId: number) =>
    api.post('/network-services/dns/flush', {}, { params: { deviceId } }),
  addDnsStatic: (deviceId: number, body: NS) =>
    api.post<NS[]>('/network-services/dns/static', body, { params: { deviceId } }),
  updateDnsStatic: (deviceId: number, id: string, body: NS) =>
    api.put<NS[]>(`/network-services/dns/static/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteDnsStatic: (deviceId: number, id: string) =>
    api.delete(`/network-services/dns/static/${encodeURIComponent(id)}`, { params: { deviceId } }),

  // ── NTP ───────────────────────────────────────────────────────────────────
  getNtp: (deviceId: number) =>
    api.get<{ server: NS; client: NS }>('/network-services/ntp', { params: { deviceId } }),
  setNtp: (deviceId: number, settings: {
    server_enabled?: boolean; server_broadcast?: boolean; server_manycast?: boolean;
    client_enabled?: boolean; client_mode?: string; client_servers?: string;
  }) =>
    api.put<{ server: NS; client: NS }>('/network-services/ntp', settings, { params: { deviceId } }),

  // ── Syslog ────────────────────────────────────────────────────────────────
  getSyslog: (deviceId: number) =>
    api.get<{ actions: NS[]; rules: NS[] }>('/network-services/syslog', { params: { deviceId } }),
  addSyslogAction: (deviceId: number, body: NS) =>
    api.post<NS[]>('/network-services/syslog/action', body, { params: { deviceId } }),
  updateSyslogAction: (deviceId: number, id: string, body: NS) =>
    api.put<NS[]>(`/network-services/syslog/action/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteSyslogAction: (deviceId: number, id: string) =>
    api.delete(`/network-services/syslog/action/${encodeURIComponent(id)}`, { params: { deviceId } }),
  addSyslogRule: (deviceId: number, body: NS) =>
    api.post<NS[]>('/network-services/syslog/rule', body, { params: { deviceId } }),
  updateSyslogRule: (deviceId: number, id: string, body: NS) =>
    api.put<NS[]>(`/network-services/syslog/rule/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteSyslogRule: (deviceId: number, id: string) =>
    api.delete(`/network-services/syslog/rule/${encodeURIComponent(id)}`, { params: { deviceId } }),
  toggleSyslogRule: (deviceId: number, ruleId: string, disabled: boolean) =>
    api.put('/network-services/syslog/rule/toggle', { ruleId, disabled }, { params: { deviceId } }),

  // ── WireGuard ─────────────────────────────────────────────────────────────
  getWireGuard: (deviceId: number) =>
    api.get<{ interfaces: NS[]; peers: NS[] }>('/network-services/wireguard', { params: { deviceId } }),
  addWireGuardInterface: (deviceId: number, body: NS) =>
    api.post<NS[]>('/network-services/wireguard', body, { params: { deviceId } }),
  updateWireGuardInterface: (deviceId: number, id: string, body: NS) =>
    api.put<NS[]>(`/network-services/wireguard/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteWireGuardInterface: (deviceId: number, id: string) =>
    api.delete(`/network-services/wireguard/${encodeURIComponent(id)}`, { params: { deviceId } }),
  toggleWireGuard: (deviceId: number, interfaceId: string, disabled: boolean) =>
    api.put('/network-services/wireguard/toggle', { interfaceId, disabled }, { params: { deviceId } }),
  addWireGuardPeer: (deviceId: number, body: NS) =>
    api.post<NS[]>('/network-services/wireguard/peer', body, { params: { deviceId } }),
  updateWireGuardPeer: (deviceId: number, id: string, body: NS) =>
    api.put<NS[]>(`/network-services/wireguard/peer/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteWireGuardPeer: (deviceId: number, id: string) =>
    api.delete(`/network-services/wireguard/peer/${encodeURIComponent(id)}`, { params: { deviceId } }),

  // ── NetFlow ───────────────────────────────────────────────────────────────
  netflowFleet: () =>
    api.get<{
      collector: { address: string; port: number; version: string; listening: boolean };
      devices: NetflowDeviceState[];
    }>('/network-services/netflow/fleet', { timeout: 60_000 }),
  getNetflow: (deviceId: number) =>
    api.get<{ settings: NS | null; targets: NS[]; target_matches_collector: boolean }>(
      '/network-services/netflow', { params: { deviceId } }
    ),
  setNetflow: (deviceId: number, enabled: boolean) =>
    api.put<{ settings: NS | null; targets: NS[]; target_matches_collector: boolean }>(
      '/network-services/netflow', { enabled }, { params: { deviceId } }
    ),
};

export interface NetflowDeviceState {
  id: number;
  name: string;
  ip_address: string;
  enabled: boolean | null;
  interfaces: string;
  targets: { id: string; dst_address: string; port: number; version: string; disabled: boolean }[];
  target_matches_collector: boolean;
  flows_received: number;
  last_flow_at: string | null;
  error?: string;
}

// ─── Traffic Analytics (NetFlow) ──────────────────────────────────────────────

export interface ClientTrafficPoint { time: string; upload: number; download: number; uploadPackets?: number; downloadPackets?: number }
export interface TrafficTopClient {
  mac: string;
  upload_bytes: number;
  download_bytes: number;
  total_bytes: number;
  hostname: string | null;
  custom_name: string | null;
  vendor: string | null;
  ip_address: string | null;
}
export interface TrafficApp { app: string; bytes: number; packets?: number }
export interface TrafficCollectorStats {
  listening: boolean;
  port: number;
  packetsReceived: number;
  flowsDecoded: number;
  flowsAttributed: number;
  packetsFromUnknownExporter: number;
  recordsWithoutTemplate: number;
  exporters: { deviceId: number; deviceName: string; packets: number; flows: number; lastSeen: string | null }[];
}

export const trafficApi = {
  status: () => api.get<TrafficCollectorStats>('/traffic/status'),
  timeseries: (range = '24h') =>
    api.get<ClientTrafficPoint[]>('/traffic/timeseries', { params: { range } }),
  topClients: (range = '24h', limit = 10) =>
    api.get<TrafficTopClient[]>('/traffic/top-clients', { params: { range, limit } }),
  apps: (range = '24h', mac?: string) =>
    api.get<TrafficApp[]>('/traffic/apps', { params: { range, mac } }),
  client: (mac: string, range = '24h') =>
    api.get<{ series: ClientTrafficPoint[]; apps: TrafficApp[] }>(
      `/traffic/client/${encodeURIComponent(mac)}`, { params: { range } }
    ),
};

// ─── Maintenance Windows ──────────────────────────────────────────────────────
export interface MaintenanceWindow {
  id: number;
  name: string;
  device_ids: number[];
  start_at: string;
  end_at: string;
  recurring_cron: string | null;
  active: boolean;
  created_at: string;
}
export const maintenanceApi = {
  list: () => api.get<MaintenanceWindow[]>('/maintenance-windows'),
  create: (data: Omit<MaintenanceWindow, 'id' | 'created_at'>) =>
    api.post<MaintenanceWindow>('/maintenance-windows', data),
  update: (id: number, data: Partial<MaintenanceWindow>) =>
    api.put<MaintenanceWindow>(`/maintenance-windows/${id}`, data),
  delete: (id: number) => api.delete(`/maintenance-windows/${id}`),
};

// ─── Tags ────────────────────────────────────────────────────────────────────
export const tagsApi = {
  list: () => api.get<import('../types').Tag[]>('/tags'),
  create: (name: string, color: string) => api.post<import('../types').Tag>('/tags', { name, color }),
  update: (id: number, data: { name?: string; color?: string }) => api.put<import('../types').Tag>(`/tags/${id}`, data),
  delete: (id: number) => api.delete(`/tags/${id}`),
  assignDevices: (tagId: number, deviceIds: number[], action: 'add' | 'remove') =>
    api.post(`/tags/${tagId}/devices`, { deviceIds, action }),
  deviceTags: (deviceId: number) => api.get<import('../types').Tag[]>(`/tags/device/${deviceId}`),
};

// ─── Audit Log ───────────────────────────────────────────────────────────────
export const auditLogApi = {
  list: (params: {
    page?: number; limit?: number; userId?: number; entityType?: string;
    search?: string; from?: string; to?: string;
  } = {}) =>
    api.get<{
      rows: {
        id: number; user_id: number | null; username: string | null;
        method: string; path: string; entity_type: string | null;
        entity_id: number | null; summary: string; ip_address: string | null;
        status_code: number | null; created_at: string;
      }[];
      total: number; page: number; limit: number;
    }>('/audit-log', { params }),
};

export interface ConfigTemplate {
  id: number;
  name: string;
  description: string | null;
  applies_to_type: string | null;
  template_json: {
    dns_servers?: string[];
    ntp_servers?: string[];
    syslog_host?: string;
  };
  created_at: string;
  updated_at: string;
}

export const configTemplatesApi = {
  list: () => api.get<ConfigTemplate[]>('/config-templates'),
  get: (id: number) => api.get<ConfigTemplate>(`/config-templates/${id}`),
  create: (data: Partial<ConfigTemplate>) => api.post<ConfigTemplate>('/config-templates', data),
  update: (id: number, data: Partial<ConfigTemplate>) => api.put<ConfigTemplate>(`/config-templates/${id}`, data),
  delete: (id: number) => api.delete(`/config-templates/${id}`),
  apply: (id: number, device_ids: number[]) =>
    api.post<{ results: { device_id: number; device_name: string; ok: boolean; error?: string }[] }>(
      `/config-templates/${id}/apply`,
      { device_ids }
    ),
};

export default api;
