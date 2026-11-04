/**
 * AI tool connections (Settings → AI Connections): the read-only review tools,
 * offered over MCP (/api/mcp) and as an OpenAPI tool server (/api/review).
 * Stored as one row in app_settings, kept out of the generic settings API
 * because it holds the encrypted OAuth introspection secret.
 */
import { query, queryOne } from '../../config/database';
import { encrypt, decrypt } from '../../utils/crypto';

export const AI_SETTINGS_KEY = 'ai_connections';
export type McpAuth = 'oauth' | 'token';

export interface AiSettings {
  enabled: boolean;
  mcp_enabled: boolean;
  mcp_auth: McpAuth;
  openapi_enabled: boolean;
  /** The address AI tools reach the manager at, e.g. https://manager.example. Required for OAuth. */
  public_url: string;
  oauth_issuer: string;
  oauth_client_id: string;
  oauth_client_secret_encrypted: string | null;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  mcp_enabled: false,
  mcp_auth: 'token',
  openapi_enabled: false,
  public_url: '',
  oauth_issuer: '',
  oauth_client_id: '',
  oauth_client_secret_encrypted: null,
};

export type AiSettingsView = Omit<AiSettings, 'oauth_client_secret_encrypted'> & { has_oauth_secret: boolean };

// Read on every MCP/OpenAPI request; a few seconds is enough to spare the
// database without leaving a switched-off connector answering for long.
let cache: { at: number; value: AiSettings } | undefined;
const CACHE_MS = 5_000;

export async function loadAiSettings(): Promise<AiSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await queryOne<{ value: Partial<AiSettings> }>(`SELECT value FROM app_settings WHERE key = $1`, [AI_SETTINGS_KEY]);
  const value = { ...DEFAULT_AI_SETTINGS, ...(row?.value ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}

export function forgetAiSettings(): void { cache = undefined; }

/** A canonical HTTPS URL: no credentials, query or fragment. */
export function isCanonicalHttps(value: string, allowPath = true): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !value.includes('#') && !value.includes('?') && (allowPath || url.pathname === '/');
  } catch { return false; }
}

/** Why these settings can't be saved, or null. The UI checks the same things first. */
export function settingsProblem(s: AiSettings): string | null {
  if (!['oauth', 'token'].includes(s.mcp_auth)) return 'MCP sign-in must be OAuth or token.';
  if (s.public_url && !isCanonicalHttps(s.public_url, false)) {
    return 'The public address must be an https:// address with nothing after the host name, e.g. https://manager.example.';
  }
  if (!s.enabled || !s.mcp_enabled || s.mcp_auth !== 'oauth') return null;
  if (!s.public_url) return 'OAuth needs the public address the AI tool reaches the manager at.';
  if (!s.oauth_issuer || !isCanonicalHttps(s.oauth_issuer)) return 'The OAuth issuer must be an https:// address.';
  if (!s.oauth_client_id.trim()) return 'OAuth needs the client ID used to check tokens.';
  if (!s.oauth_client_secret_encrypted) return 'OAuth needs the client secret used to check tokens.';
  return null;
}

/** Patch and store. `newSecret` undefined keeps the secret, '' clears it. */
export async function saveAiSettings(patch: Partial<AiSettings>, newSecret?: string): Promise<AiSettings | { error: string }> {
  const current = await loadAiSettingsFresh();
  const merged: AiSettings = { ...current };
  for (const key of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
    if (key === 'oauth_client_secret_encrypted' || !(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== typeof DEFAULT_AI_SETTINGS[key]) return { error: `${key} has the wrong type.` };
    (merged as unknown as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim() : value;
  }
  merged.public_url = merged.public_url.replace(/\/+$/, '');
  if (newSecret !== undefined) merged.oauth_client_secret_encrypted = newSecret ? encrypt(newSecret) : null;
  const problem = settingsProblem(merged);
  if (problem) return { error: problem };
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [AI_SETTINGS_KEY, JSON.stringify(merged)]);
  forgetAiSettings();
  return merged;
}

async function loadAiSettingsFresh(): Promise<AiSettings> { forgetAiSettings(); return loadAiSettings(); }

export function maskedAiSettings(s: AiSettings): AiSettingsView {
  const { oauth_client_secret_encrypted, ...rest } = s;
  return { ...rest, has_oauth_secret: !!oauth_client_secret_encrypted };
}

export function oauthSecret(s: AiSettings): string | null {
  if (!s.oauth_client_secret_encrypted) return null;
  try { return decrypt(s.oauth_client_secret_encrypted); } catch { return null; }
}

/** How /api/mcp accepts callers now, or null when it's off. */
export function mcpMode(s: AiSettings): McpAuth | null {
  return s.enabled && s.mcp_enabled ? s.mcp_auth : null;
}

export function openApiOn(s: AiSettings): boolean {
  return s.enabled && s.openapi_enabled;
}
