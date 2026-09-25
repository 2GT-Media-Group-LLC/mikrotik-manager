/**
 * Gotify (https://gotify.net) notification requests (#169).
 *
 * Gotify is self-hosted: messages go to POST {server}/message with an
 * application token in the X-Gotify-Key header. The server URL is required;
 * unlike ntfy there is no public default instance to fall back to.
 */

export interface GotifyConfig {
  server_url?: unknown;
  app_token?: unknown;
  click_url?: unknown;
}

export interface GotifyRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Gotify's Android app treats 8 and above as high importance (sound and a
 * heads-up notification), 4 to 7 as normal, and 1 to 3 as low. Only things
 * that mean something is down or failing are high.
 */
export function gotifyPriority(eventType: string): number {
  if (['device_offline', 'device_degraded', 'log_error', 'high_cpu', 'high_memory'].includes(eventType)) return 8;
  if (['device_online', 'device_health_restored', 'device_discovered'].includes(eventType)) return 2;
  return 5;
}

export function buildGotifyRequest(
  cfg: GotifyConfig,
  eventType: string,
  title: string,
  message: string,
  deviceId?: number | null
): GotifyRequest {
  const server = String(cfg.server_url ?? '').trim().replace(/\/+$/, '');
  if (!server) throw new Error('Gotify channel missing server URL');
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    throw new Error(`Gotify channel has an invalid server URL: ${server}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Gotify server URL must be http or https');
  }
  const token = String(cfg.app_token ?? '').trim();
  if (!token) throw new Error('Gotify channel missing app token');

  const body: Record<string, unknown> = {
    title,
    message,
    priority: gotifyPriority(eventType),
    extras: { 'client::display': { contentType: 'text/plain' } } as Record<string, unknown>,
  };
  const click = String(cfg.click_url ?? '').trim().replace(/\/+$/, '');
  if (click) {
    (body.extras as Record<string, unknown>)['client::notification'] = {
      click: { url: deviceId != null ? `${click}/devices/${deviceId}` : click },
    };
  }

  return {
    // Kept out of the query string, where it would end up in proxy logs.
    url: `${server}/message`,
    headers: { 'X-Gotify-Key': token },
    body: JSON.stringify(body),
  };
}
