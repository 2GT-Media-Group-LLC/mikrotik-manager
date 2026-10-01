// Scheduled email reports — periodic fleet summaries (device health, alerts,
// top clients, updates, backups) delivered over the SMTP settings of the first
// enabled email alert channel. An hourly scheduler sends whatever is due.

import { outageOverlapsSql, outageSecondsSql } from '../utils/outageWindow';
import nodemailer from 'nodemailer';
import { query, queryOne } from '../config/database';

interface ScheduleRow {
  id: number; name: string; frequency: 'daily' | 'weekly' | 'monthly';
  recipients: string; enabled: boolean; next_run_at: string;
}

const PERIOD_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };

export function computeNextRun(frequency: string, from: Date): Date {
  const next = new Date(from);
  if (frequency === 'daily') next.setDate(next.getDate() + 1);
  else if (frequency === 'monthly') next.setMonth(next.getMonth() + 1);
  else next.setDate(next.getDate() + 7);
  return next;
}

const fmtBytes = (b: number) =>
  b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TB`
  : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB`
  : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB`
  : `${(b / 1024).toFixed(1)} KB`;

export class ReportService {
  private timer: ReturnType<typeof setInterval> | null = null;

  startScheduler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sendDue().catch(e => console.error('[Reports] scheduler error:', e));
    }, 60 * 60_000);
  }

  stopScheduler(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async sendDue(): Promise<void> {
    const due = await query<ScheduleRow>(
      `SELECT * FROM report_schedules WHERE enabled = TRUE AND next_run_at <= NOW()`);
    for (const s of due) {
      try {
        await this.send(s);
        await query(
          `UPDATE report_schedules SET last_sent_at = NOW(), next_run_at = $2 WHERE id = $1`,
          [s.id, computeNextRun(s.frequency, new Date())]);
      } catch (e) {
        console.error(`[Reports] "${s.name}" failed:`, (e as Error).message);
        // push next_run_at forward anyway so a broken SMTP config doesn't retry hourly forever
        await query(`UPDATE report_schedules SET next_run_at = $2 WHERE id = $1`,
          [s.id, computeNextRun(s.frequency, new Date())]);
      }
    }
  }

  async send(schedule: Pick<ScheduleRow, 'name' | 'frequency' | 'recipients'>): Promise<void> {
    const smtp = await this.smtpConfig();
    const html = await this.buildHtml(schedule.frequency);
    const recipients = schedule.recipients.split(',').map(r => r.trim()).filter(Boolean);
    if (recipients.length === 0) throw new Error('No recipients configured');

    const transport = nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    await transport.sendMail({
      from: smtp.from,
      to: recipients.join(', '),
      subject: `MikroTik Manager — ${schedule.frequency} network report`,
      html,
    });
    console.log(`[Reports] sent "${schedule.name}" to ${recipients.length} recipient(s)`);
  }

  // SMTP settings come from the first enabled email alert channel
  private async smtpConfig(): Promise<{ host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }> {
    const ch = await queryOne<{ config: Record<string, unknown> }>(
      `SELECT config FROM alert_channels WHERE type = 'email' AND enabled = TRUE ORDER BY id LIMIT 1`);
    const cfg = ch?.config;
    const host = cfg?.smtp_host as string | undefined;
    if (!host) throw new Error('No enabled email alert channel — configure one under Settings → Alerting to send reports');
    return {
      host,
      port: (cfg?.smtp_port as number) || 587,
      secure: !!cfg?.smtp_secure,
      user: cfg?.smtp_user as string | undefined,
      pass: cfg?.smtp_pass as string | undefined,
      from: (cfg?.from_address as string) || (cfg?.smtp_user as string) || 'reports@mikrotik-manager',
    };
  }

  private async buildHtml(frequency: string): Promise<string> {
    const days = PERIOD_DAYS[frequency] ?? 7;
    const [devices, outages, alerts, topClients, backups] = await Promise.all([
      query<{ total: string; online: string; updates: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status='online')::text AS online,
                COUNT(*) FILTER (WHERE firmware_update_available)::text AS updates
         FROM devices`),
      query<{ n: string; secs: string }>(
        // Every outage overlapping the period, clipped to it (P2-25).
        `SELECT COUNT(*)::text AS n, COALESCE(SUM(${outageSecondsSql(`($1 || ' days')::interval`)}),0)::bigint::text AS secs
         FROM device_availability WHERE ${outageOverlapsSql(`($1 || ' days')::interval`)}`, [days]),
      query<{ errors: string; warnings: string }>(
        `SELECT COUNT(*) FILTER (WHERE severity='error')::text AS errors,
                COUNT(*) FILTER (WHERE severity='warning')::text AS warnings
         FROM events WHERE event_time > NOW() - ($1 || ' days')::interval`, [days]),
      query<{ name: string; bytes: string }>(
        // One name per MAC: joining every client row multiplied a MAC's bytes
        // by the number of devices that had seen it.
        `SELECT COALESCE(NULLIF(n.custom_name,''), NULLIF(n.hostname,''), t.mac_address) AS name,
                t.bytes::text AS bytes
         FROM (
           SELECT mac_address, SUM(upload_bytes + download_bytes) AS bytes
             FROM client_traffic_daily
            WHERE day > CURRENT_DATE - $1::int
              AND mac_address NOT IN ('unknown', 'other')
            GROUP BY mac_address
         ) t
         LEFT JOIN LATERAL (
           SELECT custom_name, hostname FROM clients c
            WHERE LOWER(c.mac_address) = t.mac_address
            ORDER BY last_seen DESC NULLS LAST LIMIT 1
         ) n ON TRUE
         ORDER BY t.bytes DESC LIMIT 5`, [days]),
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM backups WHERE created_at > NOW() - ($1 || ' days')::interval`, [days]),
    ]);

    const d = devices[0];
    const outageMin = Math.round(parseInt(outages[0]?.secs || '0', 10) / 60);
    const row = (label: string, value: string) =>
      `<tr><td style="padding:6px 12px;color:#64748b;">${label}</td><td style="padding:6px 12px;font-weight:600;color:#0f172a;">${value}</td></tr>`;

    const clientRows = topClients.map((c, i) =>
      `<tr><td style="padding:4px 12px;color:#64748b;">${i + 1}. ${c.name}</td><td style="padding:4px 12px;color:#0f172a;">${fmtBytes(parseInt(c.bytes, 10))}</td></tr>`).join('');

    return `
<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;">
  <h2 style="color:#0f172a;">MikroTik Manager — ${frequency} report</h2>
  <p style="color:#64748b;font-size:13px;">Covering the last ${days} day${days !== 1 ? 's' : ''} · generated ${new Date().toUTCString()}</p>
  <table style="border-collapse:collapse;width:100%;background:#f8fafc;border-radius:8px;">
    ${row('Devices online', `${d?.online ?? 0} / ${d?.total ?? 0}`)}
    ${row('Outages', `${outages[0]?.n ?? 0} (${outageMin} min total downtime)`)}
    ${row('Error events', alerts[0]?.errors ?? '0')}
    ${row('Warning events', alerts[0]?.warnings ?? '0')}
    ${row('Firmware updates available', d?.updates ?? '0')}
    ${row('Backups taken', backups[0]?.n ?? '0')}
  </table>
  ${topClients.length ? `<h3 style="color:#0f172a;font-size:14px;margin-top:20px;">Top clients by traffic</h3>
  <table style="border-collapse:collapse;width:100%;background:#f8fafc;border-radius:8px;">${clientRows}</table>` : ''}
  <p style="color:#94a3b8;font-size:11px;margin-top:20px;">Sent by MikroTik Manager scheduled reports.</p>
</div>`;
  }
}

export const reportService = new ReportService();
