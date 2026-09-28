/**
 * Secrets in alert channel settings: which fields are masked in responses, and
 * how an update that sends the mask back keeps the saved value.
 */

export const SENSITIVE_KEYS: Record<string, string[]> = {
  email:    ['smtp_pass'],
  // For Slack and Discord the incoming-webhook URL is itself the credential:
  // anyone holding it can post into that channel.
  slack:    ['webhook_url'],
  discord:  ['webhook_url'],
  telegram: ['bot_token'],
  // ntfy accepts either an access token or basic auth; both are secrets.
  ntfy:     ['token', 'password'],
  gotify:   ['app_token'],
};

export function maskConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  for (const key of SENSITIVE_KEYS[type] ?? []) {
    if (masked[key]) masked[key] = '••••••••';
  }
  return masked;
}

/**
 * Where each channel type delivers to. A saved secret is only ever sent to the
 * destination it was saved with: if one of these changes, the secret must be
 * typed again. Otherwise anyone who could edit a channel could point it at a
 * server they run, keep the masked token, press Test, and receive the token.
 */
const DESTINATION_KEYS: Record<string, string[]> = {
  email:  ['smtp_host', 'smtp_port'],
  ntfy:   ['server_url'],
  gotify: ['server_url'],
};

/**
 * When updating, a sensitive field sent back as the mask placeholder keeps its
 * saved value, unless the destination changed (see DESTINATION_KEYS).
 */
export function mergeConfig(
  type: string,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): { merged: Record<string, unknown> } | { error: string } {
  const merged = { ...existing, ...incoming };
  const destinationChanged = (DESTINATION_KEYS[type] ?? []).some(
    (k) => k in incoming && String(incoming[k] ?? '') !== String(existing[k] ?? '')
  );
  for (const key of SENSITIVE_KEYS[type] ?? []) {
    if (incoming[key] === '••••••••') {
      if (destinationChanged && existing[key]) {
        return { error: 'The server changed, so re-enter the password or token. A saved secret is only sent to the server it was saved for.' };
      }
      merged[key] = existing[key]; // restore original
    }
  }
  return { merged };
}

