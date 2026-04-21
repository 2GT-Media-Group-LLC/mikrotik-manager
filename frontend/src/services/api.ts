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
  TimeSeriesPoint,
  TrafficPoint,
  ResourcePoint,
  SwitchPort,
  SystemConfig,
  IpAddress,
  PortVlanConfig,
  PortMonitorData,
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
    api.post<{ token: string; user: import('../types').User }>(
      '/auth/login',
      { username, password }
    ),
  me: () => api.get('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/password', { currentPassword, newPassword }),
};

// ─── Devices ──────────────────────────────────────────────────────────────────
export interface DiscoveredDevice {
  identity: string;
  address: string;
  mac_address: string;
  platform: string;
  discovered_at: string;
  seen_by: string;
}

export const devicesApi = {
  list: () => api.get<Device[]>('/devices'),
  discovered: () => api.get<DiscoveredDevice[]>('/devices/discovered'),
  get: (id: number) => api.get<Device>(`/devices/${id}`),
  create: (
    data: (Partial<Device> & { api_password?: string; ssh_password?: string; credential_preset_id?: number })
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
  configurePortVlan: (id: number, name: string, data: PortVlanConfig) =>
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
  addIpAddress: (id: number, data: { address: string; interface: string }) =>
    api.post<IpAddress[]>(`/devices/${id}/ip-addresses`, data),
  removeIpAddress: (id: number, addrId: string) =>
    api.delete(`/devices/${id}/ip-addresses/${encodeURIComponent(addrId)}`),
  checkUpdate: (id: number) =>
    api.post<Record<string, string>>(`/devices/${id}/check-update`),
  getHardware: (id: number) =>
    api.get<{ health: Record<string, string>[]; disks: Record<string, string>[] }>(`/devices/${id}/hardware`),
  installUpdate: (id: number) => api.post(`/devices/${id}/install-update`),
  getClock: (id: number) => api.get<{ date: string; time: string; timezone: string }>(`/devices/${id}/clock`),
  setClock: (id: number, data: { date?: string; time?: string; timezone?: string }) =>
    api.put(`/devices/${id}/clock`, data),
  addRoute: (id: number, data: { dst_address: string; gateway: string; distance?: number; comment?: string }) =>
    api.post(`/devices/${id}/routing`, data),
  deleteRoute: (id: number, routeId: string) =>
    api.delete(`/devices/${id}/routing/${encodeURIComponent(routeId)}`),
  addVlan: (id: number, data: { bridge: string; vlan_id: number; tagged_ports?: string[]; untagged_ports?: string[] }) =>
    api.post(`/devices/${id}/vlans`, data),
  updateVlan: (id: number, vlanDbId: number, data: { tagged_ports: string[]; untagged_ports: string[] }) =>
    api.put(`/devices/${id}/vlans/${vlanDbId}`, data),
  deleteVlan: (id: number, vlanDbId: number) => api.delete(`/devices/${id}/vlans/${vlanDbId}`),
  reboot: (id: number) => api.post<{ message: string }>(`/devices/${id}/reboot`),
  getPortMonitor: (id: number, name: string) =>
    api.get<PortMonitorData>(`/devices/${id}/ports/${encodeURIComponent(name)}/monitor`),
  createBond: (id: number, data: {
    name: string; mode: string; slaves: string[];
    lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number;
  }) => api.post(`/devices/${id}/bonds`, data),
  updateBond: (id: number, bondName: string, data: {
    mode: string; slaves: string[];
    lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number;
  }) => api.put(`/devices/${id}/bonds/${encodeURIComponent(bondName)}`, data),
  deleteBond: (id: number, bondName: string) =>
    api.delete(`/devices/${id}/bonds/${encodeURIComponent(bondName)}`),
  setBridgeVlanFiltering: (id: number, bridgeName: string, enabled: boolean) =>
    api.put(`/devices/${id}/bridge/${encodeURIComponent(bridgeName)}/vlan-filtering`, { enabled }),
  getNat: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/nat`),
  addNatRule: (id: number, data: Record<string, unknown>) =>
    api.post<Record<string, string>[]>(`/devices/${id}/nat`, data),
  updateNatRule: (id: number, ruleId: string, data: Record<string, unknown>) =>
    api.put<Record<string, string>[]>(`/devices/${id}/nat/${encodeURIComponent(ruleId)}`, data),
  deleteNatRule: (id: number, ruleId: string) =>
    api.delete(`/devices/${id}/nat/${encodeURIComponent(ruleId)}`),
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
};

// ─── Topology ────────────────────────────────────────────────────────────────
export const topologyApi = {
  get: () =>
    api.get<{
      devices: Device[];
      links: import('../types').TopologyLink[];
      externalNodes: import('../types').ExternalTopologyNode[];
    }>('/topology'),
  discover: () => api.post('/topology/discover'),
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
  type: 'email' | 'slack' | 'discord' | 'telegram';
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
export const wirelessApi = {
  // Section overview
  list: () => api.get('/wireless'),

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
};

export default api;
