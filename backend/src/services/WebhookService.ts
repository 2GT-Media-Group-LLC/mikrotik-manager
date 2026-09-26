// Outbound webhooks — POSTs event payloads to subscribed URLs with an HMAC
// signature so receivers can verify authenticity. Fired from the alert
// pipeline (all alert event types) and the firmware orchestrator.

import { createHmac } from 'crypto';
import * as https from 'https';
import * as http from 'http';
import * as dns from 'dns';
import { isIP } from 'net';
import { URL } from 'url';
import { query } from '../config/database';
import { isBlockedAddress } from '../utils/deviceAddress';

const dnsLookup = dns.promises.lookup;

// isBlockedAddress (loopback/private/link-local/CGNAT/unspecified) lives in
// utils/deviceAddress.ts, shared with device-address classification. Guards
// against SSRF to internal services.
export { isBlockedAddress };

async function assertPublicHost(hostname: string): Promise<string> {
  // Already an IP literal — check directly.
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('URL resolves to a blocked (private/internal) address');
    return hostname;
  }
  const results = await dnsLookup(hostname, { all: true }).catch(() => {
    throw new Error('Could not resolve webhook host');
  });
  if (results.length === 0) throw new Error('Could not resolve webhook host');
  for (const r of results) {
    if (isBlockedAddress(r.address)) throw new Error('URL resolves to a blocked (private/internal) address');
  }
  // Pin to the validated address so a re-resolve can't swap in an internal IP.
  return results[0].address;
}

export const WEBHOOK_EVENTS = [
  'device_offline', 'device_online', 'log_error', 'log_warning',
  'high_cpu', 'high_memory', 'cert_expiry', 'device_discovered',
  'firmware_update_available', 'config_drift',
  'rollout_completed', 'rollout_failed',
  'device_degraded', 'device_health_restored',
] as const;
export type WebhookEvent = typeof WEBHOOK_EVENTS[number] | 'test';

interface WebhookRow {
  id: number; name: string; url: string; secret: string | null;
  events: string[]; enabled: boolean;
}

async function postJson(urlStr: string, body: string, headers: Record<string, string>): Promise<number> {
  let u: URL;
  try { u = new URL(urlStr); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL must be http(s)');

  const isHttps = u.protocol === 'https:';
  const pinnedAddress = await assertPublicHost(u.hostname);
  const port = u.port ? Number(u.port) : (isHttps ? 443 : 80);

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const req = lib.request({
      host: pinnedAddress,            // connect to the validated IP, not a re-resolved host
      port,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      // Preserve virtual-host routing and TLS cert validation against the real name.
      servername: isHttps ? u.hostname : undefined,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Host: u.host,
        ...headers,
      },
      timeout: 10_000,
    }, (res) => {
      res.resume(); // drain
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => { req.destroy(new Error('Timed out after 10s')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export class WebhookService {
  /** Fire an event to every enabled webhook subscribed to it (best-effort, non-blocking). */
  async dispatch(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
    const hooks = await query<WebhookRow>(
      `SELECT id, name, url, secret, events, enabled FROM webhooks
       WHERE enabled = TRUE AND $1 = ANY(events)`, [event]
    ).catch(() => [] as WebhookRow[]);
    if (hooks.length === 0) return;

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data,
    });

    await Promise.allSettled(hooks.map(h => this.deliver(h, body)));
  }

  /** Send a sample payload to one webhook regardless of its subscriptions. */
  async sendTest(id: number): Promise<{ status: number }> {
    const rows = await query<WebhookRow>(`SELECT id, name, url, secret, events, enabled FROM webhooks WHERE id = $1`, [id]);
    if (!rows[0]) throw new Error('Webhook not found');
    const body = JSON.stringify({
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'MikroTik Manager webhook test — configuration looks good.' },
    });
    const status = await this.deliver(rows[0], body);
    return { status };
  }

  private async deliver(hook: WebhookRow, body: string): Promise<number> {
    const headers: Record<string, string> = { 'User-Agent': 'MikroTik-Manager-Webhook' };
    if (hook.secret) {
      headers['X-MTM-Signature'] = 'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex');
    }
    let status: number;
    try {
      status = await postJson(hook.url, body, headers);
    } catch (e) {
      console.error(`[Webhook] "${hook.name}" delivery failed:`, (e as Error).message);
      status = 0;
    }
    await query(`UPDATE webhooks SET last_status = $2, last_fired_at = NOW() WHERE id = $1`, [hook.id, status])
      .catch(() => {});
    return status;
  }
}

export const webhookService = new WebhookService();
