// NetFlow/IPFIX collector — receives Traffic Flow exports from managed
// RouterOS devices on a UDP socket, attributes flows to known clients
// (IP → MAC via the clients table), classifies them by protocol/port, and
// aggregates into 60-second windows written to InfluxDB (time series) and
// Postgres (daily per-client rollups).

import * as dgram from 'dgram';
import { Point } from '@influxdata/influxdb-client';
import { query } from '../../config/database';
import { getWriteApi } from '../../config/influxdb';
import { decodePacket, pruneTemplateCache, TemplateCache } from './decoder';
import { classifyApp, APP_LAN } from './appCategories';
import { FlowAggregator, CLIENT_UNKNOWN, Direction } from './FlowAggregator';
import { PacketRateLimiter } from './rateLimiter';
import {
  AMBIGUOUS, buildAttributionMaps, isLocalAddress, matchClient,
  type AttributionMaps, type ClientRow, type DeviceRow, type ExporterInfo,
} from './attribution';

const FLUSH_INTERVAL_MS = 60_000;
const MAP_REFRESH_MS = 60_000;
const SETTINGS_RECONCILE_MS = 60_000;

// Smallest packet that could carry a usable header (v9 needs 20, IPFIX 16).
const MIN_PACKET_BYTES = 16;

// Templates unused for this long are dropped, and the cache is hard-capped, so a
// hostile or churning sender can't grow it without bound.
const TEMPLATE_TTL_MS = 30 * 60_000;
const MAX_TEMPLATES = 10_000;

// Bounds on per-source bookkeeping for senders we can't match to a device.
const MAX_UNKNOWN_EXPORTERS = 500;
const OVERFLOW_EXPORTER_ID = -999_999;

// Generous for real exporters (a busy RouterOS device sends far less), tight
// enough that a flood can't monopolise the event loop.
const RATE_LIMIT = { windowMs: 1_000, maxPerSource: 2_000, maxSources: 1_000 };

// Sources whose packets were refused, kept so the NetFlow page can say why
// traffic is missing instead of it vanishing silently.
const MAX_REJECTED_SOURCES = 50;

export type RejectReason = 'unknown_exporter' | 'public_address';

export interface RejectedSource {
  address: string;
  reason: RejectReason;
  packets: number;
  lastSeen: string;
}

export interface ExporterStats {
  deviceId: number;
  deviceName: string;
  packets: number;
  flows: number;
  lastSeen: string | null;
}

export interface CollectorStats {
  listening: boolean;
  port: number;
  packetsReceived: number;
  flowsDecoded: number;
  flowsAttributed: number;
  packetsFromUnknownExporter: number;
  recordsWithoutTemplate: number;
  packetsDropped: number;
  templatesCached: number;
  exporters: ExporterStats[];
  acceptUnknown: boolean;
  rejectedSources: RejectedSource[];
}

interface NetflowSettings {
  enabled: boolean;
  port: number;
  topN: number;
  acceptUnknown: boolean;
}

export class NetflowCollector {
  private socket: dgram.Socket | null = null;
  private templates: TemplateCache = new Map();
  private aggregator = new FlowAggregator();

  private maps: AttributionMaps = buildAttributionMaps([], []);

  private settings: NetflowSettings = { enabled: false, port: 2055, topN: 50, acceptUnknown: false };
  private listening = false;

  // Pseudo-exporter ids for sources that don't match a managed device (e.g.
  // routers exporting from behind NAT). Negative so they can never collide
  // with real device ids. Capped at MAX_UNKNOWN_EXPORTERS; sources beyond that
  // share OVERFLOW_EXPORTER_ID (client attribution doesn't depend on exporter
  // identity, so this only coarsens per-exporter stats).
  private unknownExporterIds = new Map<string, number>();
  private nextPseudoId = -1;
  private rejected = new Map<string, RejectedSource>();
  /** Daily rollups that failed to write, retried at the next flush (J5). */
  private pendingRollups: Array<{ day: string; mac: string; siteId: number; upload: number; download: number; apps: Record<string, number> }> = [];

  private rateLimiter = new PacketRateLimiter(RATE_LIMIT);
  private packetsDropped = 0;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private mapTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  // Stats (since process start)
  private packetsReceived = 0;
  private flowsDecoded = 0;
  private flowsAttributed = 0;
  private packetsFromUnknownExporter = 0;
  private recordsWithoutTemplate = 0;
  private exporterStats = new Map<number, ExporterStats>();

  async start(): Promise<void> {
    await this.refreshMaps().catch(() => {});
    await this.reconcile();
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) => console.error('[NetFlow] Flush error:', e));
    }, FLUSH_INTERVAL_MS);
    this.mapTimer = setInterval(() => {
      this.refreshMaps().catch(() => {});
      // Expire idle templates and cap the cache on the same cadence.
      pruneTemplateCache(this.templates, TEMPLATE_TTL_MS, MAX_TEMPLATES);
    }, MAP_REFRESH_MS);
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch(() => {});
    }, SETTINGS_RECONCILE_MS);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.mapTimer) clearInterval(this.mapTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.closeSocket();
    await this.flush().catch(() => {});
  }

  // Re-read settings and (re)bind or close the socket as needed. Called on an
  // interval and directly by the settings route when netflow_* keys change.
  async reconcile(): Promise<void> {
    const next = await this.readSettings();
    // Also when it should be listening and isn't: a port busy at start, or a
    // socket error, used to stop the collector until a restart (J5).
    const needsRebind =
      next.enabled !== this.settings.enabled ||
      (next.enabled && next.port !== this.settings.port) ||
      (next.enabled && !this.socket);
    this.settings = next;
    if (!needsRebind) return;

    this.closeSocket();
    if (next.enabled) {
      this.bindSocket(next.port);
    }
  }

  getStats(): CollectorStats {
    return {
      listening: this.listening,
      port: this.settings.port,
      packetsReceived: this.packetsReceived,
      flowsDecoded: this.flowsDecoded,
      flowsAttributed: this.flowsAttributed,
      packetsFromUnknownExporter: this.packetsFromUnknownExporter,
      recordsWithoutTemplate: this.recordsWithoutTemplate,
      // packetsDropped already counts both undersized and rate-limited drops.
      packetsDropped: this.packetsDropped,
      templatesCached: this.templates.size,
      exporters: Array.from(this.exporterStats.values()),
      acceptUnknown: this.settings.acceptUnknown,
      rejectedSources: Array.from(this.rejected.values()),
    };
  }

  private async readSettings(): Promise<NetflowSettings> {
    try {
      const rows = await query<{ key: string; value: unknown }>(
        `SELECT key, value FROM app_settings
         WHERE key IN ('netflow_enabled', 'netflow_collector_port', 'netflow_topn_clients',
                       'netflow_accept_unknown')`
      );
      const map: Record<string, unknown> = {};
      for (const row of rows) map[row.key] = row.value;
      return {
        enabled: map['netflow_enabled'] === true,
        // In Docker the container always binds 2055 (NETFLOW_BIND_PORT) and the
        // host port is remapped via compose; netflow_collector_port is the
        // externally reachable port pushed to devices as the export target.
        port: Number(process.env.NETFLOW_BIND_PORT) || Number(map['netflow_collector_port']) || 2055,
        topN: Number(map['netflow_topn_clients']) || 50,
        // Off unless turned on (outside review P2-23). Installs from before
        // keep the stored value they had.
        acceptUnknown: map['netflow_accept_unknown'] === true,
      };
    } catch {
      return this.settings;
    }
  }

  private bindSocket(port: number): void {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    socket.on('error', (err) => {
      console.error(`[NetFlow] Socket error: ${err.message}`);
      this.closeSocket();
    });
    socket.bind(port, () => {
      this.listening = true;
      console.log(`[NetFlow] Collector listening on udp/${port}`);
    });
    this.socket = socket;
  }

  private closeSocket(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    if (this.listening) console.log('[NetFlow] Collector stopped');
    this.listening = false;
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this.packetsReceived++;

    // Cheap guards before any parsing work: undersized datagrams can't carry a
    // usable header, and a single source must not be able to monopolise the
    // event loop (the socket is unauthenticated by protocol design).
    if (msg.length < MIN_PACKET_BYTES) {
      this.packetsDropped++;
      return;
    }
    if (this.rateLimiter.shouldDrop(rinfo.address)) {
      this.packetsDropped++;
      return;
    }

    // Who sent this? A managed device's address identifies the exporter and so
    // the site its clients are matched in. An address shared by devices in two
    // sites is a managed device, but not one site's, so its clients are matched
    // as for an unidentified exporter.
    const found = this.maps.exporterByIp.get(rinfo.address);
    let identified: ExporterInfo | null = null;
    let statsId: number;
    let statsName: string;
    if (found && found !== AMBIGUOUS) {
      identified = found;
      statsId = found.deviceId;
      statsName = found.deviceName;
    } else {
      if (!found) {
        // Doesn't match any managed device. Usually NAT between the routers
        // and the collector, so every packet arrives from the NAT gateway. But
        // NetFlow is unauthenticated, so anyone who can reach the port could
        // send forged flows naming real clients (outside review P2-23). These
        // are taken only when the admin has turned that on, and never from a
        // public address: a NAT gateway in front of the collector is local.
        this.packetsFromUnknownExporter++;
        if (!this.settings.acceptUnknown) { this.reject(rinfo.address, 'unknown_exporter'); return; }
        if (!isLocalAddress(rinfo.address)) { this.reject(rinfo.address, 'public_address'); return; }
      }
      const pseudo = this.pseudoExporter(rinfo.address, found === AMBIGUOUS);
      statsId = pseudo.id;
      statsName = pseudo.name;
    }

    const result = decodePacket(msg, rinfo.address, this.templates);
    this.flowsDecoded += result.flows.length;
    this.recordsWithoutTemplate += result.recordsWithoutTemplate;

    let stats = this.exporterStats.get(statsId);
    if (!stats) {
      stats = { deviceId: statsId, deviceName: statsName, packets: 0, flows: 0, lastSeen: null };
      this.exporterStats.set(statsId, stats);
    }
    stats.packets++;
    stats.flows += result.flows.length;
    stats.deviceName = statsName;
    if (result.flows.length > 0) stats.lastSeen = new Date().toISOString();

    for (const flow of result.flows) {
      this.attribute(statsId, identified, flow.srcAddr, flow.dstAddr, flow.srcPort, flow.dstPort, flow.protocol, flow.bytes, flow.packets);
    }
  }

  private reject(address: string, reason: RejectReason): void {
    const now = new Date().toISOString();
    const seen = this.rejected.get(address);
    if (seen) { seen.packets++; seen.lastSeen = now; seen.reason = reason; return; }
    if (this.rejected.size >= MAX_REJECTED_SOURCES) return;
    this.rejected.set(address, { address, reason, packets: 1, lastSeen: now });
    console.log(`[NetFlow] Refusing flows from ${address}: ${reason === 'public_address'
      ? 'not a managed device, and a public address'
      : 'not a managed device (turn on accepting unidentified exporters if NAT is in the path)'}`);
  }

  // Pseudo-exporter ids for sources that don't identify one managed device.
  private pseudoExporter(address: string, shared: boolean): { id: number; name: string } {
    let id = this.unknownExporterIds.get(address);
    if (id === undefined) {
      if (this.unknownExporterIds.size >= MAX_UNKNOWN_EXPORTERS) {
        // Too many distinct sources to track individually; fold them into one
        // bucket so the maps stay bounded.
        return { id: OVERFLOW_EXPORTER_ID, name: 'Unidentified (many sources)' };
      }
      id = this.nextPseudoId--;
      this.unknownExporterIds.set(address, id);
      if (!shared) console.log(`[NetFlow] Accepting flows from unidentified exporter ${address} (NAT in path?)`);
    }
    return { id, name: shared ? `Shared address (${address})` : `Unidentified (${address})` };
  }

  // Attribution rules:
  //  - exactly one endpoint is a known client → that client's traffic
  //    (client = source → upload, client = destination → download)
  //  - both endpoints known clients → LAN traffic, attributed to both
  //  - a local/private endpoint we can't map to a client → "unknown" bucket
  //  - neither endpoint local (e.g. post-NAT duplicate record where the
  //    source is the router's WAN address) → dropped
  private attribute(
    exporterId: number,
    exporter: ExporterInfo | null,
    srcAddr: string,
    dstAddr: string,
    srcPort: number,
    dstPort: number,
    protocol: number,
    bytes: number,
    packets: number
  ): void {
    // Clients are matched in the exporter's site (outside review J4).
    const src = matchClient(this.maps, exporter, srcAddr);
    const dst = matchClient(this.maps, exporter, dstAddr);
    const srcMac = src.mac;
    const dstMac = dst.mac;
    const srcLocal = srcMac !== undefined || isLocalAddress(srcAddr);
    const dstLocal = dstMac !== undefined || isLocalAddress(dstAddr);

    const add = (side: { mac?: string; siteId: number | null }, direction: Direction, app: string) => {
      this.aggregator.add({ exporterId, siteId: side.siteId, clientKey: side.mac || CLIENT_UNKNOWN, direction, app, bytes, packets });
      this.flowsAttributed++;
    };

    if (srcMac && dstMac) {
      // Client-to-client on the local network
      add(src, 'upload', APP_LAN);
      add(dst, 'download', APP_LAN);
      return;
    }
    if (srcLocal && dstLocal) {
      // Local flow we can't fully attribute (e.g. printer ↔ unknown host)
      if (srcMac) add(src, 'upload', APP_LAN);
      else add(dst, 'download', APP_LAN);
      return;
    }
    if (srcLocal && !dstLocal) {
      add(src, 'upload', classifyApp(protocol, srcPort, dstPort));
      return;
    }
    if (!srcLocal && dstLocal) {
      add(dst, 'download', classifyApp(protocol, dstPort, srcPort));
      return;
    }
    // Neither endpoint local — transit or post-NAT duplicate; drop.
  }

  private async refreshMaps(): Promise<void> {
    // Exporters: management IP + every cached /ip/address, with their site.
    const devices = await query<DeviceRow>(
      `SELECT id, name, site_id, ip_address, ip_addresses_jsonb FROM devices`
    );
    // Clients, with the site of the device that saw them; newest holder of an
    // address in a site first (DHCP reuse).
    const clients = await query<ClientRow>(
      `SELECT DISTINCT ON (d.site_id, c.ip_address) d.site_id, c.ip_address, c.mac_address
         FROM clients c
         JOIN devices d ON d.id = c.device_id
        WHERE c.ip_address IS NOT NULL AND c.ip_address != ''
        ORDER BY d.site_id, c.ip_address, c.last_seen DESC NULLS LAST`
    );
    this.maps = buildAttributionMaps(devices, clients);
  }

  private async flush(): Promise<void> {
    const rows = this.aggregator.drain(this.settings.topN);
    if (rows.length === 0 && this.pendingRollups.length === 0) return;

    const writeApi = getWriteApi();
    const now = new Date();
    for (const row of rows) {
      writeApi.writePoint(
        new Point('client_traffic')
          .tag('mac', row.clientKey)
          .tag('site_id', row.siteId === null ? '' : String(row.siteId))
          .tag('direction', row.direction)
          .tag('app', row.app)
          .intField('bytes', row.bytes)
          .intField('packets', row.packets)
          .timestamp(now)
      );
    }
    await writeApi.flush().catch((e) => console.error('[NetFlow] Influx write error:', e));

    // Daily rollups: totals per mac + per-app byte breakdown
    // Kept per site: the same MAC at two sites is two clients (J4).
    const perClient = new Map<string, { mac: string; siteId: number; upload: number; download: number; apps: Map<string, number> }>();
    for (const row of rows) {
      const key = `${row.siteId ?? 0}|${row.clientKey}`;
      let entry = perClient.get(key);
      if (!entry) {
        entry = { mac: row.clientKey, siteId: row.siteId ?? 0, upload: 0, download: 0, apps: new Map() };
        perClient.set(key, entry);
      }
      if (row.direction === 'upload') entry.upload += row.bytes;
      else entry.download += row.bytes;
      entry.apps.set(row.app, (entry.apps.get(row.app) || 0) + row.bytes);
    }

    // The day is fixed here, so a rollup retried after midnight still lands
    // on the day its traffic happened.
    const today = (await query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`).catch(() => []))[0]?.d
      ?? new Date().toISOString().slice(0, 10);
    const batch = [
      ...this.pendingRollups.splice(0),
      ...[...perClient.values()].map((e) => ({
        day: today, mac: e.mac, siteId: e.siteId, upload: e.upload, download: e.download, apps: Object.fromEntries(e.apps),
      })),
    ];
    for (const entry of batch) {
      try {
        await this.writeRollup(entry);
      } catch (e) {
        // Kept for the next flush rather than lost (J5), within a bound.
        if (this.pendingRollups.length < 20_000) this.pendingRollups.push(entry);
        console.error('[NetFlow] Daily rollup error (will retry):', (e as Error).message);
      }
    }
  }

  private async writeRollup(entry: { day: string; mac: string; siteId: number; upload: number; download: number; apps: Record<string, number> }): Promise<void> {
    await query(
      `INSERT INTO client_traffic_daily (mac_address, day, site_id, upload_bytes, download_bytes, app_breakdown)
       VALUES ($1, $6::date, $5, $2, $3, $4::jsonb)
       ON CONFLICT (mac_address, day, site_id) DO UPDATE SET
         upload_bytes   = client_traffic_daily.upload_bytes + EXCLUDED.upload_bytes,
         download_bytes = client_traffic_daily.download_bytes + EXCLUDED.download_bytes,
         app_breakdown  = (
           SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
           FROM (
             SELECT COALESCE(a.key, b.key) AS k,
                    to_jsonb(COALESCE((a.value)::bigint, 0) + COALESCE((b.value)::bigint, 0)) AS v
             FROM jsonb_each_text(client_traffic_daily.app_breakdown) a
             FULL OUTER JOIN jsonb_each_text(EXCLUDED.app_breakdown) b ON a.key = b.key
           ) merged
         )`,
      [entry.mac, entry.upload, entry.download, JSON.stringify(entry.apps), entry.siteId, entry.day]
    );
  }
}

export const netflowCollector = new NetflowCollector();
