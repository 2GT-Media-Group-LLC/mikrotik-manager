import { Queue, Worker, Job } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { query } from '../config/database';
import { DeviceCollector, DeviceRow } from './mikrotik/DeviceCollector';
import { Server as SocketServer } from 'socket.io';
import { getWriteApi } from '../config/influxdb';
import { Point } from '@influxdata/influxdb-client';
import { alertService } from './AlertService';
import { runConfigHealth } from './changeGuard/configHealth';
import type { GuardDevice } from './changeGuard/ChangeGuard';

interface PollJob {
  deviceId: number;
  type: 'fast' | 'slow' | 'logs' | 'full' | 'macscan' | 'spectral' | 'apscan' | 'configsnap' | 'confighealth';
}

export class PollerService {
  private fastQueue: Queue;
  private slowQueue: Queue;
  private logsQueue: Queue;
  private fastWorker: Worker | null = null;
  private slowWorker: Worker | null = null;
  private logsWorker: Worker | null = null;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private io: SocketServer | null = null;

  constructor() {
    const conn1 = createRedisConnection();
    const conn2 = createRedisConnection();
    const conn3 = createRedisConnection();

    this.fastQueue = new Queue('poll-fast', { connection: conn1 });
    this.slowQueue = new Queue('poll-slow', { connection: conn2 });
    this.logsQueue = new Queue('poll-logs', { connection: conn3 });
  }

  setSocketServer(io: SocketServer): void {
    this.io = io;
  }

  async start(): Promise<void> {
    this.startWorkers();
    this.startScheduler();
    console.log('PollerService started');
  }

  async stop(): Promise<void> {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
    }
    await this.fastWorker?.close();
    await this.slowWorker?.close();
    await this.logsWorker?.close();
    await this.fastQueue.close();
    await this.slowQueue.close();
    await this.logsQueue.close();
  }

  async scheduleDeviceSync(deviceId: number, type: PollJob['type'] = 'full'): Promise<void> {
    const jobData: PollJob = { deviceId, type };
    if (type === 'full') {
      await this.fastQueue.add('device-full-sync', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } else if (type === 'fast') {
      await this.fastQueue.add('device-fast-poll', jobData, { attempts: 2 });
    } else if (type === 'slow') {
      await this.slowQueue.add('device-slow-poll', jobData, { attempts: 2 });
    } else if (type === 'logs') {
      await this.logsQueue.add('device-logs-poll', jobData, { attempts: 2 });
    } else if (type === 'macscan') {
      await this.fastQueue.add('device-macscan', jobData, { attempts: 1 });
    } else if (type === 'spectral') {
      await this.slowQueue.add('device-spectral', jobData, { attempts: 1 });
    } else if (type === 'apscan') {
      await this.slowQueue.add('device-apscan', jobData, { attempts: 1 });
    } else if (type === 'configsnap') {
      await this.slowQueue.add('device-configsnap', jobData, { attempts: 1 });
    } else if (type === 'confighealth') {
      await this.slowQueue.add('device-confighealth', jobData, { attempts: 1 });
    }
  }

  private startScheduler(): void {
    // Schedule polls every 30 seconds
    this.schedulerInterval = setInterval(async () => {
      await this.schedulePollCycle();
    }, 30_000);

    // Also run immediately
    setTimeout(() => this.schedulePollCycle(), 5000);
  }

  private async schedulePollCycle(): Promise<void> {
    try {
      const appSettings = await this.getAppSettings();
      const macScanEnabled  = appSettings['mac_scan_enabled']  !== false;
      const macScanInterval = (appSettings['mac_scan_interval'] as number) || 300;
      const reverseDnsEnabled = appSettings['reverse_dns_enabled'] === true;
      const spectralEnabled       = appSettings['spectral_scan_enabled'] === true;
      const spectralIntervalHours = (appSettings['spectral_scan_interval_hours'] as number) || 24;
      const apScanEnabled         = appSettings['ap_scan_enabled'] === true;
      const apScanIntervalHours   = (appSettings['ap_scan_interval_hours'] as number) || 24;
      const backupScheduleEnabled = appSettings['backup_schedule_enabled'] === true;
      const backupScheduleCron    = (appSettings['backup_schedule_cron'] as string) || '0 2 * * *';
      const configSnapEnabled      = appSettings['config_snapshot_enabled'] !== false;
      const configSnapIntervalMin  = (appSettings['config_snapshot_interval_min'] as number) || 60;
      const configHealthEnabled     = appSettings['config_health_enabled'] !== false;
      const configHealthIntervalMin = (appSettings['config_health_interval_min'] as number) || 60;

      const devices = await query<DeviceRow>(
        `SELECT * FROM devices WHERE status != 'disabled'`
      );

      const now = Date.now();
      for (const device of devices) {
        // Fast poll every 30s
        await this.scheduleDeviceSync(device.id, 'fast');

        // Slow poll every 5min (300s)
        const slowKey = `poll:slow:${device.id}`;
        const lastSlow = await this.getTimestamp(slowKey);
        if (now - lastSlow > 300_000) {
          await this.scheduleDeviceSync(device.id, 'slow');
          await this.setTimestamp(slowKey, now);
        }

        // Logs poll every 60s
        const logsKey = `poll:logs:${device.id}`;
        const lastLogs = await this.getTimestamp(logsKey);
        if (now - lastLogs > 60_000) {
          await this.scheduleDeviceSync(device.id, 'logs');
          await this.setTimestamp(logsKey, now);
        }

        // MAC scan — switches only, user-configured interval
        if (macScanEnabled && device.device_type === 'switch') {
          const macKey = `poll:macscan:${device.id}`;
          const lastMac = await this.getTimestamp(macKey);
          if (now - lastMac > macScanInterval * 1_000) {
            await this.scheduleDeviceSync(device.id, 'macscan');
            await this.setTimestamp(macKey, now);
          }
        }

        // Spectral scan — wireless_ap only, user-configured interval (default 24h)
        if (spectralEnabled && device.device_type === 'wireless_ap') {
          const spectralKey = `poll:spectral:${device.id}`;
          const lastSpectral = await this.getTimestamp(spectralKey);
          if (now - lastSpectral > spectralIntervalHours * 3_600_000) {
            await this.scheduleDeviceSync(device.id, 'spectral');
            await this.setTimestamp(spectralKey, now);
          }
        }

        // AP scan — wireless_ap only, user-configured interval (default 24h)
        if (apScanEnabled && device.device_type === 'wireless_ap') {
          const apScanKey = `poll:apscan:${device.id}`;
          const lastApScan = await this.getTimestamp(apScanKey);
          if (now - lastApScan > apScanIntervalHours * 3_600_000) {
            await this.scheduleDeviceSync(device.id, 'apscan');
            await this.setTimestamp(apScanKey, now);
          }
        }

        // Config snapshot — capture config history & detect drift, user-configured
        // interval (default 60min). The snapshot itself dedups by content hash, so
        // this only stores a new row when the device config actually changed.
        if (configSnapEnabled) {
          const configKey = `poll:configsnap:${device.id}`;
          const lastConfig = await this.getTimestamp(configKey);
          if (now - lastConfig > configSnapIntervalMin * 60_000) {
            await this.scheduleDeviceSync(device.id, 'configsnap');
            // Keep the gate key alive for the full interval (+ buffer) so the
            // snapshot honours the configured cadence rather than the default TTL.
            await this.setTimestamp(configKey, now, configSnapIntervalMin * 60 + 120);
          }
        }

        // Config Health — audit for configurations RouterOS accepted but that do
        // not work. Own cadence (default 60min) because it costs a full state read.
        if (configHealthEnabled) {
          const healthKey = `poll:confighealth:${device.id}`;
          const lastHealth = await this.getTimestamp(healthKey);
          if (now - lastHealth > configHealthIntervalMin * 60_000) {
            await this.scheduleDeviceSync(device.id, 'confighealth');
            await this.setTimestamp(healthKey, now, configHealthIntervalMin * 60 + 120);
          }
        }
      }

      // Reverse DNS enrichment — global, runs every 5 minutes when enabled
      if (reverseDnsEnabled) {
        const rdnsKey = 'task:reverse_dns';
        const lastRdns = await this.getTimestamp(rdnsKey);
        if (now - lastRdns > 300_000) {
          await this.setTimestamp(rdnsKey, now);
          this.resolveClientHostnames().catch((e) =>
            console.error('[Poller] Reverse DNS error:', e)
          );
        }
      }

      // Stale topology-link cleanup — runs every 15 minutes.
      // Removes neighbor rows whose reporting device missed enough slow polls
      // (slow poll = 5 min; 20-min window = 4 missed polls) without being
      // explicitly marked offline, e.g. after a crash.
      const staleLinksKey = 'task:stale_topology_links';
      const lastStaleLinks = await this.getTimestamp(staleLinksKey);
      if (now - lastStaleLinks > 900_000) {
        await this.setTimestamp(staleLinksKey, now);
        query(`DELETE FROM topology_links WHERE discovered_at < NOW() - INTERVAL '20 minutes'`)
          .catch((e) => console.error('[Poller] Stale topology-link cleanup error:', e));
      }

      // Firmware update check — runs once per day
      const firmwareKey = 'task:firmware_check';
      const lastFirmware = await this.getTimestamp(firmwareKey);
      if (now - lastFirmware > 86_400_000) {
        await this.setTimestamp(firmwareKey, now);
        this.checkAllDevicesFirmware(devices).catch((e) =>
          console.error('[Poller] Firmware check error:', e)
        );
      }

      // NetFlow data retention — runs once per day. Purges old client_traffic
      // points from InfluxDB and old daily rollups from Postgres.
      const netflowPruneKey = 'task:netflow_retention';
      const lastNetflowPrune = await this.getTimestamp(netflowPruneKey);
      if (now - lastNetflowPrune > 86_400_000) {
        await this.setTimestamp(netflowPruneKey, now, 86_400 + 3_600);
        this.purgeNetflowData().catch((e) =>
          console.error('[Poller] NetFlow retention error:', e)
        );
      }

      // Stale client pruning — runs once per hour
      // Deletes inactive client records not seen for longer than retention_clients_days.
      const pruneKey = 'task:prune_clients';
      const lastPrune = await this.getTimestamp(pruneKey);
      if (now - lastPrune > 3_600_000) {
        await this.setTimestamp(pruneKey, now);
        this.pruneStaleClients(appSettings).catch((e) =>
          console.error('[Poller] Client prune error:', e)
        );
      }

      // Scheduled backups — fire when the cron expression matches the current minute/hour.
      // Redis key with 1-hour TTL prevents double-firing within the same cron window.
      if (backupScheduleEnabled && this.cronMatchesNow(backupScheduleCron)) {
        const backupKey = 'task:scheduled_backup';
        const lastBackup = await this.getTimestamp(backupKey);
        if (now - lastBackup > 3_600_000) {
          await this.setTimestamp(backupKey, now);
          this.runScheduledBackups().catch((e) =>
            console.error('[Poller] Scheduled backup error:', e)
          );
        }
      }
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  }

  private async getAppSettings(): Promise<Record<string, unknown>> {
    try {
      const rows = await query<{ key: string; value: unknown }>(
        `SELECT key, value FROM app_settings
         WHERE key IN ('mac_scan_enabled', 'mac_scan_interval', 'reverse_dns_enabled',
                       'retention_clients_days', 'spectral_scan_enabled',
                       'spectral_scan_interval_hours', 'ap_scan_enabled',
                       'ap_scan_interval_hours', 'backup_schedule_enabled',
                       'backup_schedule_cron', 'config_snapshot_enabled',
                       'config_snapshot_interval_min')`
      );
      const map: Record<string, unknown> = {};
      for (const row of rows) map[row.key] = row.value;
      return map;
    } catch {
      return {};
    }
  }

  // Returns true if the 5-part cron expression matches the current time.
  // Evaluates all five fields — minute, hour, day-of-month, month, day-of-week —
  // so weekly (e.g. `0 3 * * 0`) and monthly (`0 3 1 * *`) schedules fire only on
  // the right day, not every day. Supports: *, exact numbers, comma lists,
  // ranges (a-b), and step values (*/n). Day-of-month and day-of-week follow the
  // standard cron rule: when both are restricted the job runs if either matches;
  // when only one is restricted, only that one must match.
  private cronMatchesNow(cron: string): boolean {
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) return false;
    const [minuteField, hourField, domField, monthField, dowField] = parts;
    const now = new Date();
    const matchField = (field: string, val: number): boolean => {
      if (field === '*') return true;
      return field.split(',').some((f) => {
        if (f.includes('/')) {
          const [base, step] = f.split('/');
          const start = base === '*' ? 0 : Number(base);
          return val >= start && (val - start) % Number(step) === 0;
        }
        if (f.includes('-')) {
          const [lo, hi] = f.split('-').map(Number);
          return val >= lo && val <= hi;
        }
        return Number(f) === val;
      });
    };

    if (!matchField(minuteField, now.getMinutes())) return false;
    if (!matchField(hourField, now.getHours())) return false;
    if (!matchField(monthField, now.getMonth() + 1)) return false; // cron months are 1-12

    // Day-of-month (1-31) and day-of-week (0-6, Sun=0). getDay() returns 0 for Sunday.
    const domRestricted = domField !== '*';
    const dowRestricted = dowField !== '*';
    const domMatch = matchField(domField, now.getDate());
    const dowMatch = matchField(dowField, now.getDay());
    let dayMatch: boolean;
    if (!domRestricted && !dowRestricted) dayMatch = true;
    else if (domRestricted && dowRestricted) dayMatch = domMatch || dowMatch;
    else dayMatch = domRestricted ? domMatch : dowMatch;
    return dayMatch;
  }

  private async runScheduledBackups(): Promise<void> {
    const { BackupService } = await import('./BackupService');
    const backupService = new BackupService();
    const devices = await query<{
      id: number; name: string; ip_address: string; ssh_port: number;
      ssh_username: string; ssh_password_encrypted: string;
      api_username: string; api_password_encrypted: string;
    }>(`SELECT id, name, ip_address, ssh_port, ssh_username, ssh_password_encrypted,
               api_username, api_password_encrypted
        FROM devices WHERE status = 'online'`);
    console.log(`[Poller] Starting scheduled backup for ${devices.length} online device(s)`);
    const results = await Promise.allSettled(
      devices.map((d) => backupService.createBackup(d, 'Scheduled backup', 'scheduled'))
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    console.log(`[Poller] Scheduled backup complete: ${succeeded}/${devices.length} succeeded`);
  }

  private async resolveClientHostnames(): Promise<void> {
    const { reverse } = await import('dns/promises');

    const clients = await query<{ mac_address: string; ip_address: string }>(
      `SELECT DISTINCT ON (ip_address) mac_address, ip_address
       FROM clients
       WHERE ip_address IS NOT NULL AND ip_address != ''
         AND (hostname IS NULL OR hostname = '')
       ORDER BY ip_address, last_seen DESC
       LIMIT 50`
    );
    if (clients.length === 0) return;

    const results = await Promise.allSettled(
      clients.map(async (c) => {
        const names = await reverse(c.ip_address);
        return { mac: c.mac_address, hostname: names[0] };
      })
    );

    let updated = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        await query(
          `UPDATE clients SET hostname = $1
           WHERE mac_address = $2 AND (hostname IS NULL OR hostname = '')`,
          [r.value.hostname, r.value.mac]
        );
        updated++;
      }
    }

    if (updated > 0) {
      console.log(`[Poller] Reverse DNS enriched ${updated} client hostname(s)`);
      this.io?.emit('clients:updated', {});
    }
  }

  private async purgeNetflowData(): Promise<void> {
    const rows = await query<{ key: string; value: unknown }>(
      `SELECT key, value FROM app_settings
       WHERE key IN ('netflow_retention_days', 'netflow_daily_retention_days')`
    );
    const map: Record<string, unknown> = {};
    for (const row of rows) map[row.key] = row.value;
    const detailDays = Number(map['netflow_retention_days']) || 30;
    const dailyDays = Number(map['netflow_daily_retention_days']) || 365;

    // InfluxDB: delete client_traffic points older than the detail retention
    const { DeleteAPI } = await import('@influxdata/influxdb-client-apis');
    const { getInfluxClient, org, bucket } = await import('../config/influxdb');
    const stop = new Date(Date.now() - detailDays * 86_400_000).toISOString();
    await new DeleteAPI(getInfluxClient())
      .postDelete({
        org,
        bucket,
        body: {
          start: '1970-01-01T00:00:00Z',
          stop,
          predicate: '_measurement="client_traffic"',
        },
      })
      .catch((e) => console.error('[Poller] NetFlow Influx purge error:', (e as Error).message));

    // Postgres: delete daily rollups older than the rollup retention
    const result = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM client_traffic_daily
         WHERE day < CURRENT_DATE - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [dailyDays]
    );
    const count = parseInt(result[0]?.count || '0', 10);
    if (count > 0) {
      console.log(`[Poller] NetFlow retention pruned ${count} daily rollup row(s) (> ${dailyDays} days)`);
    }
  }

  private async pruneStaleClients(settings: Record<string, unknown>): Promise<void> {
    // Delete inactive clients not seen for longer than the configured retention period.
    // Default: 7 days. Preserves any client that was active within the window so
    // short-lived or intermittent devices aren't wiped prematurely.
    const retentionDays = (settings['retention_clients_days'] as number) || 7;
    const result = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM clients
         WHERE active = FALSE
           AND last_seen < NOW() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [retentionDays]
    );
    const count = parseInt(result[0]?.count || '0', 10);
    if (count > 0) {
      console.log(`[Poller] Pruned ${count} stale client record(s) (inactive > ${retentionDays} days)`);
      this.io?.emit('clients:updated', {});
    }
  }

  async pruneStaleClientsNow(): Promise<number> {
    const rows = await query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'retention_clients_days'`
    );
    const retentionDays = (rows[0]?.value as number) || 7;
    const result = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM clients
         WHERE active = FALSE
           AND last_seen < NOW() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [retentionDays]
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  private async getTimestamp(key: string): Promise<number> {
    try {
      const { redis } = await import('../config/redis');
      const val = await redis.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch {
      return 0;
    }
  }

  private async setTimestamp(key: string, ts: number, ttlSec = 600): Promise<void> {
    try {
      const { redis } = await import('../config/redis');
      await redis.set(key, String(ts), 'EX', ttlSec);
    } catch { /* redis unavailable — timestamp not cached */ }
  }

  private startWorkers(): void {
    const workerOptions = {
      connection: createRedisConnection(),
      concurrency: 3,
    };

    this.fastWorker = new Worker(
      'poll-fast',
      async (job: Job<PollJob>) => {
        await this.processPollJob(job.data);
      },
      workerOptions
    );

    this.slowWorker = new Worker(
      'poll-slow',
      async (job: Job<PollJob>) => {
        await this.processSlowJob(job.data);
      },
      { ...workerOptions, connection: createRedisConnection() }
    );

    this.logsWorker = new Worker(
      'poll-logs',
      async (job: Job<PollJob>) => {
        await this.processLogsJob(job.data);
      },
      { ...workerOptions, connection: createRedisConnection() }
    );

    this.fastWorker.on('failed', (job, err) => {
      if (job) {
        this.handleDeviceFailure(job.data.deviceId, err.message);
      }
    });
  }

  private async processPollJob(data: PollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const prevStatus = device.status; // capture before poll
    const collector = new DeviceCollector(device);
    try {
      await collector.connect();

      if (data.type === 'full') {
        await collector.collectAll();
      } else if (data.type === 'macscan') {
        await collector.runMacScan();
        this.io?.emit('clients:updated', { deviceId: device.id });
        return;
      } else {
        await collector.collectFast();
      }

      // Device came online (first poll after add, or recovery from offline)
      if (prevStatus !== 'online') {
        alertService.dispatch('device_online', `${device.name} is back online`, {
          deviceId: device.id,
          deviceName: device.name,
        }).catch(() => {});
        // Close the open outage row if one exists
        if (prevStatus === 'offline') {
          query(
            `UPDATE device_availability
             SET came_back_online_at = NOW(),
                 duration_seconds = EXTRACT(EPOCH FROM (NOW() - went_offline_at))::INTEGER
             WHERE device_id = $1 AND came_back_online_at IS NULL`,
            [device.id]
          ).catch(() => {});
        }
      }

      this.io?.emit('device:updated', { deviceId: device.id });
      this.io?.emit('clients:updated', { deviceId: device.id });
    } catch (err) {
      await this.handleDeviceFailure(device.id, (err as Error).message);
      throw err;
    } finally {
      collector.disconnect();
    }
  }

  private static aggregateSpectralRows(
    rows: Record<string, string>[]
  ): { freq: number; magn: number; peak: number }[] {
    const map = new Map<number, { sum: number; count: number; peak: number }>();
    for (const row of rows) {
      const freq = parseFloat(row['freq'] || '0');
      const magn = parseInt(row['magn'] || '-120', 10);
      const peak = parseInt(row['peak'] || magn.toString(), 10);
      if (freq <= 0) continue;
      const existing = map.get(freq);
      if (existing) {
        existing.sum   += magn;
        existing.count += 1;
        existing.peak   = Math.max(existing.peak, peak);
      } else {
        map.set(freq, { sum: magn, count: 1, peak });
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([freq, { sum, count, peak }]) => ({
        freq,
        magn: Math.round(sum / count),
        peak,
      }));
  }

  private static aggregateAPScanRows(
    allRows: { iface: string; rows: Record<string, string>[] }[],
    lookupVendor: (mac: string) => string
  ): unknown[] {
    interface BandEntry { bssid: string; vendor: string; signal: number; freq: number; band: string; channel_width: string }
    interface NetworkEntry { ssid: string; security: string; hidden: boolean; entries: BandEntry[] }
    const byKey = new Map<string, NetworkEntry>();

    function normBand(band: string, freq: number): string {
      if (band.includes('6ghz') || freq >= 5925) return '6 GHz';
      if (band.includes('5ghz') || (freq >= 4900 && freq < 5925)) return '5 GHz';
      return '2.4 GHz';
    }

    for (const { rows } of allRows) {
      for (const row of rows) {
        const ssid   = row['network-name'] || row['ssid'] || '';
        const bssid  = (row['address'] || row['bssid'] || '').toLowerCase();
        if (!bssid) continue;
        const rawSig = row['signal-strength'] || row['signal'] || '-100';
        const signal = parseInt(rawSig, 10) || -100;
        const freq   = parseFloat(row['frequency'] || row['channel'] || '0');
        const band   = normBand(row['band'] || row['radio-band'] || '', freq);
        const security = row['security'] || row['authentication-types'] ? (row['security'] || 'WPA') : 'open';
        const channelWidth = row['channel-width'] || '';
        const key = ssid || `hidden:${bssid}`;

        if (!byKey.has(key)) {
          byKey.set(key, { ssid, security, hidden: !ssid, entries: [] });
        }
        const net = byKey.get(key)!;
        const existing = net.entries.find(e => e.bssid === bssid && e.freq === freq);
        if (existing) {
          if (signal > existing.signal) existing.signal = signal;
        } else {
          net.entries.push({ bssid, vendor: lookupVendor(bssid), signal, freq, band, channel_width: channelWidth });
        }
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const aBest = Math.max(...a.entries.map(e => e.signal));
      const bBest = Math.max(...b.entries.map(e => e.signal));
      return bBest - aBest;
    });
  }

  private async processSpectralJob(data: PollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    // Fetch wireless interfaces for this device so we know which radios to scan
    const ifaces = await query<{ name: string }>(
      `SELECT name FROM wireless_interfaces WHERE device_id = $1 AND disabled = FALSE`,
      [device.id]
    );
    if (ifaces.length === 0) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      for (const iface of ifaces) {
        const rows = await collector.collectSpectralScan(iface.name);
        if (rows.length === 0) continue;
        const aggregated = PollerService.aggregateSpectralRows(rows);
        await query(
          `INSERT INTO spectral_scan_data (device_id, interface_name, data, scan_type)
           VALUES ($1, $2, $3, 'scheduled')`,
          [device.id, iface.name, JSON.stringify(aggregated)]
        );
        console.log(`[Poller] Spectral scan saved for ${device.name}/${iface.name} (${aggregated.length} freq points)`);
      }
    } catch (err) {
      console.error(`[Poller] Spectral scan failed for ${device.name}:`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async processApScanJob(data: PollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const ifaces = await query<{ name: string }>(
      `SELECT name FROM wireless_interfaces WHERE device_id = $1 AND disabled = FALSE`,
      [device.id]
    );
    if (ifaces.length === 0) return;

    const { lookupVendor } = await import('../utils/oui');
    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      const allRows: { iface: string; rows: Record<string, string>[] }[] = [];
      for (const iface of ifaces) {
        const rows = await collector.scanWireless(iface.name).catch(() => [] as Record<string, string>[]);
        if (rows.length > 0) allRows.push({ iface: iface.name, rows });
      }
      if (allRows.length === 0) return;

      const aggregated = PollerService.aggregateAPScanRows(allRows, lookupVendor);
      await query(
        `INSERT INTO ap_scan_data (device_id, data, scan_type) VALUES ($1, $2, 'scheduled')`,
        [device.id, JSON.stringify(aggregated)]
      );
      console.log(`[Poller] AP scan saved for ${device.name} (${aggregated.length} networks)`);
    } catch (err) {
      console.error(`[Poller] AP scan failed for ${device.name}:`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async processConfigSnapJob(data: PollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    // Config snapshots capture `/export` over SSH. Only attempt this automatically
    // when SSH credentials are actually configured — otherwise we'd repeatedly try
    // (and fail) SSH auth using the API credentials, flooding the device logs on
    // devices where SSH was never set up. Manual "Capture snapshot" is unaffected.
    if (!device.ssh_username || !device.ssh_password_encrypted) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await collector.snapshotConfig('scheduled');
    } catch (err) {
      console.error(`[Poller] Config snapshot failed for ${device.name}:`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  /**
   * Audit the device for configurations RouterOS accepted but that do not work.
   * Read-only over the API, and failures are non-fatal: a device we cannot read is
   * left with its previous findings rather than being wrongly reported as clean.
   */
  private async processConfigHealthJob(data: PollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;
    try {
      const { findings } = await runConfigHealth(device as unknown as GuardDevice);
      const critical = findings.filter((f) => f.severity === 'critical').length;
      if (critical > 0) {
        this.io?.emit('device:updated', { deviceId: device.id });
      }
    } catch (err) {
      console.error(`[Poller] Config health audit failed for ${device.name}:`, (err as Error).message);
    }
  }

  private async processSlowJob(data: PollJob): Promise<void> {
    if (data.type === 'spectral') {
      return this.processSpectralJob(data);
    }
    if (data.type === 'apscan') {
      return this.processApScanJob(data);
    }
    if (data.type === 'configsnap') {
      return this.processConfigSnapJob(data);
    }
    if (data.type === 'confighealth') {
      return this.processConfigHealthJob(data);
    }

    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await collector.collectSlow();
      await collector.collectNeighbors();
      await collector.collectStp();
      this.io?.emit('device:updated', { deviceId: device.id });

      // Fire device_discovered for any LLDP neighbors not matched to a managed device.
      // AlertService's per-cooldownKey cooldown prevents repeat alerts for the same neighbor.
      const unresolved = await query<{ neighbor_address: string; neighbor_identity: string }>(
        `SELECT DISTINCT neighbor_address, neighbor_identity
         FROM topology_links
         WHERE from_device_id = $1
           AND to_device_id IS NULL
           AND neighbor_address IS NOT NULL`,
        [device.id]
      );
      for (const nb of unresolved) {
        alertService.dispatch('device_discovered',
          `Unmanaged device discovered: ${nb.neighbor_identity || nb.neighbor_address} (${nb.neighbor_address})`,
          {
            details: nb.neighbor_identity || undefined,
            cooldownKey: `device_discovered:${nb.neighbor_address}`,
          }
        ).catch(() => {});
      }
    } catch (err) {
      await this.handleDeviceFailure(device.id, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async processLogsJob(data: PollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await collector.collectLogs();
      this.io?.emit('events:updated', { deviceId: device.id });

      // Fire log_error / log_warning alerts if new entries appeared in the last 90s
      const recent = await query<{ severity: string; message: string }>(
        `SELECT severity, message FROM events
         WHERE device_id = $1
           AND event_time > NOW() - INTERVAL '90 seconds'
         ORDER BY event_time DESC LIMIT 1`,
        [device.id]
      );
      for (const ev of recent) {
        if (ev.severity === 'error') {
          alertService.dispatch('log_error', ev.message, {
            deviceId: device.id,
            deviceName: device.name,
          }).catch(() => {});
        } else if (ev.severity === 'warning') {
          alertService.dispatch('log_warning', ev.message, {
            deviceId: device.id,
            deviceName: device.name,
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[PollerService] Log collection failed for device ${device.id} (${device.name}):`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async handleDeviceFailure(deviceId: number, message: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    const prevStatus = device?.status;
    await query(`UPDATE devices SET status = 'offline', updated_at = NOW() WHERE id = $1`, [deviceId]);
    if (prevStatus !== 'offline') {
      alertService.dispatch('device_offline', `${device?.name ?? `Device #${deviceId}`} is offline: ${message}`, {
        deviceId,
        deviceName: device?.name,
      }).catch(() => {});
      // Open a new availability outage row
      query(
        `INSERT INTO device_availability (device_id, went_offline_at) VALUES ($1, NOW())`,
        [deviceId]
      ).catch(() => {});
    }
    // Mark all clients for this device inactive — updateClients() never ran because connect() failed.
    await query(`UPDATE clients SET active = FALSE WHERE device_id = $1`, [deviceId]);
    // Clear stale neighbor links — the device can't re-sync to clean them up itself.
    await query(`DELETE FROM topology_links WHERE from_device_id = $1`, [deviceId]);
    // Write updated global deduped count and a per-device zero so history is continuous.
    if (device) {
      const writeApi = getWriteApi();
      writeApi.writePoint(
        new Point('client_counts')
          .tag('device_id', String(deviceId))
          .tag('device_name', device.name)
          .intField('total_clients', 0)
          .intField('wireless_clients', 0)
          .intField('wired_clients', 0)
          .timestamp(new Date())
      );
      // Recompute global deduplicated count after marking this device's clients inactive.
      const dedupedRows = await query<{ count: string }>(
        `SELECT COUNT(DISTINCT mac_address) AS count FROM clients WHERE active = TRUE`
      );
      const globalTotal = parseInt(dedupedRows[0]?.count || '0', 10);
      writeApi.writePoint(
        new Point('client_counts')
          .tag('device_id', '_global')
          .tag('device_name', '_global')
          .intField('total_clients', globalTotal)
          .timestamp(new Date())
      );
      await writeApi.flush().catch(() => {});
    }
    this.io?.emit('device:status', { deviceId, status: 'offline', message });
    this.io?.emit('clients:updated', { deviceId });
  }

  private async checkAllDevicesFirmware(devices: DeviceRow[]): Promise<void> {
    // Only check devices that are currently online to avoid long timeouts
    const onlineDevices = devices.filter((d) => d.status === 'online');
    console.log(`[Poller] Starting firmware check for ${onlineDevices.length} online device(s)`);

    for (const device of onlineDevices) {
      const collector = new DeviceCollector(device);
      try {
        await collector.connect();
        const updateInfo = await collector.checkForUpdates();

        const latestVersion = (updateInfo['latest-version'] ?? '').trim();
        const installedVersion = (updateInfo['installed-version'] ?? '').trim();
        const statusText = (updateInfo['status'] ?? '').toLowerCase();

        const hasUpdate = Boolean(
          statusText.includes('available') ||
          (latestVersion && installedVersion && latestVersion !== installedVersion)
        );

        // Read current flag before updating so we can detect first-discovery
        const current = await query<{ firmware_update_available: boolean }>(
          `SELECT firmware_update_available FROM devices WHERE id = $1`,
          [device.id]
        );
        const wasAvailable = current[0]?.firmware_update_available ?? false;

        await query(
          `UPDATE devices
           SET firmware_update_available = $1,
               latest_ros_version = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [hasUpdate, latestVersion || null, device.id]
        );

        if (hasUpdate) {
          this.io?.emit('device:updated', { deviceId: device.id });
          // Alert only on first discovery (not on every daily check)
          if (!wasAvailable) {
            const msg = latestVersion
              ? `${device.name} has a firmware update available: ${latestVersion}`
              : `${device.name} has a firmware update available`;
            alertService.dispatch('firmware_update_available', msg, {
              deviceId: device.id,
              deviceName: device.name,
              details: latestVersion ? `Current: ${installedVersion}  →  Latest: ${latestVersion}` : undefined,
            }).catch(() => {});
            console.log(`[Poller] Firmware update detected for ${device.name}: ${installedVersion} → ${latestVersion}`);
          }
        } else if (wasAvailable) {
          // Update was installed — clear the flag and notify the UI
          this.io?.emit('device:updated', { deviceId: device.id });
        }

        // RouterBOOT check — reuse the existing connection
        const rbInfo = await collector.checkRouterboardUpgrade().catch(() => ({ upgradeAvailable: false, upgradeFirmware: '', currentFirmware: '' }));
        const rbCurrentRows = await query<{ routerboard_upgrade_available: boolean }>(
          `SELECT routerboard_upgrade_available FROM devices WHERE id = $1`,
          [device.id]
        );
        const rbWasAvailable = rbCurrentRows[0]?.routerboard_upgrade_available ?? false;
        await query(
          `UPDATE devices SET routerboard_upgrade_available = $1, upgrade_firmware_version = $2, updated_at = NOW() WHERE id = $3`,
          [rbInfo.upgradeAvailable, rbInfo.upgradeFirmware || null, device.id]
        );
        if (rbInfo.upgradeAvailable) {
          this.io?.emit('device:updated', { deviceId: device.id });
          if (!rbWasAvailable) {
            const rbMsg = rbInfo.upgradeFirmware
              ? `${device.name} has a RouterBOOT upgrade available: ${rbInfo.upgradeFirmware}`
              : `${device.name} has a RouterBOOT upgrade available`;
            alertService.dispatch('firmware_update_available', rbMsg, {
              deviceId: device.id,
              deviceName: device.name,
              details: rbInfo.upgradeFirmware ? `Current: ${rbInfo.currentFirmware}  →  Upgrade: ${rbInfo.upgradeFirmware}` : undefined,
            }).catch(() => {});
            console.log(`[Poller] RouterBOOT upgrade detected for ${device.name}: ${rbInfo.currentFirmware} → ${rbInfo.upgradeFirmware}`);
          }
        } else if (rbWasAvailable) {
          this.io?.emit('device:updated', { deviceId: device.id });
        }
      } catch (err) {
        console.error(`[Poller] Firmware check failed for ${device.name}:`, (err as Error).message);
      } finally {
        collector.disconnect();
      }
    }
    console.log(`[Poller] Firmware check complete`);
  }

  private async getDevice(deviceId: number): Promise<DeviceRow | null> {
    const rows = await query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
    return rows[0] || null;
  }
}
