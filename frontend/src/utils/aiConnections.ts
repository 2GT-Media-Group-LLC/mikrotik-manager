import type { AiSettingsView } from '../services/api';

/** An https:// address with nothing after the host: https://manager.example. */
export function isPublicOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/'
      && !value.includes('?') && !value.includes('#');
  } catch { return false; }
}

function isHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !value.includes('?') && !value.includes('#');
  } catch { return false; }
}

/**
 * Why Settings → AI Connections can't be saved as it stands, or null. The
 * same rules the server applies (services/mcp/settings.ts), checked first.
 */
export function aiSettingsProblem(form: AiSettingsView, typedSecret: string): string | null {
  const url = form.public_url.trim().replace(/\/+$/, '');
  if (url && !isPublicOrigin(url)) {
    return 'The public address must be an https:// address with nothing after the host name, e.g. https://manager.example.';
  }
  if (!form.enabled || !form.mcp_enabled || form.mcp_auth !== 'oauth') return null;
  if (!url) return 'OAuth needs the public address the AI tool reaches the manager at.';
  if (!form.oauth_issuer.trim() || !isHttps(form.oauth_issuer.trim())) return 'The OAuth issuer must be an https:// address.';
  if (!form.oauth_client_id.trim()) return 'OAuth needs the client ID used to check tokens.';
  if (!form.has_oauth_secret && !typedSecret) return 'OAuth needs the client secret used to check tokens.';
  return null;
}

/** Where the endpoints are: the public address if set, else this browser's. */
export function endpointBase(publicUrl: string, here: string): string {
  return (publicUrl.trim().replace(/\/+$/, '') || here).replace(/\/+$/, '');
}

/** Whether anything uses AI connection tokens with these settings. */
export function usesTokens(form: AiSettingsView): boolean {
  return form.enabled && (form.openapi_enabled || (form.mcp_enabled && form.mcp_auth === 'token'));
}
