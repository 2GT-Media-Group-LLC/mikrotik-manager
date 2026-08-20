import nodemailer from 'nodemailer';
import * as https from 'https';
import * as http from 'http';
import { query } from '../config/database';

export type AlertEventType =
  | 'device_offline'
  | 'device_online'
  | 'log_error'
  | 'log_warning'
  | 'high_cpu'
  | 'high_memory'
  | 'cert_expiry'
  | 'device_discovered'
  | 'firmware_update_available'
  | 'config_drift';

export interface AlertContext {
  deviceId?: number;
  deviceName?: string;
  details?: string;
  /** Override the per-alert cooldown key (default: `${eventType}:${deviceId|'global'}`). */
  cooldownKey?: string;
}

interface AlertRule {
  event_type: string;
  enabled: boolean;
  threshold: number | null;
  cooldown_min: number;
}

interface AlertChannel {
  id: number;
  name: string;
  type: 'email' | 'slack' | 'discord' | 'telegram' | 'ntfy';
  enabled: boolean;
  config: Record<string, unknown>;
}

// In-memory cooldown map (keyed by "eventType:deviceId")
// Persists across calls within the same process lifetime
const cooldownUntil = new Map<string, number>();

const EVENT_LABELS: Record<string, string> = {
  device_offline:           'Device Offline',
  device_online:            'Device Online (Recovery)',
  log_error:                'Log Error Detected',
  log_warning:              'Log Warning Detected',
  high_cpu:                 'High CPU Usage',
  high_memory:              'High Memory Usage',
  cert_expiry:              'Certificate Expiring Soon',
  device_discovered:        'New Device Discovered',
  firmware_update_available: 'Firmware Update Available',
  config_drift:             'Configuration Changed',
};

const EVENT_EMOJI: Record<string, string> = {
  device_offline:           '🔴',
  device_online:            '🟢',
  log_error:                '❌',
  log_warning:              '⚠️',
  high_cpu:                 '🔥',
  high_memory:              '🔥',
  cert_expiry:              '🔐',
  device_discovered:        '🔍',
  firmware_update_available: '🔄',
  config_drift:             '📝',
};

export class AlertService {
  // ── Public API ──────────────────────────────────────────────────────────────

  async dispatch(eventType: AlertEventType, message: string, ctx: AlertContext = {}): Promise<void> {
    try {
      const rule = await this.getRule(eventType);
      if (!rule?.enabled) return;

      // Maintenance window suppression — skip if device is in a currently active window
      if (ctx.deviceId != null) {
        const inMaintenance = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM maintenance_windows
           WHERE active = true AND $1 = ANY(device_ids) AND NOW() BETWEEN start_at AND end_at`,
          [ctx.deviceId]
        ).catch(() => [{ count: '0' }]);
        if (parseInt(inMaintenance[0]?.count || '0', 10) > 0) {
          console.log(`[AlertService] Suppressed ${eventType} for device ${ctx.deviceId} (maintenance window)`);
          return;
        }
      }

      // Cooldown check
      const cooldownKey = ctx.cooldownKey ?? `${eventType}:${ctx.deviceId ?? 'global'}`;
      const cooldownMs = (rule.cooldown_min ?? 15) * 60 * 1000;
      const now = Date.now();
      const until = cooldownUntil.get(cooldownKey) ?? 0;
      if (now < until) return;
      cooldownUntil.set(cooldownKey, now + cooldownMs);

      // Outbound webhooks fan out on the same (rule-gated, cooldown-respecting)
      // event stream, independent of whether any alert channels are configured.
      void import('./WebhookService').then(({ webhookService }) =>
        webhookService.dispatch(eventType, {
          message,
          device_id: ctx.deviceId ?? null,
          device_name: ctx.deviceName ?? null,
          details: ctx.details ?? null,
        })
      ).catch(() => {});

      // Get enabled channels
      const channels = await query<AlertChannel>(
        `SELECT * FROM alert_channels WHERE enabled = true ORDER BY id`
      );
      if (channels.length === 0) return;

      // Dispatch concurrently, don't let one failure block others
      const notified: string[] = [];
      await Promise.allSettled(
        channels.map(async (ch) => {
          try {
            await this.sendToChannel(ch, eventType, message, ctx);
            notified.push(ch.name);
          } catch (err) {
            console.error(`[AlertService] Channel "${ch.name}" failed:`, (err as Error).message);
          }
        })
      );

      // Log to history — use subquery for device_id so a deleted device doesn't cause a FK violation
      await query(
        `INSERT INTO alert_history (event_type, device_id, device_name, message, channels_notified)
         VALUES ($1, (SELECT id FROM devices WHERE id = $2), $3, $4, $5)`,
        [eventType, ctx.deviceId ?? null, ctx.deviceName ?? null, message, JSON.stringify(notified)]
      );

      if (notified.length > 0) {
        console.log(`[AlertService] ${eventType} → sent to: ${notified.join(', ')}`);
      }
    } catch (err) {
      console.error('[AlertService] Dispatch error:', err);
    }
  }

  async getRule(eventType: string): Promise<AlertRule | null> {
    const rows = await query<AlertRule>(
      `SELECT * FROM alert_rules WHERE event_type = $1`,
      [eventType]
    );
    return rows[0] ?? null;
  }

  async getRules(): Promise<AlertRule[]> {
    return query<AlertRule>(`SELECT * FROM alert_rules ORDER BY event_type`);
  }

  async upsertRule(eventType: string, data: Partial<AlertRule>): Promise<AlertRule> {
    const rows = await query<AlertRule>(
      `INSERT INTO alert_rules (event_type, enabled, threshold, cooldown_min)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_type) DO UPDATE SET
         enabled      = EXCLUDED.enabled,
         threshold    = EXCLUDED.threshold,
         cooldown_min = EXCLUDED.cooldown_min,
         updated_at   = NOW()
       RETURNING *`,
      [
        eventType,
        data.enabled ?? false,
        data.threshold ?? null,
        data.cooldown_min ?? 15,
      ]
    );
    return rows[0];
  }

  /** Send a test message to a single channel (ignores cooldown/rules). */
  async testChannel(channelId: number): Promise<void> {
    const rows = await query<AlertChannel>(
      `SELECT * FROM alert_channels WHERE id = $1`,
      [channelId]
    );
    const ch = rows[0];
    if (!ch) throw new Error('Channel not found');
    await this.sendToChannel(
      ch,
      'device_online',
      'This is a test alert from Mikrotik Manager.',
      { deviceName: 'Test Device' }
    );
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  private async sendToChannel(
    ch: AlertChannel,
    eventType: string,
    message: string,
    ctx: AlertContext
  ): Promise<void> {
    switch (ch.type) {
      case 'email':    await this.sendEmail(ch.config, eventType, message, ctx); break;
      case 'slack':    await this.sendSlack(ch.config, eventType, message, ctx); break;
      case 'discord':  await this.sendDiscord(ch.config, eventType, message, ctx); break;
      case 'telegram': await this.sendTelegram(ch.config, eventType, message, ctx); break;
      case 'ntfy':     await this.sendNtfy(ch.config, eventType, message, ctx); break;
    }
  }

  private async sendEmail(
    cfg: Record<string, unknown>,
    eventType: string,
    message: string,
    ctx: AlertContext
  ): Promise<void> {
    const host      = cfg.smtp_host as string;
    const port      = (cfg.smtp_port as number) || 587;
    const secure    = !!(cfg.smtp_secure);
    const user      = cfg.smtp_user as string | undefined;
    const pass      = cfg.smtp_pass as string | undefined;
    const from      = (cfg.from_address as string) || user || 'alerts@mikrotik-manager';
    const recipients = (cfg.recipients as string[]) || [];

    if (!host || recipients.length === 0) {
      throw new Error('Email channel missing smtp_host or recipients');
    }

    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
      tls: { rejectUnauthorized: false },
    } as nodemailer.TransportOptions);

    const label   = EVENT_LABELS[eventType] ?? eventType;
    const subject = `[Mikrotik Manager] ${label}`;
    const device  = ctx.deviceName ? `<b>Device:</b> ${ctx.deviceName}<br>` : '';
    const details = ctx.details    ? `<br><pre>${ctx.details}</pre>` : '';

    const html = `
<div style="font-family:sans-serif;max-width:600px">
  <div style="background:#1e40af;color:#fff;padding:12px 20px;border-radius:8px 8px 0 0">
    <strong>Mikrotik Manager Alert</strong>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px">
    <h2 style="margin:0 0 12px;color:#1f2937">${EVENT_EMOJI[eventType] ?? '🔔'} ${label}</h2>
    <p style="color:#374151">${message}</p>
    <div style="color:#6b7280;font-size:13px">${device}${details}</div>
    <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb">
    <p style="font-size:12px;color:#9ca3af">Sent by Mikrotik Manager · ${new Date().toUTCString()}</p>
  </div>
</div>`;

    await transport.sendMail({ from, to: recipients.join(', '), subject, html });
  }

  private async sendSlack(
    cfg: Record<string, unknown>,
    eventType: string,
    message: string,
    ctx: AlertContext
  ): Promise<void> {
    const webhookUrl = cfg.webhook_url as string;
    if (!webhookUrl) throw new Error('Slack channel missing webhook_url');

    const label  = EVENT_LABELS[eventType] ?? eventType;
    const emoji  = EVENT_EMOJI[eventType]  ?? ':bell:';
    const device = ctx.deviceName ? `\n*Device:* ${ctx.deviceName}` : '';
    const detail = ctx.details    ? `\n\`\`\`${ctx.details}\`\`\`` : '';

    const body = JSON.stringify({
      text: `${emoji} *${label}*`,
      attachments: [{
        color: this.slackColor(eventType),
        text: `${message}${device}${detail}`,
        footer: 'Mikrotik Manager',
        ts: Math.floor(Date.now() / 1000),
      }],
    });

    await this.postJson(webhookUrl, body);
  }

  private async sendDiscord(
    cfg: Record<string, unknown>,
    eventType: string,
    message: string,
    ctx: AlertContext
  ): Promise<void> {
    const webhookUrl = cfg.webhook_url as string;
    if (!webhookUrl) throw new Error('Discord channel missing webhook_url');

    const label  = EVENT_LABELS[eventType] ?? eventType;
    const device = ctx.deviceName ? `\n**Device:** ${ctx.deviceName}` : '';
    const detail = ctx.details    ? `\n\`\`\`${ctx.details}\`\`\`` : '';

    const body = JSON.stringify({
      embeds: [{
        title:       `${EVENT_EMOJI[eventType] ?? '🔔'} ${label}`,
        description: `${message}${device}${detail}`,
        color:       this.discordColor(eventType),
        footer:      { text: 'Mikrotik Manager' },
        timestamp:   new Date().toISOString(),
      }],
    });

    await this.postJson(webhookUrl, body);
  }

  private async sendTelegram(
    cfg: Record<string, unknown>,
    eventType: string,
    message: string,
    ctx: AlertContext
  ): Promise<void> {
    const botToken = cfg.bot_token as string;
    const chatId   = cfg.chat_id   as string;
    if (!botToken || !chatId) throw new Error('Telegram channel missing bot_token or chat_id');

    const label  = EVENT_LABELS[eventType] ?? eventType;
    const device = ctx.deviceName ? `\n📡 <b>Device:</b> ${ctx.deviceName}` : '';
    const detail = ctx.details    ? `\n<pre>${ctx.details}</pre>` : '';

    const text = `${EVENT_EMOJI[eventType] ?? '🔔'} <b>${label}</b>\n${message}${device}${detail}`;

    const url  = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });

    await this.postJson(url, body);
  }

  /**
   * ntfy (https://ntfy.sh, or a self-hosted instance).
   *
   * Published as JSON to the server root rather than `POST /{topic}` with header
   * metadata: the header form requires ASCII, and the titles here carry per-event
   * emoji. The JSON body is UTF-8 and keeps the emoji intact.
   *
   * `server_url` is operator-supplied so self-hosted instances work — which is the
   * common case for infrastructure alerting. That is the same trust model as the
   * existing Slack and Discord webhook URLs: an admin can point any of them at an
   * internal address, and only an admin can configure them.
   */
  private async sendNtfy(
    cfg: Record<string, unknown>,
    eventType: string,
    message: string,
    ctx: AlertContext
  ): Promise<void> {
    const topic = (cfg.topic as string | undefined)?.trim();
    if (!topic) throw new Error('ntfy channel missing topic');

    const serverUrl = ((cfg.server_url as string | undefined)?.trim() || 'https://ntfy.sh').replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw new Error(`ntfy channel has an invalid server_url: ${serverUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('ntfy server_url must be http or https');
    }

    const label  = EVENT_LABELS[eventType] ?? eventType;
    const emoji  = EVENT_EMOJI[eventType] ?? '\u{1F514}';

    const lines = [message];
    if (ctx.deviceName) lines.push(`Device: ${ctx.deviceName}`);
    if (ctx.details)    lines.push(ctx.details);

    const body: Record<string, unknown> = {
      topic,
      title:    `${emoji} ${label}`,
      message:  lines.join('\n'),
      priority: this.ntfyPriority(eventType),
      // The event type doubles as a filterable tag, so a phone can be set to only
      // wake for device_offline without the manager needing per-event channels.
      tags:     [eventType],
    };

    // Optional deep link back into the manager, when it knows its own address.
    const clickBase = (cfg.click_url as string | undefined)?.trim().replace(/\/+$/, '');
    if (clickBase) {
      body.click = ctx.deviceId != null ? `${clickBase}/devices/${ctx.deviceId}` : clickBase;
    }

    await this.postJson(serverUrl, JSON.stringify(body), this.ntfyAuthHeaders(cfg));
  }

  /**
   * Access token if present, otherwise basic auth. Infrastructure alerts should not
   * require a world-writable topic, so both of ntfy's schemes are supported and the
   * token is preferred — it can be scoped and revoked without changing a password.
   */
  private ntfyAuthHeaders(cfg: Record<string, unknown>): Record<string, string> {
    const token = (cfg.token as string | undefined)?.trim();
    if (token) return { Authorization: `Bearer ${token}` };

    const username = (cfg.username as string | undefined)?.trim();
    const password = (cfg.password as string | undefined) ?? '';
    if (username) {
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    }
    return {};
  }

  /**
   * ntfy priority runs 1 (min) to 5 (max); 4 and above bypasses a phone's
   * do-not-disturb. Reserve that for things that mean something is down, so the
   * channel stays worth being woken by.
   */
  private ntfyPriority(eventType: string): number {
    if (['device_offline', 'log_error', 'high_cpu', 'high_memory'].includes(eventType)) return 4;
    if (['device_online', 'device_discovered'].includes(eventType)) return 2;
    return 3;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private postJson(url: string, body: string, extraHeaders: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed   = new URL(url);
      const isHttps  = parsed.protocol === 'https:';
      const lib      = isHttps ? https : http;
      const options  = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...extraHeaders,
        },
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private slackColor(eventType: string): string {
    if (eventType === 'device_online') return 'good';
    if (['device_offline', 'log_error', 'high_cpu', 'high_memory'].includes(eventType)) return 'danger';
    return 'warning';
  }

  private discordColor(eventType: string): number {
    if (eventType === 'device_online')   return 0x22c55e; // green
    if (eventType === 'log_warning' || eventType === 'cert_expiry') return 0xf59e0b; // amber
    return 0xef4444; // red
  }
}

// Singleton
export const alertService = new AlertService();
