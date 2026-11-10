import axios, { AxiosError } from 'axios';
import { useAuthStore } from '../store/authStore';
import { useSiteStore } from '../store/siteStore';
import type { AlignmentSnapshot } from '../types/antennaAlignment';
import type { TimeFormatPreference, TimeFormatPreferences } from '../types/timeFormat';
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

/** Backups and restores of large configurations run for minutes, not seconds. */
const LONG_DEVICE_OP_MS = 11 * 60_000;

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

/**
 * For changes that run under Change Guard: a restore point is saved, the change
 * applied, the device checked and the guard disarmed, and on a slow device that
 * takes minutes, not seconds: a bridge move on a CRS112 took 90 seconds end to
 * end. Giving up earlier reported a change as failed while it was
 * still finishing, and the next change met the device lock (#258). nginx allows
 * the API 300 seconds.
 */
export const GUARDED = { timeout: 240_000 };

// ─── Review changes (#255) ──────────────────────────────────────────────────
/** One write the preview recorded, with the item it acts on as it is now. */
export interface PreviewStep {
  action: string;
  path: string;
  host: string;
  params: Record<string, string>;
  target: Record<string, string> | null;
  changes: { field: string; from: string | null; to: string }[];
  unchanged: string[];
  cli: string;
}
export interface ChangePreview {
  steps: PreviewStep[];
  verdict: { severity: string; headline: string; violations: { id: string; title: string; detail?: string; severity: string }[]; warnings: string[] } | null;
}

let previewDepth = 0;
let previewStamped = 0;

/**
 * Run an edit call as a preview: the server goes through the same route but
 * records what it would send to the device instead of sending it. `call` must
 * issue its request straight away (every devicesApi/networkServicesApi method
 * does); the header is added synchronously, so a call that waits before
 * sending is refused here rather than sent for real.
 */
export async function previewChanges(call: () => Promise<unknown>): Promise<ChangePreview> {
  const before = previewStamped;
  let pending: Promise<unknown>;
  previewDepth++;
  try {
    pending = call();
  } finally {
    previewDepth--;
  }
  if (previewStamped === before) {
    // Nothing was sent. A form that refused its own input says why.
    await pending;
    throw new Error('This form can\'t be previewed');
  }
  const r = (await pending) as { data?: { preview?: ChangePreview } };
  if (!r?.data?.preview) throw new Error('The server didn\'t return a preview');
  return r.data.preview;
}

const SEVERITY = ['safe', 'unknown', 'warning', 'critical'];

/** Several edit calls a form makes in turn, previewed as one review. */
export async function previewAll(calls: (() => Promise<unknown>)[]): Promise<ChangePreview> {
  const out: ChangePreview = { steps: [], verdict: null };
  for (const call of calls) {
    const p = await previewChanges(call);
    out.steps.push(...p.steps);
    if (p.verdict && (!out.verdict || SEVERITY.indexOf(p.verdict.severity) > SEVERITY.indexOf(out.verdict.severity))) {
      out.verdict = p.verdict;
    }
  }
  return out;
}

api.interceptors.request.use((config) => {
  // Synchronous (see the options below), so a preview's header is set while
  // previewChanges() is still on the stack.
  if (previewDepth > 0 && (config.method ?? 'get').toLowerCase() !== 'get') {
    config.headers['X-Preview-Changes'] = '1';
    previewStamped++;
  }
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Active site travels with every request (issue #130). Injecting it here
  // rather than threading it through ~160 query keys means a new query is
  // scoped correctly by default and cannot be forgotten. null is the all-sites
  // view, which sends no header and so behaves exactly as before sites existed.
  // A request naming its own site keeps it (the device view of the topology
  // asks for that device's site from the all-sites view, #305).
  const { currentSiteId: siteId, currentGroupId: groupId } = useSiteStore.getState();
  if (siteId != null && config.headers['X-Site-Id'] == null) config.headers['X-Site-Id'] = String(siteId);
  // A group (#306) narrows to its sites; a request naming a site keeps its site.
  else if (groupId != null && config.headers['X-Site-Id'] == null) config.headers['X-Site-Group'] = String(groupId);
  return config;
}, undefined, { synchronous: true });

api.interceptors.response.use(
  (r) => r,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    // The account is still on the default password: nothing works until it is
    // changed, so go straight to the page that does it.
    const code = (error.response?.data as { code?: string } | undefined)?.code;
    if (error.response?.status === 403 && code === 'password_change_required'
        && window.location.pathname !== '/change-password') {
      window.location.assign('/change-password');
    }
    // The selected site isn't one this account has (P1-7), e.g. access was
    // removed. Drop to the all-sites view, which the server narrows to the
    // account's sites; changing the site refetches every query.
    if (error.response?.status === 403 && code === 'site_forbidden'
        && (useSiteStore.getState().currentSiteId != null || useSiteStore.getState().currentGroupId != null)) {
      useSiteStore.getState().setCurrentSite(null);
    }
    return Promise.reject(error);
  }
);

// ─── Auth ─────────────────────────────────────────────────────────────────────
/**
 * Log out on the server as well as here. The server revokes this session's
 * token; clearing only the browser's copy left it working for the rest of its
 * 24 hours (outside review P2-1). The local session ends even if the call fails.
 */
export async function signOut(): Promise<void> {
  try {
    await api.post('/auth/logout', undefined, { timeout: 5000 });
  } catch { /* already expired or unreachable: nothing more to revoke */ }
  useAuthStore.getState().logout();
}

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
  timeFormat: () => api.get<TimeFormatPreferences>('/auth/time-format'),
  setTimeFormat: (preference: TimeFormatPreference) =>
    api.put<TimeFormatPreferences>('/auth/time-format', { preference }),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.put<{ message: string; token?: string; user?: import('../types').User }>('/auth/password', { currentPassword, newPassword }),
  /** Public: whether the login page should still show the default credentials. */
  loginHints: () => api.get<{ default_credentials: boolean; password_login?: boolean }>('/auth/login-hints'),
  securityStatus: () =>
    api.get<{ warnings: string[] }>('/auth/security-status'),
  oidcStatus: () =>
    api.get<{ enabled: boolean; button_label: string }>('/auth/oidc/status'),
  /** Exchange the single-use SSO code for a session (outside review S4). */
  oidcExchange: (code: string) =>
    api.post<{ token: string; user: import('../types').User }>('/auth/oidc/exchange', { code }),
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

// ─── AI connections (Settings → AI Connections) ─────────────────────────────
export type McpAuth = 'oauth' | 'token';
export interface AiSettingsView {
  enabled: boolean;
  mcp_enabled: boolean;
  mcp_auth: McpAuth;
  openapi_enabled: boolean;
  public_url: string;
  oauth_issuer: string;
  oauth_client_id: string;
  has_oauth_secret: boolean;
}
export interface AiToken {
  id: number; name: string; prefix: string; created_by: string | null;
  last_used_at: string | null; expires_at: string | null; created_at: string;
  site_ids: number[] | null; site_names: string[];
}
export const aiConnectionsApi = {
  getConfig: () => api.get<AiSettingsView>('/ai-connections/config'),
  updateConfig: (data: Partial<Omit<AiSettingsView, 'has_oauth_secret'>> & { oauth_client_secret?: string }) =>
    api.put<AiSettingsView>('/ai-connections/config', data),
  test: (data: { issuer: string; client_id: string; client_secret?: string }) =>
    api.post<{ ok: boolean; error?: string }>('/ai-connections/test', data),
  listTokens: () => api.get<AiToken[]>('/ai-connections/tokens'),
  createToken: (data: { name: string; expires_days?: number; site_ids: number[] | null }) =>
    api.post<{ id: number; token: string }>('/ai-connections/tokens', data),
  deleteToken: (id: number) => api.delete(`/ai-connections/tokens/${id}`),
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
  /** The API port runs api-ssl (#257); unset, the port decides (TLS on 8729). */
  api_tls?: boolean;
  ssh_username?: string;
  ssh_password?: string;
  ssh_port?: number;
  /** Existing tags to apply once added (#161). */
  tag_ids?: number[];
  /** The API isn't enabled yet: add over SSH if it doesn't answer (#174). */
  ssh_only?: boolean;
  /** The site it joins, by name, made if it's new (#306). */
  site_name?: string;
  /** The group a new site goes in, made if it's new. */
  group_name?: string;
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

/** A pinned device certificate or SSH host key (outside review P1-4). */
export interface IdentityPin {
  kind: 'api-tls' | 'ssh-host' | 'serial';
  label: string;
  fingerprint: string;
  display: string;
  pinned_at: string;
  /** Set when the device presented a different one; waits for an admin. */
  seen_fingerprint: string | null;
  seen_display: string | null;
  mismatch_at: string | null;
}

export const identityApi = {
  forDevice: (deviceId: number) => api.get<IdentityPin[]>(`/devices/${deviceId}/identity`),
  pending: () => api.get<Array<IdentityPin & { device_id: number; device_name: string }>>('/devices/identity/pending'),
  trust: (deviceId: number, kind: IdentityPin['kind']) =>
    api.post<{ message: string }>(`/devices/${deviceId}/identity/${kind}/trust`),
};

/**
 * A device operation that may outlast a proxy's patience (#417): the manager
 * answers within about 25s, either with the outcome or 202 "still running",
 * and in the second case its outcome is fetched from `${path}/status` every
 * few seconds. Resolves and rejects like a plain axios call, so callers read
 * `res.data` and `err.response.data.error` as before.
 */
export async function runDeviceTask<T>(path: string): Promise<{ data: T }> {
  const first = await api.post<T>(path, undefined, { timeout: 120_000 });
  if (first.status !== 202) return first;
  const deadline = Date.now() + 10 * 60_000;
  let misses = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    let view: { status: string; result?: T; http_status?: number; error?: string };
    try {
      view = (await api.get(`${path}/status`, { timeout: 20_000 })).data;
      misses = 0;
    } catch (err) {
      // The manager's own answer (such as "no record of it") ends the wait;
      // a blip on the way there doesn't, unless it keeps happening.
      if ((err as AxiosError).response?.data || ++misses >= 5) throw err;
      continue;
    }
    if (view.status === 'done') return { data: view.result as T };
    if (view.status === 'failed') {
      throw Object.assign(new Error(view.error || 'Request failed'),
        { response: { status: view.http_status ?? 502, data: { error: view.error } } });
    }
  }
  throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
}

export interface ApiSslResult {
  switched: boolean;
  steps: string[];
  message: string;
}

export interface SecurityCheck {
  id: string;
  severity: 'high' | 'medium' | 'low' | 'ok';
  title: string;
  detail: string;
  serviceId?: string;
  /** A one-click fix the manager can apply (outside review P1-4; www-ssl #234). */
  fix?: 'api-ssl' | 'www-ssl' | 'api-off' | 'romon' | 'firewall-quick';
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
  /** A one-click fix (#239), or why there isn't one. */
  fix?: { summary: string; command: string } | null;
  no_fix_reason?: string | null;
}

export interface ConfigHealthResponse {
  findings: ConfigFinding[];
  checked_at: string | null;
}


// ─── LTE / cellular ───────────────────────────────────────────────────────────

/** One aggregated carrier as the modem reported it. */
export interface LteBandInfo {
  band: number;
  bandwidthMhz: number | null;
  earfcn: number | null;
  phyCellId: number | null;
  raw: string;
}

export interface LteInterface {
  interface_name: string;
  status: string | null;
  data_class: string | null;
  modem_model: string | null;
  modem_revision: string | null;
  operator: string | null;
  cell_id: string | null;
  enb_id: string | null;
  sector_id: string | null;
  phy_cell_id: string | null;
  session_uptime_s: string | number | null;
  primary_band: LteBandInfo | null;
  ca_bands: LteBandInfo[];
  rssi: number | null;
  rsrp: number | null;
  rsrq: number | null;
  sinr: number | null;
  cqi: number | null;
  rank_indicator: number | null;
  mcs: number | null;
  dl_modulation: string | null;
  quality: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown' | null;
  /** Configured allow-list; empty means the modem picks freely. */
  allowed_bands: number[];
  /** Primary plus every aggregated carrier. */
  total_bandwidth_mhz: number;
  /**
   * Set when the uplink is anchored to a narrower carrier than the downlink is
   * aggregating — the reason operators lock bands, and invisible in RouterOS.
   */
  uplink_anchor: {
    primaryMhz: number; primaryBand: number;
    widestMhz: number; widestBand: number;
  } | null;
  network_mode: string | null;
  apn_profiles: string | null;
  allow_roaming: boolean | null;
  updated_at: string;
  /** Bands actually seen serving this device — the evidence behind a band lock. */
  observed_bands: { band: number; observations: number; last_seen: string }[];
}

export interface LteHistoryEvent {
  interface_name: string;
  at: string;
  kind: 'session-reset' | 'handover' | 'band-change';
  detail: string | null;
  cell_id: string | null;
  enb_id: string | null;
  bands: string | null;
  rsrp: number | null;
  sinr: number | null;
}

export interface LteMetricPoint {
  time: string;
  interface: string;
  rsrp?: number;
  rsrq?: number;
  sinr?: number;
  rssi?: number;
  cqi?: number;
  carriers?: number;
}


export interface LteDwellTotal {
  key: string; label: string; seconds: number; pct: number; visits: number; lastSeen: string;
}

export interface LteDwell {
  range: string;
  measured_seconds: number;
  earliest_record: string | null;
  /** True when our records start later than the requested window. */
  truncated: boolean;
  changes: number;
  bands: LteDwellTotal[];
  cells: LteDwellTotal[];
}

export const lteApi = {
  state: (deviceId: number) =>
    api.get<{ interfaces: LteInterface[] }>(`/devices/${deviceId}/lte`),
  dwell: (deviceId: number, range = '7d', iface?: string) =>
    api.get<LteDwell>(`/devices/${deviceId}/lte/dwell`, { params: { range, iface } }),
  history: (deviceId: number, range = '24h', iface?: string) =>
    api.get<{ events: LteHistoryEvent[] }>(`/devices/${deviceId}/lte/history`, { params: { range, iface } }),
  metrics: (deviceId: number, range = '6h', iface?: string) =>
    api.get<{ metrics: LteMetricPoint[] }>(`/devices/${deviceId}/lte/metrics`, {
      params: { range, ...(iface ? { iface } : {}) },
    }),
};


// ─── Poller health (#114) ─────────────────────────────────────────────────────

export interface PollerQueue {
  name: string; waiting?: number; active?: number; delayed?: number;
  failed?: number; completed?: number; paused?: number; error?: string;
}

export interface PollerPhases {
  persistent_sessions: boolean;
  /** A fast poll's reads sent together (#301). */
  pipelined_reads: boolean;
  open_sessions: number;
  avg_connect_new_ms: number | null;
  avg_connect_reused_ms: number | null;
  avg_collect_ms: number | null;
  reused_pct: number | null;
  devices_measured: number;
  /** Of the collecting, the time waiting on the device; the rest is the database and processing. */
  avg_device_ms?: number | null;
  /** The slowest fast polls, split by phase. */
  slowest?: SlowPoll[];
}
export interface SlowPoll {
  id: number; name: string; site: string | null;
  total_ms: number; connect_ms: number | null; device_ms: number | null; other_ms: number | null;
  reused: boolean | null; error: string | null; at: string | null;
}
export interface PollerHealth {
  status: 'ok' | 'draining' | 'saturated';
  queues: PollerQueue[];
  /** Where fast-poll time goes (#301). */
  phases?: PollerPhases | null;
  workers: {
    concurrency: number; job_timeout_ms: number; poll_interval_ms: number; fast_interval_sec?: number;
    /** Each process running poll workers, when there are worker containers (#301). */
    processes?: { role: string; concurrency: number; sessions: number }[];
  };
  capacity: {
    devices: number;
    avg_fast_poll_ms: number | null;
    p90_fast_poll_ms: number | null;
    arrival_per_sec: number;
    service_per_sec: number | null;
    /** Below 1.0 the backlog grows every cycle. */
    headroom: number | null;
    backlog: number;
    /** null when the backlog is not shrinking at the current rate. */
    drain_eta_sec: number | null;
  };
  retention: { max_age_sec: number; max_count: number; stale_pending_ms: Record<string, number> };
  stale_devices: {
    id: number; name: string; status: string; kind: string;
    last_attempt_at: string | null; last_success_at: string | null;
    last_duration_ms: number | null; last_error: string | null;
    attempts: number; failures: number; seconds_since_success: number | null;
  }[];
}

export const pollerApi = {
  health: () => api.get<PollerHealth>('/system/poller'),
  drain: () => api.post<{ drained: Record<string, number>; total: number; message: string }>(
    '/system/poller/drain'),
};


export interface LteDataCapRule {
  id: number; interface_name: string; enabled: boolean;
  phone_number: string; message: string;
  threshold_bytes: string; margin_pct: number;
  reset_hour: number; reset_minute: number; timezone: string;
  cooldown_minutes: number;
  period_key: string | null; period_bytes: string;
  last_sent_at: string | null; updated_at: string;
  /** Clear the carrier's replies from the inbox (discussion #85). */
  delete_replies?: boolean; reply_sender?: string | null;
}

export interface LteDataCapSend {
  interface_name: string; at: string; trigger: 'manual' | 'threshold';
  phone_number: string | null; period_bytes: string | null;
  ok: boolean; error: string | null;
}

export const dataCapApi = {
  get: (deviceId: number) =>
    api.get<{ rules: LteDataCapRule[]; sends: LteDataCapSend[] }>(`/devices/${deviceId}/lte/data-cap`),
  save: (deviceId: number, iface: string, body: Record<string, unknown>) =>
    api.put<{ message: string }>(`/devices/${deviceId}/lte/data-cap/${encodeURIComponent(iface)}`, body),
  sendNow: (deviceId: number, iface: string) =>
    api.post<{ message: string }>(`/devices/${deviceId}/lte/data-cap/${encodeURIComponent(iface)}/send`),
};

/** The modem's SMS inbox (discussion #85), read live. */
export interface SmsMessage { id: string; phone: string; timestamp: string | null; message: string; type: string | null }
export const smsApi = {
  inbox: (deviceId: number) =>
    api.get<{ receive_enabled: boolean | null; port: string | null; messages: SmsMessage[] }>(`/devices/${deviceId}/lte/sms`),
  remove: (deviceId: number, body: { ids?: string[]; phone?: string; all?: true }) =>
    api.post<{ removed: number; message: string }>(`/devices/${deviceId}/lte/sms/delete`, body),
};


export interface DeviceSshKey {
  device_id: number; key_type: string; public_key: string;
  fingerprint: string | null; ssh_username: string | null;
  status: 'pending' | 'deployed' | 'verified' | 'failed';
  last_error: string | null; last_verified_at: string | null;
  deployed_at: string | null; created_at: string;
}

export const sshKeyApi = {
  get: (deviceId: number) => api.get<{ key: DeviceSshKey | null }>(`/devices/${deviceId}/ssh-key`),
  deploy: (deviceId: number, rotate = false) =>
    api.post<{ message: string }>(`/devices/${deviceId}/ssh-key`, { rotate }),
  verify: (deviceId: number) => api.post<{ message: string }>(`/devices/${deviceId}/ssh-key/verify`),
  revoke: (deviceId: number) => api.delete<{ message: string }>(`/devices/${deviceId}/ssh-key`),
  /** Requires explicit confirmation: this disables password SSH fleet-wide. */
  deployAll: () => api.post<{ considered: number; succeeded: number;
    results: { device_id: number; name: string; ok: boolean; error?: string }[] }>(
    '/devices/ssh-keys/deploy-all', { confirm: true }, { timeout: 600_000 }),
};

// ─── Fleet SSH key deployment (admin) ────────────────────────────────────────
export interface FleetKeyPreview {
  eligible: { id: number; name: string; ip_address: string; username: string; source: 'ssh' | 'api' }[];
  keyed: { id: number; name: string }[];
  skipped: { id: number; name: string; reason: string }[];
  accounts: { username: string; devices: number; via_api_login: number }[];
  halt_after: number;
}

export interface FleetKeyJob {
  job_id: string;
  status: 'queued' | 'active' | 'completed' | 'cancelled' | 'halted' | 'failed';
  total: number;
  processed: number;
  keyed?: number;
  failed?: number;
  skipped?: number;
  current_name?: string | null;
  error?: string;
  results: {
    device_id: number; name: string; outcome: 'keyed' | 'failed' | 'skipped';
    username?: string; source?: 'ssh' | 'api'; message: string;
  }[];
}

export const sshFleetApi = {
  preview: (tagIds: number[]) =>
    api.get<FleetKeyPreview>('/ssh-keys/fleet/preview', { params: tagIds.length ? { tag_ids: tagIds.join(',') } : {} }),
  start: (deviceIds: number[]) =>
    api.post<{ job_id: string; total: number }>('/ssh-keys/fleet/jobs', { device_ids: deviceIds, confirm: true }),
  status: (jobId: string) => api.get<FleetKeyJob>(`/ssh-keys/fleet/jobs/${jobId}`),
  cancel: (jobId: string) => api.post<{ message: string }>(`/ssh-keys/fleet/jobs/${jobId}/cancel`),
};


// ─── Bulk commands (#118) ─────────────────────────────────────────────────────

export interface CommandRunSummary {
  id: number; name: string; command: string; status: string;
  wave_size: number; halt_on_failure: boolean; use_change_guard: boolean;
  total: number; succeeded: number; failed: number; created_at: string;
  /** The schedule that made it (#359), and why a scheduled run didn't happen. */
  schedule_id?: number | null; note?: string | null;
}

/** A scheduled bulk command (#359). */
export interface CommandSchedule {
  id: number; name: string; command: string;
  device_ids: number[]; tag_ids: number[]; site_ids: number[];
  wave_size: number; halt_on_failure: boolean; use_change_guard: boolean;
  maintenance_only: boolean; alert_on_failure: boolean;
  kind: 'once' | 'simple' | 'cron';
  run_at: string | null; cron: string | null;
  simple: { freq: 'daily' | 'weekly' | 'monthly'; time: string; weekday?: number; monthday?: number } | null;
  enabled: boolean; next_run_at: string | null;
  last_run_id: number | null; last_status: string | null; last_run_at?: string | null;
  created_by: string | null;
  description: string; target_count: number;
}
export type CommandScheduleInput = Omit<CommandSchedule, 'id' | 'enabled' | 'next_run_at' | 'last_run_id' | 'last_status' | 'last_run_at' | 'created_by' | 'description' | 'target_count'>;

export interface CommandRunDevice {
  id: number; device_id: number; device_name: string; ip_address: string;
  wave: number; status: string; output: string | null; error: string | null;
  guarded: boolean; auto_reverted: boolean;
}

export interface CommandRunDetail extends CommandRunSummary {
  devices: CommandRunDevice[];
}

// ─── Command templates (#163) ───────────────────────────────────────────────
export interface CommandTemplate {
  id: number;
  name: string;
  description: string | null;
  command: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Secret values for commands (#259): names only ever come back, never values. */
export const commandSecretsApi = {
  list: () => api.get<{ id: number; name: string; created_by: string | null; updated_at: string }[]>('/command-secrets'),
  save: (data: { name: string; value?: string; generate?: boolean }) => api.post('/command-secrets', data),
  remove: (name: string) => api.delete(`/command-secrets/${encodeURIComponent(name)}`),
};

export const commandTemplatesApi = {
  list: () => api.get<CommandTemplate[]>('/command-templates'),
  create: (data: { name: string; command: string; description?: string }) =>
    api.post<CommandTemplate>('/command-templates', data),
  update: (id: number, data: Partial<Pick<CommandTemplate, 'name' | 'command' | 'description'>>) =>
    api.put<CommandTemplate>(`/command-templates/${id}`, data),
  delete: (id: number) => api.delete(`/command-templates/${id}`),
  /** What a template can be captured from, and a draft read off a device (Discussion #85). */
  captureSections: () => api.get<{ key: string; label: string }[]>('/command-templates/capture/sections'),
  capture: (deviceId: number, sections: string[]) =>
    api.get<{ name: string; description: string; command: string; skipped: string[] }>('/command-templates/capture',
      { params: { deviceId, sections: sections.join(',') } }),
};

export const commandsApi = {
  preview: (command: string, device_ids: number[], wave_size: number) =>
    api.post<{
      command: string; risky: boolean; reasons: string[]; wave_size: number; waves: number;
      devices: { id: number; name: string; wave: number; status: string }[];
      unreachable: { id: number; name: string }[];
    }>('/commands/preview', { command, device_ids, wave_size }),
  createRun: (body: Record<string, unknown>) => api.post<{ id: number }>('/commands/runs', body),
  listRuns: () => api.get<CommandRunSummary[]>('/commands/runs'),
  getRun: (id: number) => api.get<CommandRunDetail>(`/commands/runs/${id}`),
  cancelRun: (id: number) => api.post<{ message: string }>(`/commands/runs/${id}/cancel`),
  /**
   * Fetched through the authenticated client, not a bare link. Auth is a Bearer
   * header, which an <a download> cannot send — the link would simply 401.
   */
  exportCsv: (id: number) =>
    api.get(`/commands/runs/${id}/export`, { responseType: 'blob' }),
  listSchedules: () => api.get<{ time_zone: string; schedules: CommandSchedule[] }>('/commands/schedules'),
  createSchedule: (body: CommandScheduleInput) => api.post<CommandSchedule>('/commands/schedules', body),
  updateSchedule: (id: number, body: CommandScheduleInput) => api.put<CommandSchedule>(`/commands/schedules/${id}`, body),
  setScheduleEnabled: (id: number, enabled: boolean) => api.post(`/commands/schedules/${id}/enabled`, { enabled }),
  runScheduleNow: (id: number) => api.post<{ id: number }>(`/commands/schedules/${id}/run-now`),
  deleteSchedule: (id: number) => api.delete(`/commands/schedules/${id}`),
};

/** Overridable settings (#261): the overrides set here, and what's in force with where it comes from. */
export interface PollSettings {
  overrides: Record<string, number | boolean>;
  site?: { id: number | null; name: string | null; overrides: Record<string, number | boolean> };
  effective: Record<string, { value: number | boolean; source: 'device' | 'site' | 'global' }>;
  /** Device settings only: each value without this device's own override (#261). */
  inherited?: Record<string, { value: number | boolean; source: 'device' | 'site' | 'global' }>;
}

/** IPv4 or IPv6 firewall (#312). */
export type FirewallFamily = 'ipv4' | 'ipv6';

/** Request params for a firewall call: ?family=ipv6 only for IPv6, so IPv4 requests are unchanged. */
function famParams(family?: FirewallFamily, extra: Record<string, string> = {}): { params: Record<string, string> } | undefined {
  const params = { ...(family === 'ipv6' ? { family: 'ipv6' } : {}), ...extra };
  return Object.keys(params).length ? { params } : undefined;
}

/** Quick firewall rules (#330). */
export type QuickPreset = 'input-basics' | 'management-access' | 'forward-basics' | 'masquerade' | 'brute-force';
export interface QuickFirewallStep {
  table: 'filter' | 'nat' | 'address-list';
  params: Record<string, string>;
  placement: 'top' | 'bottom' | null;
  description: string;
  skip: string | null;
}
export interface QuickFirewallPlan {
  steps: QuickFirewallStep[];
  errors: Record<string, string>;
  notes: string[];
  interface_lists: string[];
  interfaces: string[];
  services: { name: string; port: string; disabled: boolean }[];
  manager_ip: string | null;
  /** VPN servers that are on, for brute-force protection (#405). */
  vpn?: { l2tp: boolean; pptp: boolean; ovpn: boolean; sstp: boolean; ovpnPort: string | null };
  bf_defaults?: string[];
}

export const devicesApi = {
  /** Settings this device overrides (#261); null in a PUT clears one. */
  getPollSettings: (id: number) => api.get<PollSettings>(`/devices/${id}/poll-settings`),
  setPollSettings: (id: number, data: Record<string, number | boolean | null>) => api.put<PollSettings>(`/devices/${id}/poll-settings`, data),
  /**
   * Change the login the manager uses for several devices (#259). Each is
   * logged in to with the new login first, and only updated if that works.
   */
  bulkCredentials: (data: {
    device_ids: number[]; credential_preset_id?: number | null;
    api_username?: string; api_password?: string; ssh_username?: string | null; ssh_password?: string | null;
  }) => api.post<{ results: { id: number; name: string; ok: boolean; error?: string }[]; updated: number; failed: number }>(
    '/devices/credentials/bulk', data, { timeout: 240_000 }),
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
      /** Existing tags to apply once added (#161). */
      tag_ids?: number[];
    })
  ) => api.post<Device>('/devices', data),
  update: (
    id: number,
    data: Partial<Device> & {
      api_password?: string;
      ssh_password?: string;
      credential_preset_id?: number | null;
      /** "Use the router's identity" in Edit Device — sent alone, no other fields. */
      unlock_name?: boolean;
    }
  ) => api.put<Device>(`/devices/${id}`, data),
  delete: (id: number) => api.delete(`/devices/${id}`),
  /** A full sync, or with scope just what one tab shows ('vlans', 'wireless'). */
  sync: (id: number, scope?: 'vlans' | 'wireless') => api.post(`/devices/${id}/sync`, scope ? { scope } : undefined, { timeout: 60_000 }),
  /** SSH-only device (#174): does the API answer now? It becomes an ordinary device if so. */
  checkApi: (id: number) =>
    api.post<{ api: boolean; port?: number; message?: string; reason?: string }>(`/devices/${id}/check-api`, undefined, { timeout: 30_000 }),
  test: (id: number) => api.post<{ success: boolean; identity?: string; error?: string }>(`/devices/${id}/test`),
  getInterfaces: (id: number) => api.get<Interface[]>(`/devices/${id}/interfaces`),
  updateInterface: (id: number, name: string, data: Partial<Interface>) =>
    api.put(`/devices/${id}/interfaces/${encodeURIComponent(name)}`, data, GUARDED),
  getVlans: (id: number) => api.get<Vlan[]>(`/devices/${id}/vlans`),
  getPorts: (id: number) =>
    api.get<{ ports: SwitchPort[]; vlans: Vlan[] }>(`/devices/${id}/ports`),
  getRouting: (id: number) => api.get<Record<string, string>[]>(`/devices/${id}/routing`),
  // The firewall calls take an optional family: 'ipv6' works on /ipv6/firewall (#312).
  getFirewall: (id: number, family?: FirewallFamily) =>
    api.get<Record<string, string>[]>(`/devices/${id}/firewall`, famParams(family)),
  addFirewallRule: (id: number, data: Record<string, unknown>, family?: FirewallFamily) =>
    api.post<Record<string, string>[]>(`/devices/${id}/firewall`, data, famParams(family)),
  // Quick rules (#330): the plan for a preset (changes nothing), and applying it.
  quickFirewallPlan: (id: number, params: Record<string, string>, family?: FirewallFamily) =>
    api.get<QuickFirewallPlan>(`/devices/${id}/firewall/quick`, { params: { ...params, ...(famParams(family)?.params ?? {}) } }),
  quickFirewallApply: (id: number, body: Record<string, unknown>, family?: FirewallFamily) =>
    api.post<{ message: string; added: number }>(`/devices/${id}/firewall/quick`, body, famParams(family)),
  updateFirewallRule: (id: number, ruleId: string, data: Record<string, unknown>, family?: FirewallFamily) =>
    api.put<Record<string, string>[]>(`/devices/${id}/firewall/${encodeURIComponent(ruleId)}`, data, famParams(family)),
  deleteFirewallRule: (id: number, ruleId: string, confirmLockout = false, family?: FirewallFamily) =>
    api.delete(`/devices/${id}/firewall/${encodeURIComponent(ruleId)}`, famParams(family, confirmLockout ? { confirm_lockout: 'true' } : {})),
  getResources: (id: number) => api.get<Record<string, string>>(`/devices/${id}/resources`),
  configurePortVlan: (id: number, name: string, data: PortVlanConfig & { confirm_lockout?: boolean }) =>
    api.put(`/devices/${id}/ports/${encodeURIComponent(name)}/vlan`, data, GUARDED),
  getSystemConfig: (id: number) => api.get<SystemConfig>(`/devices/${id}/system-config`),
  updateSystemConfig: (id: number, data: Partial<{
    identity: string;
    ntp_enabled: boolean;
    ntp_primary: string;
    ntp_secondary: string;
    dns_servers: string;
    dns_allow_remote: boolean;
  }>) => api.put(`/devices/${id}/system-config`, data),
  getIpAddresses: (id: number, opts: { includeIpv6?: boolean } = {}) =>
    api.get<IpAddress[]>(`/devices/${id}/ip-addresses`, { params: opts.includeIpv6 ? { include: 'ipv6' } : undefined }),
  addIpAddress: (id: number, data: { address: string; interface: string; confirm_lockout?: boolean }) =>
    api.post<IpAddress[]>(`/devices/${id}/ip-addresses`, data),
  /** Edit an address in place (#285); only the fields sent change. */
  updateIpAddress: (id: number, addrId: string,
    data: { address?: string; interface?: string; comment?: string; disabled?: boolean }, confirmLockout = false) =>
    api.put(`/devices/${id}/ip-addresses/${encodeURIComponent(addrId)}`, confirmLockout ? { ...data, confirm_lockout: true } : data),
  removeIpAddress: (id: number, addrId: string, confirmLockout = false) =>
    api.delete(`/devices/${id}/ip-addresses/${encodeURIComponent(addrId)}`,
      confirmLockout ? { data: { confirm_lockout: true } } : undefined),
  checkUpdate: (id: number) =>
    api.post<Record<string, string>>(`/devices/${id}/check-update`),
  checkRouterboard: (id: number) =>
    api.post<{ currentFirmware: string; upgradeFirmware: string; upgradeAvailable: boolean }>(`/devices/${id}/check-routerboard`),
  installRouterboard: (id: number) =>
    api.post<{
      started: boolean; current_firmware: string | null;
      target_firmware?: string; message: string;
    }>(`/devices/${id}/install-routerboard`),
  getHardware: (id: number) =>
    api.get<{ health: Record<string, string>[]; disks: Record<string, string>[] }>(`/devices/${id}/hardware`),
  /** `started: false` means the device was already current — not a failure. */
  installUpdate: (id: number) =>
    api.post<{
      started: boolean; installed_version: string | null;
      target_version?: string; message: string;
    }>(`/devices/${id}/install-update`),
  getClock: (id: number) => api.get<{ date: string; time: string; timezone: string }>(`/devices/${id}/clock`),
  setClock: (id: number, data: { date?: string; time?: string; timezone?: string }) =>
    api.put(`/devices/${id}/clock`, data),
  addRoute: (id: number, data: { dst_address: string; gateway: string; distance?: number; comment?: string; routing_table?: string; confirm_lockout?: boolean }) =>
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
  copyVlans: (id: number, operations: Array<{ action: 'add' | 'update'; vlan_id: number; bridge: string; tagged_ports: string[]; untagged_ports: string[] }>, confirmLockout = false) =>
    api.post<{ results?: Array<{ vlan_id: number; action: string; success: boolean; error?: string }>; guard?: { protected: boolean; confirmed: boolean; auto_reverting: boolean; unprotected_reason: string | null; revert_may_fire_at?: string | null }; message?: string }>(
      `/devices/${id}/vlans/copy`, { operations, ...(confirmLockout ? { confirm_lockout: true } : {}) }),
  reboot: (id: number) => api.post<{ message: string }>(`/devices/${id}/reboot`),
  /** Ports that can supply PoE, read live (#291). */
  getPoePorts: (id: number) => api.get<{ ports: { name: string; poeOut: string | null }[] }>(`/devices/${id}/poe`),
  /** Cut a port's PoE output for a few seconds, then restore it (#291). */
  poePowerCycle: (id: number, port: string, seconds = 5, confirmManagement = false) =>
    api.post<{ message: string }>(`/devices/${id}/ports/${encodeURIComponent(port)}/poe-power-cycle`,
      { seconds, ...(confirmManagement ? { confirm_management: true } : {}) }),
  getInterfaceErrors: (id: number) => api.get<InterfaceErrorsResponse>(`/devices/${id}/interface-errors`),
  getOptics: (id: number) => api.get<OpticsResponse>(`/devices/${id}/optics`),
  getOpticHistory: (id: number, port: string, days = 7) =>
    api.get<OpticHistoryPoint[]>(`/devices/${id}/optics/${encodeURIComponent(port)}/history`, { params: { days } }),
  getPortMonitor: (id: number, name: string) =>
    api.get<PortMonitorData>(`/devices/${id}/ports/${encodeURIComponent(name)}/monitor`),
  getPortClients: (id: number, name: string, all = false) =>
    api.get<import('../types').PortClientsResult>(`/devices/${id}/ports/${encodeURIComponent(name)}/clients`, { params: { all: all || undefined } }),
  createBond: (id: number, data: {
    name: string; mode: string; slaves: string[];
    lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number;
    confirm_lockout?: boolean;
  }) => api.post(`/devices/${id}/bonds`, data, GUARDED),
  updateBond: (id: number, bondName: string, data: {
    mode: string; slaves: string[];
    lacp_rate?: string; transmit_hash_policy?: string; mtu?: number; min_links?: number; confirm_lockout?: boolean;
  }) => api.put(`/devices/${id}/bonds/${encodeURIComponent(bondName)}`, data, GUARDED),
  deleteBond: (id: number, bondName: string, confirmLockout = false) =>
    api.delete(`/devices/${id}/bonds/${encodeURIComponent(bondName)}`,
      { ...GUARDED, ...(confirmLockout ? { data: { confirm_lockout: true } } : {}) }),
  /** Ports into a bridge (created if asked), or out of any bridge with `bridge: null` (#258). */
  moveBridgePorts: (id: number, data: {
    ports: string[]; bridge: string | null; create_bridge?: boolean;
    confirm_addresses?: boolean; confirm_lockout?: boolean;
  }) => api.post<BridgeMoveResult>(`/devices/${id}/bridge-ports/move`, data, GUARDED),
  deleteBridge: (id: number, bridgeName: string, confirmLockout = false) =>
    api.delete(`/devices/${id}/bridges/${encodeURIComponent(bridgeName)}`,
      { ...GUARDED, ...(confirmLockout ? { data: { confirm_lockout: true } } : {}) }),
  /** Bridges tab (#284): every bridge with ports, VLAN entries and addresses. */
  getBridgesDetail: (id: number) => api.get<BridgeView[]>(`/devices/${id}/bridges`),
  addBridge: (id: number, data: { name: string; protocol_mode?: string; priority?: string; vlan_filtering?: boolean; comment?: string }) =>
    api.post(`/devices/${id}/bridges`, data, GUARDED),
  updateBridge: (id: number, bridgeName: string,
    data: { name?: string; protocol_mode?: string; priority?: string; comment?: string; disabled?: boolean; mtu?: string }, confirmLockout = false) =>
    api.put(`/devices/${id}/bridges/${encodeURIComponent(bridgeName)}`, { ...data, ...(confirmLockout ? { confirm_lockout: true } : {}) }, GUARDED),
  setBridgeVlanFiltering: (id: number, bridgeName: string, enabled: boolean, confirmLockout = false) =>
    api.put(`/devices/${id}/bridge/${encodeURIComponent(bridgeName)}/vlan-filtering`,
      { enabled, ...(confirmLockout ? { confirm_lockout: true } : {}) }, GUARDED),
  getNat: (id: number, family?: FirewallFamily) => api.get<Record<string, string>[]>(`/devices/${id}/nat`, famParams(family)),
  addNatRule: (id: number, data: Record<string, unknown>, family?: FirewallFamily) =>
    api.post<Record<string, string>[]>(`/devices/${id}/nat`, data, famParams(family)),
  updateNatRule: (id: number, ruleId: string, data: Record<string, unknown>, family?: FirewallFamily) =>
    api.put<Record<string, string>[]>(`/devices/${id}/nat/${encodeURIComponent(ruleId)}`, data, famParams(family)),
  deleteNatRule: (id: number, ruleId: string, family?: FirewallFamily) =>
    api.delete(`/devices/${id}/nat/${encodeURIComponent(ruleId)}`, famParams(family)),
  // Firewall: reorder + counters (order is decisive in RouterOS)
  moveFirewallRule: (id: number, ruleId: string, destination?: string, confirmLockout = false, family?: FirewallFamily) =>
    api.post(`/devices/${id}/firewall/move`, { id: ruleId, destination, ...(confirmLockout ? { confirm_lockout: true } : {}) }, famParams(family)),
  /** Count "outages this week" from now on (#85); history is kept. */
  resetOutages: (id: number) => api.post<{ message: string; outages_reset_at: string }>(`/devices/${id}/outages/reset`),
  /** Tag every rule that logs without a tag, filter and NAT (#369). */
  tagLoggingRules: (id: number, family?: FirewallFamily, confirm = false) =>
    api.post<{ tagged: number; message: string }>(`/devices/${id}/firewall/tag-logging`, confirm ? { confirm_lockout: true } : {}, famParams(family)),
  resetFirewallCounters: (id: number, family?: FirewallFamily) =>
    api.post<Record<string, string>[]>(`/devices/${id}/firewall/reset-counters`, undefined, famParams(family)),
  moveNatRule: (id: number, ruleId: string, destination?: string, family?: FirewallFamily) =>
    api.post<Record<string, string>[]>(`/devices/${id}/nat/move`, { id: ruleId, destination }, famParams(family)),
  // Firewall address lists (reusable address objects)
  getAddressLists: (id: number, family?: FirewallFamily) =>
    api.get<Record<string, string>[]>(`/devices/${id}/address-lists`, famParams(family)),
  /** The switch chip's own VLAN table, on older chips (#278). Read-only. */
  getSwitchVlans: (id: number) => api.get<SwitchVlanView>(`/devices/${id}/switch-vlans`),
  /** Where the device's web interface answers (#335); url null when www and www-ssl are off. */
  getWebAdmin: (id: number) => api.get<{ url: string | null; note: string | null }>(`/devices/${id}/web-admin`),
  getVlanInterfaces: (id: number) => api.get<VlanInterface[]>(`/devices/${id}/vlan-interfaces`),
  /** VLAN interface edits (#309), predicted by Change Guard; confirm_lockout after a 409. */
  addVlanInterface: (id: number, data: VlanInterfaceInput & { address?: string; confirm_lockout?: boolean }) =>
    api.post<{ message: string; address_error?: boolean }>(`/devices/${id}/vlan-interfaces`, data),
  updateVlanInterface: (id: number, entryId: string, data: Partial<VlanInterfaceInput> & { current_name?: string; confirm_lockout?: boolean }) =>
    api.put<{ message: string }>(`/devices/${id}/vlan-interfaces/${encodeURIComponent(entryId)}`, data),
  removeVlanInterface: (id: number, entryId: string, name: string, confirmLockout = false) =>
    api.delete<{ message: string }>(`/devices/${id}/vlan-interfaces/${encodeURIComponent(entryId)}`,
      { params: { name, ...(confirmLockout ? { confirm_lockout: 'true' } : {}) } }),
  getIpv6Routes: (id: number) => api.get<{ supported: boolean; disabled?: boolean; routes: Ipv6Route[] }>(`/devices/${id}/routing/ipv6`),
  /** Switch chip VLAN edits (#278); each requires Change Guard's auto-revert. */
  addSwitchVlan: (id: number, data: { switch: string; vlan_id: number; ports: string[]; disabled?: boolean }) =>
    api.post(`/devices/${id}/switch-vlans`, data, { timeout: 120_000 }),
  updateSwitchVlan: (id: number, entryId: string, data: { vlan_id?: number; ports?: string[]; disabled?: boolean }) =>
    api.put(`/devices/${id}/switch-vlans/${encodeURIComponent(entryId)}`, data, { timeout: 120_000 }),
  removeSwitchVlan: (id: number, entryId: string) =>
    api.delete(`/devices/${id}/switch-vlans/${encodeURIComponent(entryId)}`, { timeout: 120_000 }),
  setSwitchPortVlan: (id: number, port: string, data: { vlan_mode?: string; vlan_header?: string; default_vlan_id?: string }) =>
    api.put(`/devices/${id}/switch-ports/${encodeURIComponent(port)}/vlan`, data, { timeout: 120_000 }),
  /** L3 hardware offloading on the switch chip (#254). */
  getL3Hw: (id: number) => api.get<L3HwView>(`/devices/${id}/l3hw`),
  setL3Hw: (id: number, enabled: boolean, acknowledgeFirewall = false) =>
    api.put<{ message: string; already?: boolean }>(`/devices/${id}/l3hw`, { enabled, ...(acknowledgeFirewall ? { acknowledge_firewall: true } : {}) }, { timeout: 120_000 }),
  /** One client's view of this router's address lists (#145). */
  clientAddressLists: (id: number, address: string) =>
    api.get<ClientAddressListView>(`/devices/${id}/address-lists/client`, { params: { address } }),
  addAddressListEntry: (id: number, data: { list: string; address: string; comment?: string; timeout?: string; confirm_lockout?: boolean }, family?: FirewallFamily) =>
    api.post(`/devices/${id}/address-lists`, data, famParams(family)),
  updateAddressListEntry: (id: number, entryId: string, data: Record<string, unknown>, family?: FirewallFamily) =>
    api.put<Record<string, string>[]>(`/devices/${id}/address-lists/${encodeURIComponent(entryId)}`, data, famParams(family)),
  removeAddressListEntry: (id: number, entryId: string, confirmLockout = false, family?: FirewallFamily) =>
    api.delete(`/devices/${id}/address-lists/${encodeURIComponent(entryId)}`, famParams(family, confirmLockout ? { confirm_lockout: 'true' } : {})),
  // Active connections (read-only)
  getConnections: (id: number, limit = 200, protocol = '') =>
    api.get<{ total: number | null; connections: Record<string, string>[]; limit: number; truncated: boolean; tracking: Record<string, string> }>(
      `/devices/${id}/connections`, { params: { limit, ...(protocol ? { protocol } : {}) } }),
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
  // Which addresses a service accepts connections from; empty = any (#192).
  setServiceAllowedFrom: (id: number, serviceId: string, allowedFrom: string, confirmLockout = false) =>
    api.put<{ services: Record<string, string>[] }>(`/devices/${id}/services/${encodeURIComponent(serviceId)}`,
      { allowed_from: allowedFrom, ...(confirmLockout ? { confirm_lockout: true } : {}) }),
  listSecuritySuppressions: () =>
    api.get<SecuritySuppression[]>('/devices/security/suppressions'),
  suppressSecurityCheck: (check_id: string, device_id: number | null, reason?: string) =>
    api.post('/devices/security/suppressions', { check_id, device_id, reason }),
  unsuppressSecurityCheck: (id: number) =>
    api.delete(`/devices/security/suppressions/${id}`),
  /** Enable API-SSL on the device and move the manager's connection to it. Signing a certificate can take a minute. */
  enableApiSsl: (id: number) => runDeviceTask<ApiSslResult>(`/devices/${id}/api-ssl`),
  /**
   * Turn off plain API once the manager is on API-SSL (#201). Refused while
   * anything else is connected to plain API (409 with in_use_by), and run
   * under Change Guard (409 with a verdict asks to confirm).
   */
  disablePlainApi: (id: number, confirmLockout = false) =>
    api.post<{ message: string; already?: boolean }>(`/devices/${id}/plain-api/off`, confirmLockout ? { confirm_lockout: true } : {}, { timeout: 120_000 }),
  /** WebFig over HTTPS (#234); plain www goes off only once HTTPS answers. Same result shape. */
  /** Apply the device's RoMON setting: its site's, group's or the fleet default (#311). */
  applyRomon: (id: number) => api.post<{ message: string }>(`/devices/${id}/romon`),
  enableWwwSsl: (id: number) => runDeviceTask<ApiSslResult & { url?: string }>(`/devices/${id}/www-ssl`),
  getSecurityPosture: (id: number) =>
    api.get<{ score: number; checks: SecurityCheck[] }>(`/devices/${id}/security-posture`),
  // Config Health — cached findings load instantly; the scan re-reads the device.
  getConfigHealth: (id: number) =>
    api.get<ConfigHealthResponse>(`/devices/${id}/config-health`),
  scanConfigHealth: (id: number) =>
    api.post<ConfigHealthResponse>(`/devices/${id}/config-health/scan`),
  /** Apply a finding's one-click fix under Change Guard (#239). */
  fixConfigHealth: (id: number, rule: string, objects: string[], confirmLockout = false) =>
    api.post<{ message?: string; guard?: unknown }>(`/devices/${id}/config-health/fix`, { rule, objects, ...(confirmLockout ? { confirm_lockout: true } : {}) }, { timeout: 180_000 }),
  /** Can this device arm Change Guard's auto-revert right now? Saves and removes a throwaway restore point. */
  changeGuardCheck: (id: number) =>
    api.post<{ ready: boolean; mode: 'binary' | 'script'; reason: string | null }>(`/devices/${id}/change-guard/check`),
  patchLocation: (id: number, data: {
    location_address?: string | null;
    location_lat?: number | null;
    location_lng?: number | null;
    rack_name?: string | null;
    rack_slot?: string | null;
    notes?: string | null;
  }) => api.patch<Device>(`/devices/${id}/location`, data),
  /** Health and intermittent settings (#168). */
  patchMonitoring: (id: number, data: {
    intermittent?: boolean;
    intermittent_alert_after_min?: number;
    health_ignored?: string[];
  }) => api.patch(`/devices/${id}/monitoring`, data),
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
  /** The site it belongs to; null = fleet-wide (#228). */
  site_id?: number | null;
  site_name?: string | null;
  /** Whether the current user may edit or delete it. */
  can_manage?: boolean;
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
  site_id?: number | null;
}

export const credentialPresetsApi = {
  list: () => api.get<CredentialPreset[]>('/credential-presets'),
  create: (data: CredentialPresetInput) =>
    api.post<CredentialPreset>('/credential-presets', data),
  update: (id: number, data: CredentialPresetInput) =>
    api.put<CredentialPreset>(`/credential-presets/${id}`, data),
  delete: (id: number) => api.delete(`/credential-presets/${id}`),
};

// ─── SSH jump hosts ───────────────────────────────────────────────────────────

/** A router the manager reaches other devices through. Secrets are write-only. */
export interface JumpHost {
  id: number;
  name: string;
  site_id: number | null;
  site_name: string | null;
  host: string;
  port: number;
  username: string | null;
  auth: 'password' | 'key' | 'preset';
  credential_preset_id: number | null;
  credential_preset_name: string | null;
  has_password: boolean;
  has_private_key: boolean;
  /** The pinned host key, as "SHA256:…"; null until the first connection. */
  host_key_fingerprint: string | null;
  /** A different key it presented, waiting for an admin to trust it. */
  seen_host_key_fingerprint: string | null;
  host_key_mismatch_at: string | null;
  notes: string | null;
  device_count: number;
  /** Its shared connection: open, not needed right now, failing, or refusing to forward (with why). */
  status: 'connected' | 'idle' | 'failing' | 'not_forwarding';
  status_error: string | null;
  can_manage: boolean;
  created_at: string;
  updated_at: string;
}

export interface JumpHostInput {
  name?: string;
  site_id?: number | null;
  host?: string;
  port?: number | null;
  username?: string | null;
  password?: string;
  private_key?: string;
  passphrase?: string;
  credential_preset_id?: number | null;
  host_key_fingerprint?: string;
  notes?: string | null;
}

export const jumpHostsApi = {
  list: () => api.get<JumpHost[]>('/jump-hosts'),
  create: (data: JumpHostInput) => api.post<JumpHost>('/jump-hosts', data),
  update: (id: number, data: JumpHostInput) => api.put<JumpHost>(`/jump-hosts/${id}`, data),
  delete: (id: number) => api.delete(`/jump-hosts/${id}`),
  test: (id: number) =>
    // forwarding: it forwarded to one of its devices; null with none to try.
    api.post<({ ok: true; fingerprint: string | null; forwarding: true | null } | { ok: false; error: string }) & { jump_host: JumpHost }>(`/jump-hosts/${id}/test`),
  trustKey: (id: number) => api.post<JumpHost>(`/jump-hosts/${id}/trust-key`),
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
  /** False for a neighbour the manager doesn't manage (an unmanaged switch heard over LLDP, #365). */
  upstream_managed?: boolean;
  comment?: string;
}

export interface PresencePoint { time: string; online: number; }
export interface TrafficPoint2 { time: string; tx_bytes: number; rx_bytes: number; }
export interface SignalPoint { time: string; signal_strength: number; }

export interface RoamEvent {
  kind: 'connected' | 'roamed' | 'disconnected' | 'dhcp-assigned' | 'dhcp-released';
  at: string;
  mac: string;
  interfaceName: string | null;
  ssid: string | null;
  signal: number | null;
  toInterface: string | null;
  toSsid: string | null;
  reason: string | null;
  ip: string | null;
  hostname: string | null;
  deviceName: string | null;
}

export interface RoamHop {
  at: string; from: string | null; to: string;
  signalBefore: number | null; signalAfter: number | null;
}

export interface RoamSession {
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  ssid: string | null;
  ip: string | null;
  hostname: string | null;
  path: string[];
  hops: RoamHop[];
  disconnectReason: string | null;
  signalMin: number | null;
  signalMax: number | null;
  roamsPerHour: number | null;
  events: RoamEvent[];
}

export interface RoamingHistory {
  mac: string;
  range: string;
  sessions: RoamSession[];
  totalRoams: number;
  flappingSessions: number;
  radios: { name: string; count: number }[];
}

export const clientsApi = {
  list: (params?: {
    deviceId?: number;
    active?: boolean;
    search?: string;
    client_type?: string;
    vlan_id?: number;
    /** Inclusive lower / exclusive upper dBm bound, matching the density buckets. */
    signal_min?: number;
    signal_max?: number;
    limit?: number;
    offset?: number;
    sort?: string;
    dir?: 'asc' | 'desc';
    /** 'show' includes managed devices' own MACs and VRRP MACs (#363). */
    infra?: 'show';
  }) =>
    api.get<{ clients: Client[]; total: number; vlans?: number[]; network_device_macs?: number }>('/clients', { params }),
  get: (mac: string) => api.get<ClientDetail>(`/clients/${encodeURIComponent(mac)}`),
  getRoaming: (mac: string, range = '24h') =>
    api.get<RoamingHistory>(`/clients/${encodeURIComponent(mac)}/roaming`, { params: { range } }),
  getPresence: (mac: string, range = '24h') =>
    api.get<PresencePoint[]>(`/clients/${encodeURIComponent(mac)}/presence`, { params: { range } }),
  getTraffic: (mac: string, range = '24h') =>
    api.get<TrafficPoint2[]>(`/clients/${encodeURIComponent(mac)}/traffic`, { params: { range } }),
  getSignal: (mac: string, range = '24h') =>
    api.get<SignalPoint[]>(`/clients/${encodeURIComponent(mac)}/signal`, { params: { range } }),
  wol: (mac: string) => api.post<{ success: boolean; message: string }>(`/clients/${encodeURIComponent(mac)}/wol`),
  /** Kick a wireless client off its access point (#338); confirmManaged when it is a managed device. */
  disconnect: (mac: string, confirmManaged = false) =>
    api.post<{ message: string; removed: number; failed: string[] }>(`/clients/${encodeURIComponent(mac)}/disconnect`, confirmManaged ? { confirm_managed: true } : {}),
  updateNotes: (mac: string, notes: string) =>
    api.put<Client>(`/clients/${encodeURIComponent(mac)}/notes`, { notes }),
  updateHostname: (mac: string, hostname: string) =>
    api.put<Client>(`/clients/${encodeURIComponent(mac)}/hostname`, { hostname }),
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
    api.get<{ current: string; latest: string | null; update_available: boolean; disabled?: boolean }>('/system/version-check'),
  darkSite: () =>
    api.get<{ features: DarkSiteFeature[] }>('/system/dark-site'),
};

// ─── Events ───────────────────────────────────────────────────────────────────

export interface FirewallEvent {
  id: number;
  deviceId: number | null;
  deviceName: string | null;
  eventTime: string;
  severity: string;
  topic: string | null;
  rawMessage: string;

  action: 'accept' | 'drop' | 'reject' | 'fasttrack' | 'unknown';
  prefix: string;
  chain: 'input' | 'forward' | 'output';

  inInterface?: string;
  outInterface?: string;
  connectionState?: string;
  srcMac?: string;

  protocol: string;
  tcpFlags?: string;

  srcIp: string;
  srcPort?: number;
  dstIp: string;
  dstPort?: number;

  length?: number;

  /** The device runs zones (#415): the line reads from zone to zone. */
  zoned?: boolean;
  /** "Router" for the router's own traffic; missing for an interface in no zone. */
  fromZone?: string;
  toZone?: string;
  /** With names=1: the client's hostname or reverse DNS. */
  srcName?: string;
  dstName?: string;
}

/** Firewall log lines folded by rule, source, destination and port (#415). */
export interface FirewallGroup extends Omit<FirewallEvent, 'id' | 'eventTime' | 'severity' | 'topic' | 'srcPort'> {
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Policy routing rules (#370), in the device's order, with what's wrong with them. */
export interface RoutingRule {
  id: string; position: number;
  src: string | null; dst: string | null; routingMark: string | null; iface: string | null;
  action: string; table: string | null; minPrefix: string | null;
  disabled: boolean; invalid: boolean; dynamic: boolean; comment: string | null;
  flags: { level: 'warn' | 'info'; text: string }[];
}
export interface RoutingRulesData {
  ros6: boolean;
  rules: RoutingRule[];
  /** Each table a rule looks up, with its routes. */
  tables: { table: string; routes: { dst: string; gateway: string | null; distance: string | null; active: boolean }[] }[];
  /** The device's routing tables (RouterOS 7), for the add form. */
  table_names: string[] | null;
}
export interface RoutingRuleInput {
  'src-address'?: string; 'dst-address'?: string; 'routing-mark'?: string; interface?: string;
  action: string; table?: string; comment?: string;
  confirm_lockout?: boolean;
}

export const eventsApi = {
  topics: (params?: { firewall?: 1 }) =>
    api.get<{ topic: string; count: number }[]>('/events/topics', { params }),
  list: (params?: {
    deviceId?: number;
    severity?: string;
    topic?: string;
    search?: string;
    since?: string;
    limit?: number;
    offset?: number;
    /** 1 includes NTP/cloud clock adjustments, hidden by default (#213). */
    clock?: 1;
    /** 1 includes firewall packet logs, hidden by default (#334). */
    firewall?: 1;
  }) =>
    api.get<{ events: DeviceEvent[]; total: number; totalCapped: boolean; criticalCount: number }>('/events', { params }),
  /** The newest events only, without the totals the list endpoint also computes. */
  recent: (params: { severity?: string; limit: number }) =>
    api.get<{ events: DeviceEvent[] }>('/events', { params: { ...params, counts: 0 } }),
  firewall: (params?: {
    deviceId?: number;
    search?: string;
    since?: string;
    action?: FirewallEvent['action'];
    protocol?: string;
    limit?: number;
    offset?: number;
    names?: 1;
  }) =>
    api.get<{
      events: FirewallEvent[];
      total: number;
    }>('/events/firewall', { params }),
  /** The same filters, folded into groups (#415). */
  firewallGrouped: (params?: {
    deviceId?: number;
    search?: string;
    since?: string;
    action?: FirewallEvent['action'];
    protocol?: string;
    limit?: number;
    offset?: number;
    names?: 1;
  }) =>
    api.get<{ groups: FirewallGroup[]; total: number; scanLimit: number }>('/events/firewall', { params: { ...params, view: 'grouped' } }),
  clearFirewall: (deviceId?: number) =>
    api.delete<{ message: string; deleted: number }>('/events/firewall', {
      params: deviceId ? { deviceId } : {},
    }),
  clear: (deviceId?: number) =>
    api.delete('/events', { params: deviceId ? { deviceId } : {} }),
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
  /** Override set in the manager; null follows the fleet setting (#162). */
  update_channel?: string | null;
  /** The channel the device last reported during an update check. */
  reported_update_channel?: string | null;
  /** Same chips as the device list, so a tagged group is recognisable here. */
  tags?: { id: number; name: string; color: string }[];
  id: number; name: string; device_type: string; status: string; model: string | null;
  ros_version: string | null; latest_ros_version: string | null;
  firmware_update_available: boolean;
  firmware_version: string | null; upgrade_firmware_version: string | null;
  routerboard_upgrade_available: boolean;
  /** Set when the device pulls from a local mirror (#193). */
  mirror?: { mirror_id: number; status: string } | null;
  /** Newest version the mirror holds every one of this device's packages for. */
  mirror_version?: string | null;
  mirror_update_available?: boolean;
}

// ─── Local firmware mirror (#193) ─────────────────────────────────────────────
export interface MirrorFile { package: string; architecture: string; filename: string; size_bytes: number }
export interface FirmwareMirror {
  id: number;
  server: { id: number; name: string; ip_address: string; ros_version: string | null } | null;
  site: { id: number; name: string } | null;
  folder: string;
  /** Mount point of the disk holding the packages; null: internal storage. */
  disk: string | null;
  /** Where the packages are: `mtm-packages` or `sd1/mtm-packages`. */
  path: string;
  serve_address: string | null;
  effective_address: string;
  username: string;
  keep_versions: number;
  auto_sync: boolean;
  channel: 'stable' | 'long-term';
  status: 'new' | 'deployed' | 'syncing' | 'ready' | 'error';
  last_error: string | null;
  last_sync_at: string | null;
  free_bytes: number | null;
  total_bytes: number | null;
  used_bytes: number;
  versions: { version: string; files: MirrorFile[]; total_bytes: number }[];
  clients: { device_id: number; name: string; status: string; error: string | null }[];
  can_manage: boolean;
}
export interface MirrorDevice {
  id: number; name: string; ros_version: string | null; architecture: string | null; packages: string[];
  is_server: boolean; supported: boolean;
  client: { mirror_id: number; this_mirror: boolean; status: string; error: string | null } | null;
}
export interface MirrorClientResult { device_id: number; name: string; ok: boolean; message: string }
/** A place a mirror can keep packages (Discussion #85). */
export interface MirrorDisk { mount_point: string | null; label: string; free_bytes: number; size_bytes: number; ram: boolean }

export const mirrorApi = {
  list: () => api.get<{ mirrors: FirmwareMirror[]; can_create_fleet: boolean; admin_sites: number[] | null }>('/firmware/mirrors'),
  devices: (id: number) => api.get<MirrorDevice[]>(`/firmware/mirrors/${id}/devices`),
  plan: (id: number, version?: string) =>
    api.get<{ version: string; files: { package: string; architecture: string; filename: string }[]; skipped: { id: number; name: string; reason: string }[] }>(
      `/firmware/mirrors/${id}/plan`, { params: version ? { version } : {}, timeout: 30_000 }),
  disks: (deviceId: number) =>
    api.get<{ disks: MirrorDisk[]; suggested: string | null }>('/firmware/mirrors/disks', { params: { device_id: deviceId }, timeout: 30_000 }),
  create: (data: { device_id: number; site_id: number | null; folder?: string; disk?: string | null; serve_address?: string | null; keep_versions?: number; auto_sync?: boolean; channel?: string }) =>
    api.post<FirmwareMirror>('/firmware/mirrors', data, { timeout: 60_000 }),
  update: (id: number, data: { serve_address?: string | null; keep_versions?: number; auto_sync?: boolean; channel?: string; disk?: string | null }) =>
    api.put<{ mirror: FirmwareMirror; clients: MirrorClientResult[] | null }>(`/firmware/mirrors/${id}`, data, { timeout: 180_000 }),
  deploy: (id: number) =>
    api.post<{ user: string; clients: MirrorClientResult[]; mirror: FirmwareMirror }>(`/firmware/mirrors/${id}/deploy`, undefined, { timeout: 180_000 }),
  sync: (id: number, version?: string) => api.post<{ started: boolean }>(`/firmware/mirrors/${id}/sync`, version ? { version } : {}),
  setClients: (id: number, device_ids: number[], enable: boolean) =>
    api.post<{ results: MirrorClientResult[] }>(`/firmware/mirrors/${id}/clients`, { device_ids, enable }, { timeout: 300_000 }),
  remove: (id: number) => api.delete<{ notes: string[] }>(`/firmware/mirrors/${id}`, { timeout: 180_000 }),
};

export interface FirmwareRollout {
  id: number; name: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'missed';
  halt_on_failure: boolean; pre_backup: boolean; routerboot_after: boolean;
  kind?: 'routeros' | 'routerboot';
  /** Devices per wave allowed to upgrade at once; 1 is sequential (#135). */
  wave_concurrency?: number;
  /** Where devices got their packages (#193). */
  package_source?: 'mirror' | 'mikrotik';
  scheduled_at: string | null; started_at: string | null; finished_at: string | null; created_at: string;
  /** Latest time a scheduled rollout may start; null means within an hour of scheduled_at. */
  scheduled_until?: string | null;
  /** Command template run after each upgrade (#163), copied in at creation. */
  post_command?: string | null; post_template_name?: string | null;
  device_count?: number; success_count?: number; failed_count?: number;
}
export interface FirmwareRolloutDevice {
  id: number; rollout_id: number; device_id: number; wave: number;
  status: 'pending' | 'backing_up' | 'upgrading' | 'rebooting' | 'verifying' | 'post_commands' | 'success' | 'failed' | 'skipped';
  from_version: string | null; to_version: string | null; error: string | null;
  /** Post-upgrade commands (#163): 'ok' or 'failed', with what they printed. */
  post_status?: 'ok' | 'failed' | null; post_output?: string | null; post_error?: string | null;
  started_at: string | null; finished_at: string | null;
  device_name: string; device_type: string; model: string | null;
}

export const firmwareApi = {
  setChannel: (deviceIds: number[], channel: string | null) =>
    api.put<{ updated: number }>('/firmware/channel', { deviceIds, channel }),
  overview: () =>
    api.get<{ devices: FirmwareDeviceRow[]; latestRolloutId: number | null; runningRolloutId: number | null }>('/firmware/overview'),
  checkAll: () =>
    api.post<{ results: { name: string; ok: boolean; installed?: string; latest?: string; available?: boolean; error?: string }[] }>(
      '/firmware/check-all', undefined, { timeout: 180_000 }),
  createRollout: (data: {
    name: string; halt_on_failure: boolean; pre_backup: boolean; routerboot_after?: boolean;
    /** 'routerboot': upgrade the bootloader alone (#262). */
    kind?: 'routeros' | 'routerboot';
    scheduled_at?: string | null; start?: boolean;
    /** Don't start after this time (a missed window is recorded, not caught up). */
    scheduled_until?: string | null;
    /** Devices per wave allowed to upgrade at once; 1 is sequential (#135). */
    wave_concurrency?: number;
    /** 'mirror': devices set up for the local mirror pull from it (#193). */
    package_source?: 'mirror' | 'mikrotik';
    /** A command template to run on each device after its upgrade (#163). */
    post_template_id?: number | null;
    devices: { device_id: number; wave: number }[];
  }) => api.post<{ id: number }>('/firmware/rollouts', data),
  /** Advisory: selected devices that other selected devices depend on. */
  upstreamCheck: (ids: number[]) =>
    api.get<{ upstream: { id: number; name: string }[]; maxConcurrency: number }>(
      '/firmware/rollouts/upstream-check', { params: { ids: ids.join(',') } }
    ),
  listRollouts: () => api.get<FirmwareRollout[]>('/firmware/rollouts'),
  // One page of rollout history, newest first, with the total (#202).
  listRolloutsPage: (limit: number, offset: number) =>
    api.get<FirmwareRollout[]>('/firmware/rollouts', { params: { limit, offset } })
      .then((r) => ({ rows: r.data, total: Number(r.headers['x-total-count'] ?? r.data.length) })),
  getRollout: (id: number) =>
    api.get<FirmwareRollout & { devices: FirmwareRolloutDevice[] }>(`/firmware/rollouts/${id}`),
  startRollout: (id: number) => api.post(`/firmware/rollouts/${id}/start`),
  cancelRollout: (id: number) =>
    api.post<{ ok: boolean; note?: string }>(`/firmware/rollouts/${id}/cancel`),
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
  /** A device whose outage count this item reports, so it can be reset (#85). */
  resetOutagesDeviceId?: number;
  /** Stable identity used to dismiss an item that is otherwise recomputed. */
  fingerprint?: string;
}
export interface OpsCapacityRow {
  id: number; name: string; model?: string | null;
  cpu: number; mem_pct: number;
  /** The least memory used in the last 7 days, in % (#368). */
  mem_low_7d?: number | null;
  /** Highest CPU in the last 24 hours, and 48 half-hour peaks (null = no polls then) (#368). */
  cpu_peak_24h?: number | null; cpu_series?: (number | null)[];
}
export interface OpsActivityItem {
  at: string;
  kind: 'config' | 'audit' | 'alert';
  sev?: string;
  title: string;
  sub: string;
}
export interface OpsInsights {
  attention: OpsAttentionItem[];
  /** How many items are currently hidden by a dismissal. */
  dismissedCount?: number;
  capacity: OpsCapacityRow[];
  activity: OpsActivityItem[];
}
/** id from 1.0.5 on (#392), so a failed device can be linked to. */
export interface OpsActionResult { total: number; results: { id?: number; name: string; ok: boolean; error?: string }[] }

export const operationsApi = {
  /** A fleet page's Refresh: ask the online devices in view for a fresh poll. */
  pollNow: (kind: 'fast' | 'slow' | 'logs') => api.post<{ queued: number; recent?: boolean }>('/operations/poll-now', { kind }),
  insights: () => api.get<OpsInsights>('/operations/insights'),
  /** Every online device's hardening score, cached and refreshed a few at a time (#302). */
  securityPosture: (refresh = false) => api.get<{
    /** Every online device in view; one not read yet, or that couldn't be, has score null and its error. */
    devices: { id: number; name: string; ip_address?: string; device_type?: string; score: number | null; checks: SecurityCheck[]; fetched_at: string | null; error?: string | null }[];
    refreshing: number;
  }>('/operations/security-posture', { params: refresh ? { refresh: '1' } : undefined, timeout: 60_000 }),
  dismissInsight: (fingerprint: string, hours: number, category?: string, title?: string) =>
    api.post('/operations/insights/dismiss', { fingerprint, hours, category, title }),
  listDismissed: () =>
    api.get<{ fingerprint: string; category: string | null; title: string | null; expires_at: string }[]>(
      '/operations/insights/dismissed'),
  undismissInsight: (fingerprint: string) =>
    api.delete(`/operations/insights/dismiss/${encodeURIComponent(fingerprint)}`),
  backupAll: () => api.post<OpsActionResult>('/operations/backup-all', undefined, { timeout: 180_000 }),
  syncAll: () => api.post<OpsActionResult>('/operations/sync-all', undefined, { timeout: 180_000 }),
};

export interface BackupFilters {
  deviceId?: number | string;
  type?: string;
  from?: string;
  to?: string;
  search?: string;
}

export interface BackupContent {
  id: number;
  filename: string;
  device_name: string;
  device_id: number;
  backup_type: string | null;
  notes: string | null;
  size_bytes: number | null;
  created_at: string;
  content: string;
}

export interface BackupDiffSide {
  id: number;
  filename: string;
  device_name: string;
  created_at: string;
  text: string;
}

export const backupsApi = {
  list: (filters: BackupFilters = {}) => {
    // Drop empty values so an unset filter doesn't become `?type=`.
    const params = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined && v !== '')
    );
    return api.get<Backup[]>('/backups', { params });
  },
  /** One page, newest first, with the total for the filters (#221). */
  listPage: (filters: BackupFilters, limit: number, offset: number) => {
    const params = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined && v !== '')
    );
    return api.get<Backup[]>('/backups', { params: { ...params, limit, offset } })
      .then((r) => ({ rows: r.data, total: Number(r.headers['x-total-count'] ?? r.data.length) }));
  },
  types: () => api.get<{ type: string; count: number }[]>('/backups/types'),
  // A large configuration can take minutes to export; the default 30 seconds
  // gave up first and showed a bare "Backup failed" (Discussion #85).
  create: (deviceId: number, notes?: string) =>
    api.post<Backup>('/backups', { deviceId, notes }, { timeout: LONG_DEVICE_OP_MS }),
  download: (id: number) =>
    api.get(`/backups/${id}/download`, { responseType: 'blob' }),
  content: (id: number) => api.get<BackupContent>(`/backups/${id}/content`),
  diff: (fromId: number, toId: number) =>
    api.get<{ from: BackupDiffSide; to: BackupDiffSide }>(`/backups/${fromId}/diff/${toId}`),
  restore: (id: number) => api.post<{ status: string; message: string }>(`/backups/${id}/restore`, undefined, { timeout: LONG_DEVICE_OP_MS }),
  delete: (id: number) => api.delete(`/backups/${id}`),
  bulkDeletePreview: (ids: number[]) =>
    api.get<{ backups: number; snapshots: number; devices: { name: string; count: number }[] }>(
      '/backups/bulk-delete/preview', { params: { ids: ids.join(',') } }
    ),
  bulkDelete: (ids: number[]) =>
    api.post<{ deleted: number; requested: number; failures: { id: number; error: string }[] }>(
      '/backups/bulk-delete', { ids }
    ),
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
/** Device graphs (#402). */
export type GraphPoint = { time: string } & Record<string, number | string>;
export interface DropRuleRow { rule: string; label: string; chain: string; packets: number }
export interface GraphInterface {
  name: string;
  speed_bps: number | null;
  points: { time: string; rx_bps?: number; tx_bps?: number; rx_pps?: number; tx_pps?: number }[];
}

export const metricsApi = {
  deviceSeries: (deviceId: number, m: 'conntrack' | 'conntrack_split' | 'firewall_drops' | 'cpu_cores' | 'health_temps', range: string) =>
    api.get<GraphPoint[]>(`/metrics/device/${deviceId}/series`, { params: { m, range } }),
  deviceDropRules: (deviceId: number, range: string) =>
    api.get<DropRuleRow[]>(`/metrics/device/${deviceId}/drop-rules`, { params: { range } }),
  deviceInterfaces: (deviceId: number, range: string, ifaces?: string[]) =>
    api.get<{ interfaces: GraphInterface[]; available: string[] }>(`/metrics/device/${deviceId}/interfaces`,
      { params: { range, ...(ifaces && ifaces.length ? { ifaces: ifaces.join(',') } : {}) } }),
  /** Every device's CPU series in one request, for list sparklines (#302). */
  cpuHistory: (range = '1h') => api.get<{ devices: Record<string, number[]> }>('/metrics/resources/cpu-history', { params: { range } }),
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
  interfaceDrops: (deviceId: number, iface: string, range = '1h') =>
    api.get<{ time: string; errors: number; drops: number; queue_drops: number }[]>(
      `/metrics/interface/${deviceId}/${encodeURIComponent(iface)}/drops`, { params: { range } }),
  deviceResources: (deviceId: number, range = '24h') =>
    api.get<ResourcePoint[]>(`/metrics/device/${deviceId}/resources`, { params: { range } }),
  deviceAvailability: (deviceId: number, range = '30d') =>
    api.get<DeviceAvailability>(`/metrics/device/${deviceId}/availability`, { params: { range } }),
  devicePoe: (deviceId: number) =>
    api.get<{ ports: { port: string; watts: number; current_ma: number; voltage_v: number }[]; totalWatts: number; history: { time: string; port: string; watts: number }[] }>(`/metrics/device/${deviceId}/poe`),
};

// ─── Topology ────────────────────────────────────────────────────────────────
export const topologyApi = {
  /** `siteId`: draw that site whatever the site switcher says (the device view, #305). */
  get: (withClients = false, siteId?: number | null) =>
    api.get<{
      devices: Device[];
      links: import('../types').TopologyLink[];
      externalNodes: import('../types').ExternalTopologyNode[];
      /** What each bridge reports about the spanning tree (#131). */
      bridges: import('../utils/stpRoot').BridgeInfo[];
      /** Each device's upstream as resolved from spanning tree, server-side. */
      upstreams: import('../utils/topologyGraph').StpUpstream[];
      /** Each device's way up, for the tiered layout (#367). From 1.1.0-beta.14. */
      waysUp?: import('../utils/topologyTiers').WayUp[];
      /** Every spanning-tree root, named when it's unmanaged and discovery saw it (#260). */
      stpDomains?: import('../utils/topologyGraph').StpDomainInfo[];
      /** Nodes added by hand, and links drawn by hand (#147). */
      nodes: import('../types').TopologyNode[];
      handLinks: import('../types').HandLink[];
      /** How the map has been arranged by hand: node positions and link sides. */
      layout: {
        positions: Record<string, { x: number; y: number }>;
        anchors: Record<string, { sourceHandle: 't' | 'b' | 'l' | 'r' | null; targetHandle: 't' | 'b' | 'l' | 'r' | null }>;
        /** A colour per link, #rrggbb (#260). */
        colors?: Record<string, string>;
      };
      /** What neighbours discovery found really are, set by hand (#260). */
      neighbourOverrides?: Record<string, { name: string | null; kind: string | null }>;
      /** Only with withClients: client devices and where they connect. */
      clients?: import('../types').TopologyClient[];
      /** Discovered links hidden by hand (discussion #85). */
      hiddenLinks?: { key: string; label: string | null; hiddenAt: string; hiddenBy: string | null }[];
    }>('/topology', {
      params: withClients ? { clients: 1 } : undefined,
      headers: siteId != null ? { 'X-Site-Id': String(siteId) } : undefined,
    }),
  discover: () => api.post('/topology/discover'),
  createHandLink: (a: import('../types').HandLinkEnd, b: import('../types').HandLinkEnd, label?: string) =>
    api.post<import('../types').HandLink>('/topology/hand-links', { a, b, label }),
  deleteHandLink: (id: number) => api.delete(`/topology/hand-links/${id}`),
  /** Hide a discovered link (discussion #85); `label` is what the list of hidden links shows. */
  hideLink: (key: string, label: string) => api.post('/topology/hidden-links', { key, label }),
  showLink: (key: string) => api.delete('/topology/hidden-links', { params: { key } }),
  /** Save node positions and link sides; merged into what's saved. A null anchor goes back to automatic. */
  saveLayout: (data: {
    positions?: Record<string, { x: number; y: number }>;
    anchors?: Record<string, { sourceHandle: string | null; targetHandle: string | null } | null>;
    colors?: Record<string, string | null>;
  }) => api.put('/topology/layout', data),
  /** Ports at each end and the label of a link drawn by hand (#260); null clears. */
  updateHandLink: (id: number, data: { label?: string | null; a_port?: string | null; b_port?: string | null }) =>
    api.put<import('../types').HandLink>(`/topology/hand-links/${id}`, data),
  /** A name and type for a neighbour discovery found (#260); both null go back to discovery's. */
  setNeighbour: (extId: string, data: { name: string | null; kind: string | null }) =>
    api.put(`/topology/neighbours/${encodeURIComponent(extId)}`, data),
  /** Forget the arrangement of these nodes and links, so they're laid out automatically again. */
  resetLayout: (keys: string[], edges: string[]) => api.post('/topology/layout/reset', { keys, edges }),
  createNode: (data: { name: string; kind: string; address?: string | null; notes?: string | null }) =>
    api.post<import('../types').TopologyNode>('/topology/nodes', data),
  updateNode: (id: number, data: { name?: string; kind?: string; address?: string | null; notes?: string | null }) =>
    api.put<import('../types').TopologyNode>(`/topology/nodes/${id}`, data),
  deleteNode: (id: number) => api.delete(`/topology/nodes/${id}`),
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
  getSnmpStatus: () => api.get<{
    id: number; name: string; ip_address: string;
    enabled: boolean | null; community_name?: string; version?: string;
    auth_protocol?: string; priv_protocol?: string;
    contact?: string; location?: string; trap_target?: string;
    error?: string;
  }[]>('/routers/snmp'),
  /** Only the fields present are changed on each device. */
  setSnmp: (config: {
    enabled?: boolean; community_name?: string; version?: 'v1' | 'v2c' | 'v3';
    contact?: string; location?: string; trap_target?: string;
    auth_protocol?: string; auth_password?: string;
    priv_protocol?: string; priv_password?: string;
  }) => api.put<{
    applied: number; total: number;
    results: { id: number; name: string; success: boolean; error?: string }[];
  }>('/routers/snmp', config),
};

/** Policy routing rules on a device (#370). */
export const routingRulesApi = {
  list: (id: number) =>
    api.get<RoutingRulesData>(`/devices/${id}/routing/rules`),
  add: (id: number, data: RoutingRuleInput) =>
    api.post(`/devices/${id}/routing/rules`, data),
  remove: (id: number, itemId: string, confirmLockout = false) =>
    api.delete(`/devices/${id}/routing/rules/${encodeURIComponent(itemId)}`,
      confirmLockout ? { params: { confirm_lockout: 'true' } } : undefined),
};

// ─── Zone-based firewall (#369) ───────────────────────────────────────────────
export type ZoneAction = 'deny' | 'allow' | 'services';
/** A rule of your own: protocol and ports, and optionally a source and destination address (#369). */
/** `icmp` is a type or type:code for ICMP; `number` an IP protocol number for "other" (#369). */
export interface ZoneCustomService {
  protocol: 'tcp' | 'udp' | 'any' | 'icmp' | 'other'; ports: string; icmp?: string; number?: string; src?: string; dst?: string;
}
export interface ZonePolicy { action: ZoneAction; services: string[]; custom: ZoneCustomService[] }
export interface ZoneConfig {
  zones: string[];
  intra: Record<string, boolean>;
  /** `${from}>${to}`, where `to` is a zone or '@router'. */
  policies: Record<string, ZonePolicy>;
  fasttrack: boolean;
  logDrops: boolean;
  /** The manager reaches only its API, API-SSL and SSH ports on the router; missing means everything (#369). */
  managerAccess?: 'management';
}
export interface ZoneRequest { config: ZoneConfig; members: Record<string, string[]> }
export interface ZonesData {
  enabled: boolean;
  config: ZoneConfig | null;
  applied_at: string | null;
  applied_by: string | null;
  eligible: boolean;
  foreign_rules: number;
  lists: { name: string; members: { interface: string; dynamic: boolean }[] }[];
  interfaces: { name: string; type: string; running: boolean; disabled: boolean; bridge_port: boolean; addresses: string[] }[];
  manager_ip: string | null;
  drift: { missing: string[]; extra: string[] } | null;
  services: { forward: { key: string; label: string }[]; router: { key: string; label: string }[] };
}
export interface ZonePlan {
  errors: Record<string, string>;
  warnings: string[];
  rules: (Record<string, string> & { hidden: boolean; description: string })[];
  changes: {
    add: number; remove: number; keep: number; lists: string[];
    members_added: { list: string; interface: string }[]; members_removed: { list: string; interface: string }[];
    /** Address lists kept for hostnames in rules (#369). */
    host_lists_added?: string[]; host_lists_removed?: string[];
  } | null;
}

export const zonesApi = {
  get: (id: number) => api.get<ZonesData>(`/devices/${id}/firewall/zones`),
  plan: (id: number, body: ZoneRequest) => api.post<ZonePlan>(`/devices/${id}/firewall/zones/plan`, body),
  apply: (id: number, body: ZoneRequest, confirmLockout = false) =>
    api.put<{ message: string; added: number; removed: number; kept: number }>(`/devices/${id}/firewall/zones`,
      { ...body, ...(confirmLockout ? { confirm_lockout: true } : {}) }),
  turnOff: (id: number) => api.delete<{ message: string }>(`/devices/${id}/firewall/zones`),
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
  getSnmpStatus: () => api.get<{
    id: number; name: string; ip_address: string;
    enabled: boolean | null; community_name?: string; version?: string;
    auth_protocol?: string; priv_protocol?: string;
    contact?: string; location?: string; trap_target?: string;
    error?: string;
  }[]>('/switches/snmp'),
  /** Only the fields present are changed on each device. */
  setSnmp: (config: {
    enabled?: boolean; community_name?: string; version?: 'v1' | 'v2c' | 'v3';
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
  type: 'email' | 'slack' | 'discord' | 'telegram' | 'ntfy' | 'gotify';
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

/** Addresses brute-force protection has banned (#405), from the slow polls. */
export interface FirewallBan { device_id: number; device_name: string; address: string; time_left: string | null; first_seen: string; updated_at: string }
export const firewallBansApi = {
  list: () => api.get<FirewallBan[]>('/firewall-bans'),
};

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
/** Which key protects stored credentials, and how much is under each (outside review P2-29). */
export interface EncryptionOverview {
  source: 'env' | 'persisted';
  key_id: string;
  saved_previous_keys: number;
  env_previous_keys: number;
  key_missing: boolean;
  locations: Array<{ location: string; current: number; old: number; unreadable: number }>;
  totals: { current: number; old: number; unreadable: number };
  can_rotate: boolean;
  can_retire: boolean;
}

export const encryptionApi = {
  overview: () => api.get<EncryptionOverview>('/settings/encryption'),
  rotate: () => api.post<EncryptionOverview & { message: string }>('/settings/encryption/rotate', undefined, { timeout: 300_000 }),
  reencrypt: () => api.post<EncryptionOverview & { message: string }>('/settings/encryption/reencrypt', undefined, { timeout: 300_000 }),
  retire: () => api.post<EncryptionOverview & { message: string }>('/settings/encryption/retire'),
};

export const settingsApi = {
  get: () => api.get<Record<string, unknown>>('/settings'),
  update: (data: Record<string, unknown>) => api.put('/settings', data),
  getUsers: () => api.get('/settings/users'),
  createUser: (data: { username: string; password: string; role?: string }) =>
    api.post('/settings/users', data),
  /**
   * `site_roles` and `group_roles` (#306): both empty makes the account
   * fleet-wide; any entry limits it to those sites and groups' sites (P1-7).
   */
  updateUser: (id: number, data: { role?: string; password?: string; site_roles?: Array<{ site_id: number; role: string }>; group_roles?: Array<{ group_id: number; role: string }> }) =>
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

export interface AcmeSettings {
  domain: string;
  email: string;
  server: string;
  source: 'web' | 'environment';
  readOnly: boolean;
}

export interface AcmeAttempt {
  time: string;
  action: 'issue' | 'renew';
  exitCode: number;
  domain: string;
  output: string;
}

export const certApi = {
  get: () => api.get<CertInfo>('/cert'),
  regenerate: () => api.post<CertInfo & { message: string }>('/cert/regenerate'),
  upload: (certificate: string, private_key: string) =>
    api.post<CertInfo & { message: string }>('/cert/upload', { certificate, private_key }),
  getAcme: () => api.get<AcmeSettings>('/cert/acme'),
  getAcmeStatus: () => api.get<{ lastAttempt: AcmeAttempt | null }>('/cert/acme/status'),
  updateAcme: (data: Pick<AcmeSettings, 'domain' | 'email' | 'server'>) => api.put('/cert/acme', data),
  resetAcme: () => api.delete('/cert/acme'),
  getAcmeCaBundle: () => api.get<{ installed: boolean; readOnly: boolean }>('/cert/acme/ca-bundle'),
  uploadAcmeCaBundle: (certificate: string) => api.put('/cert/acme/ca-bundle', { certificate }),
  deleteAcmeCaBundle: () => api.delete('/cert/acme/ca-bundle'),
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
  alignment: (deviceId: number, signal?: AbortSignal) =>
    api.get<AlignmentSnapshot>(`/wireless/${deviceId}/alignment`, { signal, timeout: 20_000 }),
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
  deleteInterface:  (apId: number, name: string, confirmLockout = false) =>
    api.delete(`/wireless/${apId}/interfaces/${encodeURIComponent(name)}`, confirmLockout ? { params: { confirm_lockout: 'true' } } : undefined),

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
  // POST: a scan disturbs the radio, so a link or a page load can't start one (U13).
  scan:                 (apId: number, iface: string) =>
    api.post(`/wireless/${apId}/scan/${encodeURIComponent(iface)}`, undefined, { timeout: 60_000 }),

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
};

// ─── Network Services ─────────────────────────────────────────────────────────

type NS = Record<string, string>;

/** How full one address pool is (#156); state 'warn' from 80%, 'full' from 95%. */
export interface DhcpPoolUsageRow {
  device_id: number; device_name: string; name: string; ranges: string | null;
  size: number | null; used: number; updated_at: string; state: 'warn' | 'full' | null;
}

export const networkServicesApi = {
  poolUsage: () => api.get<DhcpPoolUsageRow[]>('/network-services/dhcp/pool-usage'),
  // Overview
  // Cached per device and refreshed a few at a time (#302); refresh=true re-reads every device.
  overview: (refresh = false) =>
    api.get<Record<string, unknown>[]>('/network-services/overview', { timeout: 60_000, params: refresh ? { refresh: '1' } : undefined }),

  // ── LLDP, every device type ───────────────────────────────────────────────
  /** SNMP settings of every online device in the site, of any type. */
  getSnmp: () => api.get<{
    id: number; name: string; ip_address: string; device_type: string;
    enabled: boolean | null; community_name?: string; version?: string;
    auth_protocol?: string; priv_protocol?: string;
    contact?: string; location?: string; trap_target?: string;
    error?: string;
  }[]>('/network-services/snmp'),
  /** Contact / location / trap destination as last applied, variables and all (#164). */
  getSnmpTemplates: () => api.get<{ contact?: string; location?: string; trap_target?: string }>('/network-services/snmp/templates'),
  /** Change SNMP on the given devices (or "all" in the site). Only the fields present are changed. */
  setSnmp: (deviceIds: number[] | 'all', config: {
    enabled?: boolean; community_name?: string; version?: 'v1' | 'v2c' | 'v3';
    contact?: string; location?: string; trap_target?: string;
    auth_protocol?: string; auth_password?: string;
    priv_protocol?: string; priv_password?: string;
  }) => api.put<{
    applied: number; total: number; skipped: number[];
    results: { id: number; name: string; success: boolean; error?: string }[];
  }>('/network-services/snmp', { device_ids: deviceIds, ...config }),
  getLldp: () => api.get<{
    id: number; name: string; ip_address: string; device_type: string;
    enabled: boolean | null; protocol: string | null; error?: string;
  }[]>('/network-services/lldp', { timeout: 60_000 }),
  /** device_types omitted = every type. */
  setLldp: (enabled: boolean, device_types?: string[]) => api.put<{
    applied: number; total: number;
    results: { id: number; name: string; success: boolean; error?: string }[];
  }>('/network-services/lldp', { enabled, device_types }, { timeout: 60_000 }),

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
    api.get<{
      interfaces: NS[]; peers: NS[];
      /** The tunnel the manager reaches this device through, if it does (#205). */
      management: { interface: string; interface_id: string | null; peer_ids: string[]; peer_certain: boolean; manager_ip: string | null; reason: string } | null;
    }>('/network-services/wireguard', { params: { deviceId } }),
  addWireGuardInterface: (deviceId: number, body: NS) =>
    api.post<NS[]>('/network-services/wireguard', body, { params: { deviceId } }),
  updateWireGuardInterface: (deviceId: number, id: string, body: NS) =>
    api.put<NS[]>(`/network-services/wireguard/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteWireGuardInterface: (deviceId: number, id: string, confirmLockout = false) =>
    api.delete(`/network-services/wireguard/${encodeURIComponent(id)}`, { params: { deviceId, ...(confirmLockout ? { confirm_lockout: 'true' } : {}) } }),
  toggleWireGuard: (deviceId: number, interfaceId: string, disabled: boolean, confirmLockout = false) =>
    api.put('/network-services/wireguard/toggle', { interfaceId, disabled, ...(confirmLockout ? { confirm_lockout: true } : {}) }, { params: { deviceId } }),
  addWireGuardPeer: (deviceId: number, body: NS) =>
    api.post<NS[]>('/network-services/wireguard/peer', body, { params: { deviceId } }),
  updateWireGuardPeer: (deviceId: number, id: string, body: NS) =>
    api.put<NS[]>(`/network-services/wireguard/peer/${encodeURIComponent(id)}`, body, { params: { deviceId } }),
  deleteWireGuardPeer: (deviceId: number, id: string) =>
    api.delete(`/network-services/wireguard/peer/${encodeURIComponent(id)}`, { params: { deviceId } }),

  // ── NetFlow ───────────────────────────────────────────────────────────────
  netflowFleet: (refresh = false) =>
    api.get<{
      collector: { address: string; port: number; version: string; listening: boolean };
      devices: NetflowDeviceState[];
    }>('/network-services/netflow/fleet', { timeout: 60_000, params: refresh ? { refresh: '1' } : undefined }),
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
  /** Session log on for this device (#415). */
  sessions?: boolean;
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
export interface TrafficAppClients {
  app: string;
  total_bytes: number;
  client_count: number;
  clients: (TrafficTopClient & { share: number })[];
}
export interface TrafficCollectorStats {
  listening: boolean;
  port: number;
  packetsReceived: number;
  flowsDecoded: number;
  flowsAttributed: number;
  packetsFromUnknownExporter: number;
  recordsWithoutTemplate: number;
  exporters: { deviceId: number; deviceName: string; packets: number; flows: number; lastSeen: string | null }[];
  /** Whether flows from sources that aren't managed devices are taken (outside review P2-23). */
  acceptUnknown?: boolean;
  /** Sources whose flows are being refused, and why. Empty when viewing one site. */
  rejectedSources?: { address: string; reason: 'unknown_exporter' | 'public_address'; packets: number; lastSeen: string }[];
  /** True when `exporters` is limited to the selected site; the counters stay collector-wide (#236). */
  site_filtered?: boolean;
  /** Session log (#415): open in memory, written since start, dropped for being over a bound. */
  sessions?: { open: number; written: number; dropped: number };
}

// ─── Session log (#415) ──────────────────────────────────────────────────────

export type SessionEndReason = 'fin' | 'reset-client' | 'reset-server' | 'no-reply' | 'aged-out';

export interface NetflowSession {
  id: number;
  device_id: number | null;
  device_name: string | null;
  exporter: string | null;
  protocol: number;
  client_addr: string;
  client_port: number;
  server_addr: string;
  server_port: number;
  client_nat_addr: string | null;
  client_nat_port: number | null;
  server_nat_addr: string | null;
  server_nat_port: number | null;
  client_mac: string | null;
  client_name: string | null;
  app: string | null;
  started_at: string;
  ended_at: string;
  bytes_out: number;
  bytes_in: number;
  packets_out: number;
  packets_in: number;
  flags_out: number | null;
  flags_in: number | null;
  end_reason: SessionEndReason;
}

export interface SessionFilters {
  deviceId?: number;
  since?: string;
  address?: string;
  port?: string;
  protocol?: string;
  reason?: string;
  app?: string;
  limit?: number;
  offset?: number;
}

export const sessionsApi = {
  list: (params: SessionFilters) =>
    api.get<{ sessions: NetflowSession[]; total: number; totalCapped: boolean }>('/sessions', { params }),
  setDevice: (deviceId: number, enabled: boolean) =>
    api.put<{ id: number; sessions: boolean }>(`/sessions/devices/${deviceId}`, { enabled }),
};

export const trafficApi = {
  status: () => api.get<TrafficCollectorStats>('/traffic/status'),
  timeseries: (range = '24h') =>
    api.get<ClientTrafficPoint[]>('/traffic/timeseries', { params: { range } }),
  topClients: (range = '24h', limit = 10) =>
    api.get<TrafficTopClient[]>('/traffic/top-clients', { params: { range, limit } }),
  apps: (range = '24h', mac?: string) =>
    api.get<TrafficApp[]>('/traffic/apps', { params: { range, mac } }),
  /** Who generates one application's traffic (#366). */
  appClients: (app: string, range = '24h') =>
    api.get<TrafficAppClients>(`/traffic/apps/${encodeURIComponent(app)}/clients`, { params: { range } }),
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
  /** Tags on one device. The single-device payload does not carry them. */
  forDevice: (deviceId: number) =>
    api.get<import('../types').Tag[]>(`/tags/device/${deviceId}`),
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

export default api;

// ─── Sites (issue #130) ───────────────────────────────────────────────────────
export interface SitePayload {
  name?: string;
  address?: string;
  notes?: string;
  location_lat?: number | null;
  location_lng?: number | null;
  /** The zoom its map opens at, 1 to 19; null to fit the map (#362). */
  map_zoom?: number | null;
  /** The group it belongs to; null for none (#306). */
  group_id?: number | null;
  /** Pre-fills new devices in the site; null for direct. */
  default_jump_host_id?: number | null;
}

/** RoMON settings: a fleet default, and per group or site (#311). Secrets are write-only. */
export interface RomonSettingRow { scope: 'fleet' | 'group' | 'site'; id: number | null; name: string | null; enabled: boolean; has_secret: boolean }
export const romonApi = {
  list: () => api.get<RomonSettingRow[]>('/romon/settings'),
  /** `secret`: omit to keep, null to remove, text to set. */
  save: (payload: { scope: RomonSettingRow['scope']; id?: number | null; enabled: boolean; secret?: string | null }) =>
    api.put<{ ok: boolean }>('/romon/settings', payload),
  remove: (scope: RomonSettingRow['scope'], id?: number | null) =>
    api.delete<{ ok: boolean }>('/romon/settings', { data: { scope, id } }),
};

/** Groups of sites, one customer each (#306). */
export const siteGroupsApi = {
  list: () => api.get<import('../store/siteStore').SiteGroup[]>('/site-groups'),
  create: (payload: { name: string; notes?: string | null; site_ids?: number[] }) =>
    api.post<import('../store/siteStore').SiteGroup>('/site-groups', payload),
  update: (id: number, payload: { name?: string; notes?: string | null; site_ids?: number[] }) =>
    api.put<{ ok: boolean }>(`/site-groups/${id}`, payload),
  remove: (id: number) => api.delete<{ ok: boolean }>(`/site-groups/${id}`),
};

export const sitesApi = {
  list: () => api.get<import('../store/siteStore').Site[]>('/sites'),
  create: (payload: SitePayload) =>
    api.post<import('../store/siteStore').Site>('/sites', payload),
  update: (id: number, payload: SitePayload) =>
    api.put<import('../store/siteStore').Site>(`/sites/${id}`, payload),
  remove: (id: number) => api.delete<{ ok: boolean }>(`/sites/${id}`),
  /** Move devices into this site, several at once (#306). */
  moveDevices: (id: number, deviceIds: number[]) =>
    api.post<{ ok: boolean; moved: number }>(`/sites/${id}/devices`, { deviceIds }),
  /** Settings this site overrides (#261); null in a PUT clears one. */
  getPollSettings: (id: number) => api.get<PollSettings>(`/sites/${id}/poll-settings`),
  setPollSettings: (id: number, data: Record<string, number | boolean | null>) => api.put<PollSettings>(`/sites/${id}/poll-settings`, data),
  assignDevices: (id: number, deviceIds: number[]) =>
    api.post<{ ok: boolean; moved: number }>(`/sites/${id}/devices`, { deviceIds }),
};

// ─── Certificates (#143) ──────────────────────────────────────────────────────
export type CertState = 'revoked' | 'expired' | 'expiring' | 'not-yet-valid' | 'valid' | 'unknown';

export interface DeviceCertificate {
  device_id: number;
  device_name: string;
  name: string;
  common_name: string | null;
  serial_number: string | null;
  fingerprint: string | null;
  key_type: string | null;
  key_size: number | null;
  invalid_before: string | null;
  invalid_after: string | null;
  is_authority: boolean;
  has_private_key: boolean;
  trusted: boolean;
  /** Withdrawn by its issuer. Not derivable from the dates. */
  revoked: boolean;
  /** When it was withdrawn, where RouterOS reported it. */
  revoked_at: string | null;
  updated_at: string;
  /** Decided server-side, so this page and the alert cannot disagree. */
  state: CertState;
  days_left: number | null;
  summary: string;
}

export interface CertificatesResponse {
  certificates: DeviceCertificate[];
  warnDays: number;
  alertingEnabled: boolean;
  counts: Partial<Record<CertState, number>>;
  /** How many would alert. Server-derived, so it matches what gets sent. */
  attentionCount: number;
}

// ─── RouterOS vulnerabilities (#175) ──────────────────────────────────────────
export interface FleetCve {
  id: string; severity: string | null; score: number | null; known_exploited: boolean;
  published: string | null; summary: string; fixed_in: string | null; hardware_specific: boolean;
  /** Why the match may not really apply (an open-ended "before 7.x" entry on v6); null when sure. */
  uncertain: string | null;
  /** NVD's affected versions, or MikroTik's release notes (discussion #85). */
  source?: 'nvd' | 'release_notes';
  /** The release whose notes say it fixes this CVE, and the line saying so. */
  release_note?: { version: string; line: string } | null;
}
export interface FleetCveReport {
  enabled: boolean;
  fetched_at: string | null;
  last_error: string | null;
  total_cves: number;
  unranged: number;
  versions: {
    version: string; devices: { id: number; name: string }[]; cves: FleetCve[];
    /** Matches a known correction to NVD removed, with the reason. */
    corrected: { id: string; reason: string }[];
  }[];
}
export const cvesApi = {
  report: () => api.get<FleetCveReport>('/security/cves'),
  refresh: () => api.post<FleetCveReport>('/security/cves/refresh', undefined, { timeout: 120_000 }),
};

export const certificatesApi = {
  list: (deviceId?: number) =>
    api.get<CertificatesResponse>('/certificates', {
      params: deviceId ? { deviceId } : {},
    }),
};

// ── Adoption of factory-default devices ───────────────────────────────────

export interface AdoptionJumpHost {
  id: number;
  name: string;
  ip_address: string;
}

export type AdoptionMode = 'adopt' | 'add';

export interface ModeRecommendation {
  mode: AdoptionMode;
  confidence: 'high' | 'low';
  reasons: string[];
}

export interface AdoptionCandidate {
  mac: string;
  address: string;
  identity: string | null;
  /** Whether this looks like a new device or one already in service. */
  recommendation: ModeRecommendation;
  /** Managed devices on the same broadcast domain; one must be borrowed. */
  seenBy: AdoptionJumpHost[];
  /** Sitting on RouterOS's 192.168.88.1 factory address. */
  factoryDefault: boolean;
  /** When true the normal "add device" flow works and adoption is unnecessary. */
  reachableDirectly: boolean;
}

export interface AdoptionStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface AdoptionResult {
  ok: boolean;
  steps: AdoptionStep[];
  deviceId?: number;
  error?: string;
}

export type AddressPlan =
  | { mode: 'dhcp'; vlanId?: number }
  | { mode: 'static'; address: string; prefix: number; gateway: string; vlanId?: number };

export interface AdoptRequest {
  mac: string;
  jumpHostId: number;
  /** How to address the device. Asked for, never inferred. */
  plan: AddressPlan;
  password: string;
  username?: string;
  identity?: string;
  name?: string;
  removeFactoryAddress?: boolean;
  /** Adopt despite the device not looking factory-default. */
  force?: boolean;
}

export const adoptionApi = {
  candidates: () => api.get<{ candidates: AdoptionCandidate[] }>('/adoption/candidates'),
  checkAddress: (jumpHostId: number, address: string) =>
    api.post<{ free: boolean; reason?: string }>('/adoption/check-address', { jumpHostId, address }),
  adopt: (body: AdoptRequest) => api.post<AdoptionResult>('/adoption/adopt', body),
  cleanup: () => api.post<{ removed: number }>('/adoption/cleanup'),
};

/** One internet-dependent feature, as listed in Dark Site Mode. */
export interface DarkSiteFeature {
  key: string;
  label: string;
  destination: string;
  cost: string;
  enabled: boolean;
}

export interface ProxyTopRow {
  key: string;
  requests: number;
  bytes_in: number;
  bytes_out: number;
  distinct_peers: number;
  last_seen: string;
}
export interface ProxySource { source: string; proxy_type: string; proxy_port: number | null }

export const proxyApi = {
  top: (params: { by: 'client' | 'user' | 'destination' | 'denied'; range: string; limit?: number; source?: string; port?: number }) =>
    api.get<ProxyTopRow[]>('/proxy/top', { params }),
  sources: () => api.get<ProxySource[]>('/proxy/sources'),
};

/** Frame errors and link drops on one port over the last hour (#249). */
export interface PortErrorSummary {
  interface: string;
  hour: { fcs: number; align: number; overflow: number; other: number; link_downs: number };
  /** Errors a minute, averaged over the last 5 minutes. */
  rate_per_min: number;
  last_error_ago_sec: number | null;
  /** 'alert': over a threshold (red). 'errors': errors still arriving, below it (yellow). */
  state: 'alert' | 'errors' | null;
  flapping: boolean;
}

export interface InterfaceErrorsResponse {
  ports: PortErrorSummary[];
  errors_per_min: number;
  flaps_per_hour: number;
}

/** An optic's light levels against its usual level (the past week's median). */
export interface OpticStatus {
  interface: string;
  rx_dbm: number | null;
  tx_dbm: number | null;
  temp_c: number | null;
  bias_ma: number | null;
  voltage: number | null;
  rx_lanes: number[];
  usual_rx_dbm: number | null;
  usual_tx_dbm: number | null;
  rx_drop_db: number | null;
  tx_drop_db: number | null;
  /** 'alert': at or past the threshold, or too hot (red). 'watch': halfway there (yellow). */
  state: 'alert' | 'watch' | null;
  reason: string | null;
}

export interface OpticsResponse {
  ports: OpticStatus[];
  drop_db: number;
}

export interface OpticHistoryPoint {
  at: string;
  rx_dbm: number | null;
  tx_dbm: number | null;
  temp_c: number | null;
}

// ─── User Manager (#251) ─────────────────────────────────────────────────────

export type UmRow = Record<string, string>;
export interface UserManagerServer { id: number; name: string; ip_address: string; status: string; model: string | null }
export interface UserManagerView {
  device: { id: number; name: string; ip_address: string };
  settings: UmRow;
  users: UmRow[];
  groups: UmRow[];
  routers: { row: UmRow; managed_device: { id: number; name: string } | null }[];
  sessions: { active: UmRow[]; recent: UmRow[] };
}
export const userManagerApi = {
  servers: () => api.get<{ servers: UserManagerServer[]; unchecked: number; oldest_check: string | null }>('/user-manager'),
  get: (id: number) => api.get<UserManagerView>(`/user-manager/${id}`, { timeout: 45_000 }),
  removeSession: (id: number, sid: string) => api.post<{ ok: boolean }>(`/user-manager/${id}/sessions/${encodeURIComponent(sid)}/remove`),
  recheck: () => api.post<{ ok: boolean }>('/user-manager/recheck'),
};

/** A client's firewall address lists on one router (#145). */
export interface ClientAddressListView {
  address: string;
  lists: string[];
  member: { list: string; id: string; dynamic: boolean; disabled: boolean; comment: string | null; timeout: string | null }[];
  /** Lists a firewall rule matches on. */
  referenced: string[];
  lease: { static: boolean; host: string | null } | null;
}

/** L3 hardware offloading on a device's switch chip (#254). */
// ─── Platform backup (MikroTik Manager itself) ────────────────────────────────
export type PlatformBackupContents = 'config' | 'config+database';
export interface PlatformBackupHeader { format: number; app_version: string; created_at: string; contents: PlatformBackupContents }
export interface PlatformBackupRow {
  id: number; file_name: string; contents: PlatformBackupContents; trigger: 'manual' | 'scheduled' | 'pre-restore';
  status: 'running' | 'success' | 'failed'; size_bytes: number | null; app_version: string | null; error: string | null;
  destinations: { id: number; name: string; type: string; ok: boolean; error?: string; pruned?: number }[];
  created_at: string; finished_at: string | null; created_by: string | null;
}
export interface PlatformBackupDestination {
  id: number; type: 's3' | 'sftp' | 'email'; name: string; enabled: boolean; keep: number;
  config: Record<string, unknown>; secrets_set: string[];
}
export interface PlatformBackupSchedule {
  enabled: boolean; frequency: 'daily' | 'weekly' | 'monthly'; time_of_day: string; weekday: number; monthday: number;
  contents: PlatformBackupContents; keep: number; destination_ids: number[]; has_passphrase: boolean; last_run_at: string | null;
}
export interface PlatformRestoreState {
  phase: 'idle' | 'pre-backup' | 'restoring' | 'restarting' | 'failed'; message: string; startedAt?: string | null;
  error?: string; result?: { mode: string; tables: number; rows: number; reencrypted: number; unreadable: number };
}
export interface PlatformBackupTableDiff {
  table: string; label: string; added: number; removed: number; changed: number;
  samples: { added: string[]; removed: string[]; changed: { row: string; fields: string[] }[] };
}
export interface PlatformBackupCompare {
  contents: PlatformBackupContents; appVersion: string; createdAt: string;
  tables: PlatformBackupTableDiff[];
  history: { table: string; current: number; backup: number }[];
  skippedTables: string[];
  identical: boolean;
}
export interface PlatformBackupOverview {
  app_version: string; min_passphrase: number; schedule: PlatformBackupSchedule;
  destinations: PlatformBackupDestination[]; backups: PlatformBackupRow[]; restore: PlatformRestoreState;
}
const LONG = { timeout: 0 };
export const platformBackupApi = {
  overview: () => api.get<PlatformBackupOverview>('/platform-backup'),
  saveSchedule: (data: Partial<PlatformBackupSchedule> & { passphrase?: string }) => api.put<PlatformBackupSchedule>('/platform-backup/schedule', data),
  backupNow: (data: { contents: PlatformBackupContents; passphrase?: string; use_saved_passphrase?: boolean; destination_ids?: number[] }) =>
    api.post('/platform-backup/backups', data),
  remove: (id: number) => api.delete(`/platform-backup/backups/${id}`),
  downloadLink: (id: number) => api.post<{ url: string }>(`/platform-backup/backups/${id}/download-link`),
  upload: (file: File, onProgress: (pct: number) => void) =>
    api.post<{ upload_id: string; header: PlatformBackupHeader; size: number }>('/platform-backup/upload', file, {
      ...LONG, headers: { 'Content-Type': 'application/octet-stream' },
      onUploadProgress: (e) => { if (e.total) onProgress(Math.round((e.loaded / e.total) * 100)); },
    }),
  check: (src: { backup_id?: number; upload_id?: string }, passphrase: string) =>
    api.post<{ ok: boolean; header: PlatformBackupHeader; restorable: boolean }>('/platform-backup/check', { ...src, passphrase }),
  // What a restore would change, read-only. Reads the whole file, so allow time.
  compare: (src: { backup_id?: number; upload_id?: string }, passphrase: string) =>
    api.post<PlatformBackupCompare>('/platform-backup/compare', { ...src, passphrase }, { timeout: 600_000 }),
  restore: (src: { backup_id?: number; upload_id?: string }, passphrase: string, mode: 'config' | 'full') =>
    api.post('/platform-backup/restore', { ...src, passphrase, mode, confirm: 'RESTORE' }),
  restoreProgress: () => api.get<{ phase: PlatformRestoreState['phase']; message: string }>('/platform-backup/restore/progress'),
  clearRestore: () => api.post('/platform-backup/restore/clear'),
  addDestination: (data: Record<string, unknown>) => api.post<{ id: number }>('/platform-backup/destinations', data),
  updateDestination: (id: number, data: Record<string, unknown>) => api.put(`/platform-backup/destinations/${id}`, data),
  removeDestination: (id: number) => api.delete(`/platform-backup/destinations/${id}`),
  testDestination: (id: number) => api.post<{ ok: boolean; message: string; host_key: string | null }>(`/platform-backup/destinations/${id}/test`, {}, { timeout: 120_000 }),
};

/** One bridge as the Bridges tab shows it (#284). */
export interface BridgeView {
  id: string; name: string; protocolMode: string; priority: string | null; vlanFiltering: boolean;
  running: boolean; disabled: boolean; dynamic: boolean; comment: string | null; mtu: string | null; macAddress: string | null;
  /** The MTU as set: "auto" or a number. `mtu` is what it is in effect. */
  mtuSetting?: string;
  ports: { name: string; hw: boolean; pvid: string | null; disabled: boolean; inactive: boolean; dynamic: boolean; role: string | null; l2mtu?: number | null; maxL2mtu?: number | null }[];
  vlans: string[];
  dynamicVlans?: string[];
  addresses: string[];
}

/** A BGP peer or OSPF neighbour, as the slow polls last found it (#279). */
export interface RoutingPeerRow {
  device_id: number;
  device_name: string;
  device_status: string;
  protocol: 'bgp' | 'ospf';
  peer_key: string;
  name: string | null;
  remote_address: string | null;
  remote_as: string | null;
  remote_id: string | null;
  instance: string | null;
  detail: string | null;
  state: string;
  up: boolean;
  disabled: boolean;
  uptime: string | null;
  prefix_count: number | null;
  last_up_at: string | null;
  last_change_at: string;
  last_seen_at: string;
  updated_at: string;
}

export const routingApi = {
  peers: (deviceId?: number) => api.get<RoutingPeerRow[]>('/routing/peers', { params: deviceId ? { deviceId } : undefined }),
};

/** Tunnels and PPP across the fleet (#310), from the slow polls. */
export type TunnelKind = 'ipsec' | 'pppoe-server' | 'ppp-session' | 'pppoe-client' | 'eoip' | 'gre' | 'ipip';
export interface TunnelRowView {
  device_id: number;
  device_name: string;
  device_status: string;
  kind: TunnelKind;
  tunnel_key: string;
  name: string;
  local_address: string | null;
  remote_address: string | null;
  detail: string | null;
  status: 'up' | 'down' | 'idle' | 'disabled';
  state: string;
  uptime: string | null;
  last_up_at: string | null;
  last_change_at: string;
  updated_at: string;
}
/** One router's PPP users, PPPoE servers and sessions, read live (Discussion #85). */
export interface PppUser {
  id: string; name: string; service: string; profile: string | null; remote_address: string | null;
  disabled: boolean; comment: string | null; last_logged_out: string | null; last_caller_id: string | null;
  last_disconnect_reason: string | null; sessions: number;
}
export interface PppServer { id: string; service_name: string; interface: string | null; disabled: boolean }
export interface PppSession { id: string; name: string; service: string; caller_id: string | null; address: string | null; uptime: string | null }
export interface PppState { users: PppUser[]; servers: PppServer[]; sessions: PppSession[] }

export const tunnelsApi = {
  list: () => api.get<TunnelRowView[]>('/tunnels'),
  ppp: (deviceId: number) => api.get<PppState>('/tunnels/ppp', { params: { deviceId } }),
  setUser: (deviceId: number, id: string, disabled: boolean, confirmLockout = false) =>
    api.put<{ message: string }>('/tunnels/ppp/user', { id, disabled, ...(confirmLockout ? { confirm_lockout: true } : {}) },
      { params: { deviceId }, ...GUARDED }),
  setServer: (deviceId: number, id: string, disabled: boolean, confirmLockout = false) =>
    api.put<{ message: string }>('/tunnels/ppp/server', { id, disabled, ...(confirmLockout ? { confirm_lockout: true } : {}) },
      { params: { deviceId }, ...GUARDED }),
  disconnect: (deviceId: number, id: string, name: string, confirmManaged = false) =>
    api.post<{ message: string }>('/tunnels/ppp/disconnect', { id, name, ...(confirmManaged ? { confirm_managed: true } : {}) },
      { params: { deviceId } }),
};

/** Netinstall from RouterOS devices (#310). */
export type NetinstallSupport = 'installed' | 'available' | 'too-old' | 'unsupported' | 'unknown';
export interface NetinstallFleetDevice {
  id: number; name: string; status: string; device_type: string; model: string | null;
  ros_version: string | null; architecture: string | null; support: NetinstallSupport;
  /** A package install or removal sent from the page, until the device shows it. */
  package_change: 'install' | 'remove' | null;
}
export type RosRow = Record<string, string>;
export interface NetinstallManaged { id: number; name: string }
export interface NetinstallDeviceView {
  device: { id: number; name: string; status: string; ros_version: string | null };
  support: NetinstallSupport;
  package: { version: string | null; size: number; installed: boolean; scheduled: string | null } | null;
  pending: string[];
  entries: (RosRow & { open: boolean; managed: NetinstallManaged | null })[];
  cache: RosRow[];
  devices: (RosRow & { managed: NetinstallManaged | null })[];
  cache_directory: string;
  storage: { kind: 'ram' | 'flash' | 'disk'; disk: string | null; free: number | null; total: number | null };
  install_estimate: number;
  space_problem: string | null;
  server_arch: string | null;
  interfaces: string[];
  packages: string[];
  disks: { name: string; type: string | null; free: number | null; size: number | null }[];
}
type NetinstallBody = Record<string, string | boolean>;
const ni = (deviceId: number) => ({ params: { deviceId } });
export const netinstallApi = {
  fleet: () => api.get<{ min_version: string; devices: NetinstallFleetDevice[] }>('/network-services/netinstall'),
  device: (deviceId: number) => api.get<NetinstallDeviceView>('/network-services/netinstall/device', { ...ni(deviceId), timeout: 30_000 }),
  changePackage: (deviceId: number, action: 'install' | 'remove', allowUpgrade = false) =>
    api.post<{ started: boolean; message: string }>('/network-services/netinstall/package',
      { action, confirm: true, ...(allowUpgrade ? { allow_upgrade: true } : {}) }, ni(deviceId)),
  addEntry: (deviceId: number, body: NetinstallBody) => api.post('/network-services/netinstall/entry', body, ni(deviceId)),
  updateEntry: (deviceId: number, id: string, body: NetinstallBody) =>
    api.put(`/network-services/netinstall/entry/${encodeURIComponent(id)}`, body, ni(deviceId)),
  removeEntry: (deviceId: number, id: string) => api.delete(`/network-services/netinstall/entry/${encodeURIComponent(id)}`, ni(deviceId)),
  addCache: (deviceId: number, body: NetinstallBody) => api.post('/network-services/netinstall/cache', body, ni(deviceId)),
  // By path: cache rows are numbered by position, so an id can name another file.
  removeCache: (deviceId: number, path: string) => api.delete('/network-services/netinstall/cache', { params: { deviceId, path } }),
  setCacheDirectory: (deviceId: number, cache_directory: string) =>
    api.put('/network-services/netinstall/settings', { cache_directory }, ni(deviceId)),
  install: (deviceId: number, body: NetinstallBody) => api.post('/network-services/netinstall/devices/install', body, ni(deviceId)),
  clearDevices: (deviceId: number) => api.post('/network-services/netinstall/devices/clear', {}, ni(deviceId)),
};

/** MLAG pairs (#376), from the slow polls. */
export interface MlagBridgeView {
  device_id: number; device_name: string; ros_version: string | null; bridge_name: string; mlag_peer_port: string;
  mlag_priority: number | null; mlag_heartbeat: string | null; mlag_init_delay: string | null; mlag_lacp_fallback: boolean | null;
  mlag_state: string | null; mlag_role: string | null; mlag_state_changed_at: string | null; mlag_missing_vlans: number[] | null;
}
export interface MlagBondView {
  device_id: number; bond: string; is_peer_link: boolean; slaves: string | null; running: boolean | null;
  active_ports: string | null; inactive_ports: string | null; partner_sys_id: string | null;
}
export interface MlagBondSide { bond: string; running: boolean; active: string[]; inactive: string[]; partner: string | null; partnerName: string | null; everUp: boolean }
export interface MlagPairView {
  a: MlagBridgeView;
  b: MlagBridgeView | null;
  peerLinkA: MlagBondView | null;
  peerLinkB: MlagBondView | null;
  bonds: { mlagId: number; a: MlagBondSide | null; b: MlagBondSide | null; status: 'dual-homed' | 'single-homed' | 'mismatch' | 'down' | 'unused' }[];
  findings: { severity: 'critical' | 'warning'; code: string; text: string }[];
  status: 'healthy' | 'warning' | 'critical';
  peerLink?: MlagPeerLinkView;
}
export interface MlagPeerMember { name: string; running: boolean; active: boolean; speed: string | null; linkDowns: number | null; errors24h: number; lastDownAt: string | null }
export interface MlagPeerLinkSide { bond: string; partner: string | null; partnerOk: boolean | null; vlans: number[] }
export interface MlagPeerLinkView {
  a: MlagPeerLinkSide | null;
  b: MlagPeerLinkSide | null;
  members: { a: MlagPeerMember | null; b: MlagPeerMember | null }[];
  lastFlap: { device: string; member: string; at: string; reboot: boolean } | null;
}
export const mlagApi = {
  pairs: () => api.get<MlagPairView[]>('/mlag'),
  present: () => api.get<{ present: boolean }>('/mlag/present'),
};

/** The switch chip's own VLAN table and port VLAN settings (#278). */
/** An /interface/vlan entry (#309). */
/** What a VLAN interface is made or edited with (#309). */
export interface VlanInterfaceInput {
  vlan_id: number;
  interface: string;
  name: string;
  mtu?: number | '';
  comment?: string;
  disabled?: boolean;
}

export interface VlanInterface {
  id: string;
  name: string;
  vlanId: number | null;
  parent: string;
  parentKind: 'bridge-filtering' | 'bridge' | 'bond' | 'vlan' | 'port' | 'unknown';
  mtu: string;
  running: boolean;
  disabled: boolean;
  addresses: string[];
  comment: string;
}

/** An /ipv6/route row (#312). */
export interface Ipv6Route {
  id: string;
  dst: string;
  gateway: string;
  immediateGw: string;
  distance: string;
  table: string;
  active: boolean;
  disabled: boolean;
  dynamic: boolean;
  source: string;
  type: string;
  comment: string;
}

export interface SwitchVlanView {
  supported: boolean;
  switches: { name: string; type: string }[];
  vlans: { id: string; switch: string; vlanId: number; ports: string[]; independentLearning: boolean; disabled: boolean }[];
  ports: { name: string; switch: string; vlanMode: string; vlanHeader: string; defaultVlanId: string }[];
  inUse: boolean;
  filteringBridges: string[];
}

export interface L3HwView {
  supported: boolean;
  switch: { id: string; name: string; type: string } | null;
  enabled: boolean;
  portsOff: string[];
  ipv6: boolean;
  fasttrackHw: boolean | null;
  routesHw: number | null;
  routesCpu: number | null;
  hostsHw: number | null;
  routedVlans: string[];
  forwardRules: number;
  natRules: number;
  /** Routed VLANs on a bridge without VLAN filtering: their routes stay on the CPU. */
  notOffloadable: { vlan: string; bridge: string }[];
}

/** What a bridge move did (#258). `offload` is read back from the device per moved port. */
export interface BridgeMoveResult {
  message: string;
  moved: string[];
  unchanged: string[];
  created: boolean;
  offload: Record<string, boolean>;
  /** Hardware switching was expected (CRS1xx/2xx, or an offloaded bridge) but not yet reported. */
  offloadPending?: boolean;
  guard?: unknown;
}

// ─── Device certificates from the manager's CA (#200) ────────────────────────
export type DeviceCertStatus = 'not_issued' | 'valid' | 'renewal_due' | 'expired' | 'renewal_failed';
export interface DeviceCaInfo {
  subject: string; commonName: string; fingerprint: string; notBefore: string; notAfter: string; keyType: string;
  imported: boolean; created_by: string | null; created_at: string;
}
export interface DeviceCaSettings { default_days: number; renew_before_days: number; auto_renew: boolean; default_www: boolean }
export interface DeviceCertRow {
  id: number; name: string; ip_address: string; site_name: string | null; ros_version: string | null; status: string;
  api_ssl: boolean; cert_name: string | null; fingerprint: string | null; sans: string[] | null; extra_names: string[] | null;
  days: number | null; apply_www: boolean | null; not_before: string | null; not_after: string | null;
  last_error: string | null; last_attempt_at: string | null; issued_at: string | null; renewed_at: string | null;
  cert_status: DeviceCertStatus;
}
export interface DeviceCertsOverview {
  ca: DeviceCaInfo | null;
  settings: DeviceCaSettings | null;
  limits: { min_days: number; max_days: number; ca_day_choices: number[] };
  devices: DeviceCertRow[];
}
export interface DeviceCertResult { ok: boolean; steps: string[]; message: string }

export const deviceCertsApi = {
  overview: () => api.get<DeviceCertsOverview>('/device-certs'),
  createCa: (data: { common_name: string; organization?: string; days: number }) => api.post('/device-certs/ca', data),
  importCa: (data: { cert_pem: string; key_pem: string; passphrase?: string }) =>
    api.post<{ message: string; warnings: string[] }>('/device-certs/ca/import', data),
  deleteCa: () => api.delete('/device-certs/ca'),
  caCertificate: () => api.get<string>('/device-certs/ca/certificate', { responseType: 'text' as const }),
  saveSettings: (data: Partial<DeviceCaSettings>) => api.put('/device-certs/settings', data),
  // Issuing talks to the device (key upload, import, a fresh TLS login): allow time.
  issue: (id: number, data: { days?: number; extra_names?: string[]; apply_www?: boolean }) =>
    api.post<DeviceCertResult>(`/device-certs/devices/${id}/issue`, data, { timeout: 180_000 }),
  renew: (id: number) => api.post<DeviceCertResult>(`/device-certs/devices/${id}/renew`, {}, { timeout: 180_000 }),
  remove: (id: number, forget = false) =>
    api.delete<DeviceCertResult>(`/device-certs/devices/${id}`, { params: forget ? { forget: '1' } : undefined, timeout: 180_000 }),
};

/** Reverse proxy (#358), on the Certificates page. */
export interface ProxyRuleRow {
  device_id: number; rule_id: string; sni: string; ip_address: string | null; port: number | null; certificate: string | null;
  vrf: string | null; comment: string | null; disabled: boolean; dynamic: boolean;
  effective_certificate: string | null; certificate_expires: string | null; managed: boolean;
  /** A Let's Encrypt certificate RouterOS requests and renews (#358). */
  acme: { staging: boolean; phase: AcmePhase; status: string | null } | null;
}
export type AcmePhase = 'pending' | 'issued' | 'failed';
export interface AcmeCertView { id: string; name: string; domain: string; staging: boolean; phase: AcmePhase; status: string | null; invalidAfter: string | null }
export interface ProxyManagedCert { sni: string; cert_name: string; not_after: string; last_error: string | null }
export interface ProxyFleetDevice {
  id: number; name: string; status: string; device_type: string; model: string | null; ros_version: string | null; architecture: string | null;
  support: 'supported' | 'too-old' | 'unsupported' | 'unknown';
  service: { port: number | null; certificate: string | null; disabled: boolean; invalid: boolean; www_ssl_port: number | null; www_ssl_disabled: boolean } | null;
  clash: boolean;
  rules: ProxyRuleRow[];
  managed_certs: ProxyManagedCert[];
}
export interface ProxyRule {
  id: string; sni: string; ipAddress: string | null; port: number | null; certificate: string | null; vrf: string | null;
  comment: string | null; disabled: boolean; dynamic: boolean;
}
export interface ProxyCertInfo { name: string; commonName?: string; subjectAltName?: string; privateKey: boolean; expired: boolean; invalidAfter?: string }
export interface ProxyDeviceView {
  device: { id: number; name: string; status: string };
  rules: ProxyRule[];
  service: { port: number | null; certificate: string | null; disabled: boolean; invalid: boolean; wwwSslPort: number | null; wwwSslDisabled: boolean };
  clash: boolean;
  services: { id: string; name: string; port: number | null; disabled: boolean }[];
  certificates: ProxyCertInfo[];
  vrfs: string[];
  managed_certs: ProxyManagedCert[];
  acme: AcmeCertView[];
  ca_ready: boolean;
}
export type ProxyFix = { service: 'www-ssl' | 'reverse-proxy'; port: number };
type ProxyRuleBody = Record<string, unknown> & { fix?: ProxyFix };
const rp = (deviceId: number, extra: Record<string, string> = {}) => ({ params: { deviceId, ...extra } });
export const reverseProxyApi = {
  fleet: () => api.get<{ min_version: string; devices: ProxyFleetDevice[] }>('/reverse-proxy'),
  device: (deviceId: number) => api.get<ProxyDeviceView>('/reverse-proxy/device', { ...rp(deviceId), timeout: 30_000 }),
  addRule: (deviceId: number, body: ProxyRuleBody) => api.post('/reverse-proxy/rule', body, rp(deviceId)),
  updateRule: (deviceId: number, id: string, sni: string, body: ProxyRuleBody) =>
    api.put(`/reverse-proxy/rule/${encodeURIComponent(id)}`, body, rp(deviceId, { sni })),
  removeRule: (deviceId: number, id: string, sni: string) => api.delete(`/reverse-proxy/rule/${encodeURIComponent(id)}`, rp(deviceId, { sni })),
  movePort: (deviceId: number, fix: ProxyFix) => api.put('/reverse-proxy/service', fix, rp(deviceId)),
  renewAcme: (deviceId: number, name: string) => api.post<{ message: string }>('/reverse-proxy/acme/renew', { name }, rp(deviceId)),
  dns: (name: string) => api.get<{ name: string; addresses: string[]; error?: string }>('/reverse-proxy/dns', { params: { name } }),
  issueCert: (deviceId: number, sni: string, days?: number) =>
    api.post<{ ok: boolean; steps: string[]; message: string; cert_name?: string }>('/reverse-proxy/cert', { sni, ...(days ? { days } : {}) }, { ...rp(deviceId), timeout: 120_000 }),
  removeCert: (deviceId: number, sni: string, forget = false) =>
    api.delete<{ ok: boolean; message: string }>('/reverse-proxy/cert', rp(deviceId, { sni, ...(forget ? { forget: '1' } : {}) })),
};
