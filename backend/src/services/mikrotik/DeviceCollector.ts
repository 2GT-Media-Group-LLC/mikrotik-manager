import { RouterOSClient } from './RouterOSClient';
import { query, queryOne } from '../../config/database';
import { getWriteApi } from '../../config/influxdb';
import { Point } from '@influxdata/influxdb-client';
import { decrypt } from '../../utils/crypto';
import { lookupVendor } from '../../utils/oui';
import { buildServerArpMap } from '../../utils/serverArp';

/** DB column limits for topology_links (see migrate.ts); reject oversize rows instead of silent truncation. */
const TOPOLOGY_LINK_LIMITS = {
  from_interface: 512,
  to_interface: 512,
  neighbor_address: 45,
  neighbor_identity: 255,
  neighbor_platform: 255,
  neighbor_mac: 17,
  neighbor_caps: 255,
  discovered_by: 512,
} as const;

function topologyNeighborOversized(
  field: keyof typeof TOPOLOGY_LINK_LIMITS,
  value: string | null | undefined
): { limit: number; len: number } | null {
  if (value == null || value === '') return null;
  const limit = TOPOLOGY_LINK_LIMITS[field];
  return value.length > limit ? { limit, len: value.length } : null;
}

export interface DeviceRow {
  id: number;
  name: string;
  ip_address: string;
  api_port: number;
  api_username: string;
  api_password_encrypted: string;
  ssh_username?: string;
  ssh_password_encrypted?: string;
  model?: string;
  ros_version?: string;
  device_type: string;
  status: string;
}

export class DeviceCollector {
  private client: RouterOSClient;

  constructor(private device: DeviceRow) {
    this.client = new RouterOSClient(
      device.ip_address,
      device.api_port,
      device.api_username,
      decrypt(device.api_password_encrypted)
    );
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  // ─── Fast poll (every 30s) ─────────────────────────────────────────────────

  async collectFast(): Promise<void> {
    await this.collectInterfaceTraffic();
    await this.collectResourceUsage();
    await this.updateClients();
    if (this.device.device_type === 'wireless_ap') {
      await this.collectWirelessStats();
    }
    await this.updateDeviceStatus('online');
  }

  // ─── Slow poll (every 5 min) ───────────────────────────────────────────────

  async collectSlow(): Promise<void> {
    await this.collectInterfaces();
    await this.collectIpAddressesCache();
    await this.collectVlans();
    await this.collectSystemInfo();
    await this.collectStp();
    if (this.device.device_type === 'wireless_ap') {
      await this.collectWirelessInterfaces();
      await this.collectSecurityProfiles();
    }
  }

  // ─── Log poll (every 60s) ─────────────────────────────────────────────────

  async collectLogs(): Promise<void> {
    await this.collectEvents();
  }

  // ─── Full initial collection ───────────────────────────────────────────────

  async collectAll(): Promise<void> {
    await this.collectSystemInfo();
    await this.collectInterfaces();
    await this.collectIpAddressesCache();
    await this.collectVlans();
    await this.collectInterfaceTraffic();
    await this.collectResourceUsage();
    await this.updateClients();
    await this.collectEvents();
    await this.collectNeighbors();
    await this.saveFullConfig();
    await this.updateDeviceStatus('online');
  }

  // ─── System Info ──────────────────────────────────────────────────────────

  async collectSystemInfo(): Promise<void> {
    try {
      const identity = await this.client.execute('/system/identity/print');
      const resource = await this.client.execute('/system/resource/print');
      const routerboard = await this.client.execute('/system/routerboard/print').catch(() => [] as Record<string, string>[]);

      const info = resource[0] || {};
      const rb = routerboard[0] || {};
      const identityName = identity[0]?.['name'] || this.device.name;

      const rosVersion = (info['version'] || '').split(' ')[0];
      const model = rb['model'] || info['board-name'] || null;
      const serial = rb['serial-number'] || null;
      const firmware = rb['current-firmware'] || rb['factory-firmware'] || null;

      await query(
        `UPDATE devices SET
          name = COALESCE($1, name),
          model = COALESCE($2, model),
          serial_number = COALESCE($3, serial_number),
          firmware_version = COALESCE($4, firmware_version),
          ros_version = COALESCE($5, ros_version),
          updated_at = NOW()
        WHERE id = $6`,
        [identityName, model, serial, firmware, rosVersion, this.device.id]
      );
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect system info:`, err);
    }
  }

  // ─── Interface Stats → InfluxDB ───────────────────────────────────────────

  async collectInterfaceTraffic(): Promise<void> {
    try {
      const stats = await this.client.execute('/interface/print', { stats: '' });
      const writeApi = getWriteApi();

      for (const iface of stats) {
        const name = iface['name'];
        if (!name) continue;

        const point = new Point('interface_traffic')
          .tag('device_id', String(this.device.id))
          .tag('device_name', this.device.name)
          .tag('interface', name)
          .intField('rx_bytes', parseInt(iface['rx-byte'] || '0', 10))
          .intField('tx_bytes', parseInt(iface['tx-byte'] || '0', 10))
          .intField('rx_packets', parseInt(iface['rx-packet'] || '0', 10))
          .intField('tx_packets', parseInt(iface['tx-packet'] || '0', 10))
          .intField('rx_errors', parseInt(iface['rx-error'] || '0', 10))
          .intField('tx_errors', parseInt(iface['tx-error'] || '0', 10))
          .booleanField('running', iface['running'] === 'true')
          .timestamp(new Date());

        writeApi.writePoint(point);
      }

      await writeApi.flush().catch((e) => console.error('InfluxDB flush error:', e));
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect interface traffic:`, err);
    }
  }

  // ─── Resource Usage → InfluxDB ────────────────────────────────────────────

  async collectResourceUsage(): Promise<void> {
    try {
      const res = await this.client.execute('/system/resource/print');
      const r = res[0];
      if (!r) return;

      const writeApi = getWriteApi();
      const point = new Point('device_resources')
        .tag('device_id', String(this.device.id))
        .tag('device_name', this.device.name)
        .floatField('cpu_load', parseFloat(r['cpu-load'] || '0'))
        .intField('memory_total', parseInt(r['total-memory'] || '0', 10))
        .intField(
          'memory_used',
          parseInt(r['total-memory'] || '0', 10) - parseInt(r['free-memory'] || '0', 10)
        )
        .intField('hdd_total', parseInt(r['total-hdd-space'] || '0', 10))
        .intField(
          'hdd_used',
          parseInt(r['total-hdd-space'] || '0', 10) -
            parseInt(r['free-hdd-space'] || '0', 10)
        )
        .intField('uptime_seconds', this.parseUptime(r['uptime'] || '0s'))
        .timestamp(new Date());

      writeApi.writePoint(point);
      await writeApi.flush().catch((e) => console.error('InfluxDB flush error:', e));
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect resources:`, err);
    }
  }

  private parseUptime(uptime: string): number {
    let seconds = 0;
    const weeks = uptime.match(/(\d+)w/);
    const days = uptime.match(/(\d+)d/);
    const hours = uptime.match(/(\d+)h/);
    const mins = uptime.match(/(\d+)m/);
    const secs = uptime.match(/(\d+)s/);
    if (weeks) seconds += parseInt(weeks[1]) * 604800;
    if (days) seconds += parseInt(days[1]) * 86400;
    if (hours) seconds += parseInt(hours[1]) * 3600;
    if (mins) seconds += parseInt(mins[1]) * 60;
    if (secs) seconds += parseInt(secs[1]);
    return seconds;
  }

  // ─── Interfaces → Postgres ────────────────────────────────────────────────

  async collectInterfaces(): Promise<void> {
    try {
      const [ifaces, bridges, bonds] = await Promise.all([
        this.client.execute('/interface/print', { detail: '' }),
        this.client.execute('/interface/bridge/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
        this.client.execute('/interface/bonding/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
      ]);

      const bridgeNames = new Set(bridges.map((b) => b['name']).filter(Boolean));
      const bondNames   = new Set(bonds.map((b) => b['name']).filter(Boolean));

      // Map bridge name → full bridge data (includes vlan-filtering, etc.)
      const bridgeDataMap = new Map<string, Record<string, string>>();
      for (const b of bridges) {
        if (b['name']) bridgeDataMap.set(b['name'], b);
      }

      const bridgesNotInIfaces = bridges.filter((b) => b['name'] && !ifaces.some((i) => i['name'] === b['name']));
      const bondsNotInIfaces   = bonds.filter((b) => b['name'] && !ifaces.some((i) => i['name'] === b['name']));
      const allIfaces = [...ifaces, ...bridgesNotInIfaces, ...bondsNotInIfaces];

      for (const iface of allIfaces) {
        const name = iface['name'];
        if (!name) continue;
        const rosType = iface['type'] || 'ether';
        const resolvedType = bridgeNames.has(name) ? 'bridge' : bondNames.has(name) ? 'bond' : rosType;

        // For bridge interfaces, merge bridge-specific properties (vlan-filtering, etc.)
        // /interface/print lacks bridge-only fields; /interface/bridge/print has them.
        const enrichedIface = resolvedType === 'bridge' && bridgeDataMap.has(name)
          ? { ...iface, ...bridgeDataMap.get(name)! }
          : iface;

        // RouterOS bridges may report mtu as 'auto' or '...' (inherited); use actual-mtu as fallback
        const rawMtu = parseInt(enrichedIface['actual-mtu'] || enrichedIface['mtu'] || '0', 10);
        const mtu = !isNaN(rawMtu) && rawMtu > 0 ? rawMtu : null;

        try {
          await query(
            `INSERT INTO interfaces (device_id, name, type, mac_address, mtu, running, disabled, comment, speed, config_json, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
             ON CONFLICT (device_id, name) DO UPDATE SET
               type=$3, mac_address=$4, mtu=$5, running=$6, disabled=$7, comment=$8, speed=$9, config_json=$10, updated_at=NOW()`,
            [
              this.device.id,
              name,
              resolvedType,
              enrichedIface['mac-address'] || null,
              mtu,
              enrichedIface['running'] === 'true',
              enrichedIface['disabled'] === 'true',
              enrichedIface['comment'] || null,
              enrichedIface['speed'] || null,
              JSON.stringify(enrichedIface),
            ]
          );
        } catch (insertErr) {
          console.error(`[${this.device.name}] Failed to insert interface ${name}:`, insertErr);
        }
      }
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect interfaces:`, err);
    }
  }

  /** Store /ip/address rows (sanitized) for topology matching of neighbor IPs. */
  async collectIpAddressesCache(): Promise<void> {
    try {
      const rows = await this.client
        .execute('/ip/address/print', { detail: '' })
        .catch(() => [] as Record<string, string>[]);
      const minimalist = rows
        .filter((r) => r['disabled'] !== 'true' && r['invalid'] !== 'true')
        .map((r) => ({
          address: (r['address'] || '').trim(),
          interface: (r['interface'] || '').trim(),
          dynamic: r['dynamic'] === 'true',
        }))
        .filter((x) => x.address.length > 0);
      await query(
        `UPDATE devices SET ip_addresses_jsonb = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(minimalist), this.device.id]
      );
    } catch (err) {
      console.error(`[${this.device.name}] Failed to cache IP addresses:`, err);
    }
  }

  // ─── VLANs → Postgres ────────────────────────────────────────────────────

  async collectVlans(): Promise<void> {
    try {
      // Bridge VLAN table (CRS switches / bridge-based switching)
      const bridgeVlans = await this.client
        .execute('/interface/bridge/vlan/print', { detail: '' })
        .catch(() => []);

      for (const vlan of bridgeVlans) {
        const vlanId = parseInt(vlan['vlan-ids'] || '0', 10);
        if (!vlanId) continue;

        await query(
          `INSERT INTO vlans (device_id, vlan_id, name, bridge, tagged_ports, untagged_ports, config_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (device_id, vlan_id) DO UPDATE SET
             name=$3, bridge=$4, tagged_ports=$5, untagged_ports=$6, config_json=$7`,
          [
            this.device.id,
            vlanId,
            vlan['comment'] || `VLAN ${vlanId}`,
            vlan['bridge'] || null,
            this.parseList(vlan['tagged']),
            this.parseList(vlan['untagged']),
            JSON.stringify(vlan),
          ]
        );
      }

      // Also collect bridge port PVIDs
      const bridgePorts = await this.client
        .execute('/interface/bridge/port/print', { detail: '' })
        .catch(() => []);

      for (const port of bridgePorts) {
        const pvid = parseInt(port['pvid'] || '1', 10);
        const bridge = port['bridge'] || '';
        const portName = port['interface'] || '';
        if (!portName || !bridge) continue;

        await query(
          `INSERT INTO bridge_vlan_entries (device_id, bridge, port, pvid, tagged, config_json, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (device_id, bridge, port) DO UPDATE SET
             pvid=$4, tagged=$5, config_json=$6, updated_at=NOW()`,
          [
            this.device.id,
            bridge,
            portName,
            pvid,
            false,
            JSON.stringify(port),
          ]
        );
      }
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect VLANs:`, err);
    }
  }

  private parseList(val: string | undefined): string[] {
    if (!val) return [];
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ─── Clients ──────────────────────────────────────────────────────────────

  async updateClients(): Promise<void> {
    try {
      await query(`UPDATE clients SET active = FALSE WHERE device_id = $1`, [this.device.id]);

      // Detect which wireless package is in use before the parallel fetch so we
      // query the correct registration table path (new wifi pkg vs legacy wireless pkg).
      const wifiPkg = await this.detectWifiPackage().catch(() => 'none' as const);
      const regTableCmd = wifiPkg === 'wifi'
        ? '/interface/wifi/registration-table/print'
        : '/interface/wireless/registration-table/print';

      // Collect all data sources in parallel.
      // Note: { detail: '' } is omitted — the RouterOS binary API always returns all fields,
      // and passing =detail= causes a silent !trap on some RouterOS builds.
      const [arpEntries, dhcpLeases, wirelessClients, bridgeHosts] = await Promise.all([
        this.client.execute('/ip/arp/print').catch(() => []),
        this.client.execute('/ip/dhcp-server/lease/print').catch(() => []),
        wifiPkg === 'none'
          ? Promise.resolve([] as Record<string, string>[])
          : this.client.execute(regTableCmd).catch(() => [] as Record<string, string>[]),
        this.client.execute('/interface/bridge/host/print').catch(() => []),
      ]);

      // DHCP hostname + IP lookup
      const dhcpHostnames: Record<string, string> = {};
      const dhcpIPs: Record<string, string> = {};
      for (const lease of dhcpLeases) {
        const mac = (lease['mac-address'] || '').toLowerCase();
        if (mac) {
          dhcpHostnames[mac] = lease['host-name'] || lease['comment'] || '';
          dhcpIPs[mac] = lease['address'] || '';
        }
      }

      // Wireless signal / traffic data
      // Field names differ between packages:
      //   legacy: signal-strength (e.g. "-65dBm"), bytes ("rx,tx" combined)
      //   new wifi pkg: signal (e.g. "-65"), tx-bytes / rx-bytes (separate fields)
      const wifiSignal: Record<string, number> = {};
      const wifiInterface: Record<string, string> = {};
      const wifiTx: Record<string, number> = {};
      const wifiRx: Record<string, number> = {};
      for (const wc of wirelessClients) {
        const mac = (wc['mac-address'] || '').toLowerCase();
        if (!mac) continue;
        // Signal strength — strip any trailing unit suffix (e.g. "dBm")
        const rawSignal = wc['signal-strength'] || wc['signal'] || '0';
        wifiSignal[mac] = parseInt(rawSignal, 10) || 0;
        wifiInterface[mac] = wc['interface'] || '';
        // Traffic counters — new wifi pkg has separate fields; legacy combines as "rx,tx"
        if (wc['tx-bytes'] !== undefined || wc['rx-bytes'] !== undefined) {
          wifiTx[mac] = parseInt(wc['tx-bytes'] || '0', 10) || 0;
          wifiRx[mac] = parseInt(wc['rx-bytes'] || '0', 10) || 0;
        } else {
          const parts = (wc['bytes'] || '0,0').split(',');
          wifiRx[mac] = parseInt(parts[0] || '0', 10) || 0;
          wifiTx[mac] = parseInt(parts[1] || '0', 10) || 0;
        }
      }

      // ARP table — IP enrichment and activity validation.
      // Only accept entries where ARP resolution succeeded (status != failed).
      // RouterOS v7 marks stale/unreachable entries with status=failed.
      const arpIPs: Record<string, string> = {};
      const arpInterfaces: Record<string, string> = {};
      const arpFailed = new Set<string>(); // MACs confirmed offline by this device's ARP
      for (const arp of arpEntries) {
        const mac = (arp['mac-address'] || '').toLowerCase();
        if (!mac) continue;
        if (arp['incomplete'] === 'true') continue;
        if (arp['BCAST'] === 'true') continue;
        if (arp['status'] === 'failed') { arpFailed.add(mac); continue; }
        arpIPs[mac] = arp['address'] || '';
        arpInterfaces[mac] = arp['interface'] || '';
      }


      // Bridge host table — primary client source for switched/bridged devices.
      // RouterOS includes an 'age' field (seconds since last frame seen).
      // On software bridges (CCR, CHR) the table ages out at ~300s, so anything
      // present is genuinely recent. On hardware CRS switches the ASIC may hold
      // entries for hours after a host goes offline.
      // Strategy:
      //   - Skip static/local entries
      //   - Skip any entry where age > 600s AND the device's own ARP marks it failed
      //     (belt-and-suspenders for CRS hardware whose FDB doesn't self-age)
      //   - Keep all others (missing age field = software bridge, treat as fresh)
      const MAX_BRIDGE_AGE_S = 600;
      const bridgeHostMap: Record<string, { port: string; vid: number | null }> = {};
      for (const host of bridgeHosts) {
        if (host['local'] === 'true') continue;
        if (host['dynamic'] === 'false') continue;
        const mac = (host['mac-address'] || '').toLowerCase();
        if (!mac) continue;
        const age = host['age'] ? parseInt(host['age'], 10) : 0;
        // Exclude stale hardware-FDB entries: old AND ARP-confirmed offline
        if (age > MAX_BRIDGE_AGE_S && arpFailed.has(mac)) continue;
        bridgeHostMap[mac] = {
          port: host['on-interface'] || host['interface'] || '',
          vid: host['vid'] ? parseInt(host['vid'], 10) : null,
        };
      }

      const allMacs = new Set<string>([
        ...Object.keys(wifiSignal),
        ...Object.keys(arpIPs),
        ...Object.keys(bridgeHostMap),
      ]);

      let totalClients = 0;
      for (const mac of allMacs) {
        if (!mac) continue;
        const isWireless = mac in wifiSignal;
        const entry = bridgeHostMap[mac];
        const interfaceName = isWireless
          ? (wifiInterface[mac] || entry?.port || null)
          : (entry?.port || arpInterfaces[mac] || null);
        const vlanId = entry?.vid ?? null;

        await query(
          `INSERT INTO clients (device_id, mac_address, hostname, ip_address, interface_name, vlan_id, tx_bytes, rx_bytes, signal_strength, client_type, active, last_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,NOW())
           ON CONFLICT (device_id, mac_address) DO UPDATE SET
             hostname=COALESCE($3, clients.hostname),
             ip_address=COALESCE(NULLIF($4,''), clients.ip_address),
             interface_name=COALESCE($5, clients.interface_name),
             vlan_id=COALESCE($6, clients.vlan_id),
             tx_bytes=$7,
             rx_bytes=$8,
             signal_strength=$9,
             client_type=$10,
             active=TRUE,
             last_seen=NOW()`,
          [
            this.device.id,
            mac,
            dhcpHostnames[mac] || null,
            dhcpIPs[mac] || arpIPs[mac] || null,
            interfaceName,
            vlanId,
            wifiTx[mac] || 0,
            wifiRx[mac] || 0,
            isWireless ? wifiSignal[mac] : null,
            isWireless ? 'wireless' : 'wired',
          ]
        );
        totalClients++;
      }

      // OUI vendor lookup: fill in up to 10 clients that are missing vendor per cycle
      await this.lookupMissingVendors();

      // Write per-client presence points so the detail page can show a timeline
      const writeApi = getWriteApi();
      for (const mac of allMacs) {
        if (!mac) continue;
        const presencePoint = new Point('client_presence')
          .tag('mac_address', mac)
          .tag('device_id', String(this.device.id))
          .intField('online', 1);
        if (mac in wifiSignal) {
          presencePoint.intField('signal_strength', wifiSignal[mac]);
          presencePoint.intField('tx_bytes', wifiTx[mac] ?? 0);
          presencePoint.intField('rx_bytes', wifiRx[mac] ?? 0);
        }
        presencePoint.timestamp(new Date());
        writeApi.writePoint(presencePoint);
      }

      // Write per-device metric (for per-device breakdowns)
      const point = new Point('client_counts')
        .tag('device_id', String(this.device.id))
        .tag('device_name', this.device.name)
        .intField('total_clients', totalClients)
        .intField('wireless_clients', Object.keys(wifiSignal).length)
        .intField('wired_clients', Math.max(0, totalClients - Object.keys(wifiSignal).length))
        .timestamp(new Date());
      writeApi.writePoint(point);

      // Write a global deduplicated metric so the dashboard graph shows the true
      // unique client count across all devices (not a per-device sum that double-counts
      // clients visible from multiple devices simultaneously).
      const dedupedRows = await query<{ count: string }>(
        `SELECT COUNT(DISTINCT mac_address) AS count FROM clients WHERE active = TRUE`
      );
      const globalTotal = parseInt(dedupedRows[0]?.count || '0', 10);
      const globalPoint = new Point('client_counts')
        .tag('device_id', '_global')
        .tag('device_name', '_global')
        .intField('total_clients', globalTotal)
        .timestamp(new Date());
      writeApi.writePoint(globalPoint);

      await writeApi.flush().catch(() => {});
    } catch (err) {
      console.error(`[${this.device.name}] Failed to update clients:`, err);
    }
  }

  private async lookupMissingVendors(): Promise<void> {
    try {
      // Include vendor='' entries: those were set by the old API-based lookup
      // when it was rate-limited and never actually resolved.
      const rows = await query<{ mac_address: string }>(
        `SELECT mac_address FROM clients
         WHERE device_id = $1 AND (vendor IS NULL OR vendor = '') AND active = TRUE`,
        [this.device.id]
      );
      for (const row of rows) {
        const vendor = lookupVendor(row.mac_address);
        // Always write the result (even empty) so it's consistent across all
        // device rows for the same MAC.
        await query(
          `UPDATE clients SET vendor = $1 WHERE device_id = $2 AND mac_address = $3`,
          [vendor, this.device.id, row.mac_address]
        );
      }
    } catch {
      // Non-critical; ignore vendor lookup failures
    }
  }

  // ─── Events/Logs ─────────────────────────────────────────────────────────

  async collectEvents(): Promise<void> {
    try {
      const logs = await this.client.execute('/log/print');
      if (!logs.length) return;

      // RouterOS log .id values are hex strings like "*1A2F". Parse to int for comparison.
      const parseRosId = (id: string): number => {
        const hex = (id || '').replace(/^\*/, '');
        return hex ? parseInt(hex, 16) : 0;
      };

      // Find the highest RouterOS log ID we've already stored for this device.
      const lastRow = await queryOne<{ log_id: string }>(
        `SELECT log_id FROM events WHERE device_id = $1 AND log_id IS NOT NULL AND log_id != ''
         ORDER BY id DESC LIMIT 1`,
        [this.device.id]
      );
      const lastIdNum = parseRosId(lastRow?.log_id || '');

      // Always get the latest stored event time — needed for timestamp fallback.
      const latestStored = await queryOne<{ event_time: Date }>(
        `SELECT event_time FROM events WHERE device_id = $1 ORDER BY event_time DESC LIMIT 1`,
        [this.device.id]
      );
      const latestTime = latestStored?.event_time ? new Date(latestStored.event_time) : new Date(0);

      // Detect log buffer overflow or device reboot: if all current IDs are below
      // our stored lastIdNum, RouterOS has cleared/reset its log buffer.
      // In that case, fall back to timestamp-based deduplication to avoid missing events.
      const currentIds = logs.map(l => parseRosId(l['.id'] || '')).filter(id => id > 0);
      const maxCurrentId = currentIds.length > 0 ? Math.max(...currentIds) : 0;
      const logReset = lastRow && maxCurrentId > 0 && maxCurrentId < lastIdNum;

      let newCount = 0;
      for (const log of logs) {
        const logId = (log['.id'] || '') as string;
        const logIdNum = parseRosId(logId);

        if (logId && !logReset) {
          // Primary: skip entries already stored by RouterOS ID
          if (logIdNum <= lastIdNum) continue;
        } else {
          // Fallback: no .id field, or log buffer has been reset — use timestamp deduplication
          const time = this.parseLogTime(log['time'] || '');
          if (time <= latestTime) continue;
        }

        const time = this.parseLogTime(log['time'] || '');
        const severity = this.mapLogSeverity(log['topics'] || '');

        await query(
          `INSERT INTO events (device_id, event_time, severity, topic, message, raw_json, log_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (device_id, log_id) DO NOTHING`,
          [
            this.device.id,
            time.toISOString(),
            severity,
            log['topics'] || null,
            log['message'] || '',
            JSON.stringify(log),
            logId || null,
          ]
        );
        newCount++;
      }

      if (newCount > 0) {
        await query(
          `DELETE FROM events WHERE device_id = $1 AND event_time < NOW() - INTERVAL '30 days'`,
          [this.device.id]
        );
        console.log(`[${this.device.name}] Collected ${newCount} new log entries`);
      }
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect events:`, err);
    }
  }

  private parseLogTime(timeStr: string): Date {
    // RouterOS log time formats:
    //   "jan/01 00:00:05"       — month/day only (no year) → default to current year
    //   "jan/01/2024 00:00:05"  — full date with year
    //   "00:00:05"              — time only (today, e.g. device uptime < 1 day)
    if (!timeStr) return new Date();
    try {
      if (timeStr.includes('/')) {
        const spaceIdx = timeStr.lastIndexOf(' ');
        if (spaceIdx === -1) return new Date();
        const datePart = timeStr.substring(0, spaceIdx);
        const timePart = timeStr.substring(spaceIdx + 1);
        const parts = datePart.split('/');
        const monthStr = parts[0];
        const day = parts[1];
        if (!monthStr || !day) return new Date();
        const year = parts[2] !== undefined ? parts[2] : String(new Date().getFullYear());
        const months: Record<string, string> = {
          jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
          jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
        };
        const month = months[monthStr.toLowerCase()] || '01';
        const d = new Date(`${year}-${month}-${day.padStart(2, '0')}T${timePart}Z`);
        if (isNaN(d.getTime())) return new Date();
        return d;
      } else {
        // Time only (today)
        const today = new Date().toISOString().split('T')[0];
        const d = new Date(`${today}T${timeStr}Z`);
        if (isNaN(d.getTime())) return new Date();
        return d;
      }
    } catch {
      return new Date();
    }
  }

  private mapLogSeverity(topics: string): string {
    if (topics.includes('critical') || topics.includes('error')) return 'error';
    if (topics.includes('warning')) return 'warning';
    if (topics.includes('info')) return 'info';
    return 'info';
  }

  // ─── MAC Scan (switch IP enrichment) ─────────────────────────────────────

  async runMacScan(): Promise<void> {
    if (this.device.device_type !== 'switch') return;
    try {
      const bridges = await this.client
        .execute('/interface/bridge/print', { detail: '' })
        .catch(() => [] as Record<string, string>[]);

      const bridgeNames = bridges.map((b) => b['name']).filter(Boolean);
      if (bridgeNames.length === 0) return;

      const macIpMap: Record<string, string> = {};

      // Scan each bridge for 5 seconds; executeStreaming handles the !done or
      // cuts off at 8 s so we don't stall the poller indefinitely
      for (const iface of bridgeNames) {
        const results = await this.client
          .executeStreaming('/tool/mac-scan', { interface: iface, duration: '5' }, 8_000)
          .catch(() => [] as Record<string, string>[]);

        for (const entry of results) {
          const mac = (entry['mac-address'] || '').toLowerCase();
          const ip  = entry['address'] || '';
          if (mac && ip) macIpMap[mac] = ip;
        }
      }

      if (Object.keys(macIpMap).length === 0) return;

      // Enrich client records across all devices: fill in missing IPs only,
      // so DHCP-assigned addresses that already exist are not overwritten.
      for (const [mac, ip] of Object.entries(macIpMap)) {
        await query(
          `UPDATE clients SET ip_address = $1
           WHERE mac_address = $2
             AND (ip_address IS NULL OR ip_address = '')`,
          [ip, mac]
        );
      }

      console.log(`[${this.device.name}] MAC scan found ${Object.keys(macIpMap).length} MAC/IP pair(s)`);
    } catch (err) {
      console.error(`[${this.device.name}] MAC scan failed:`, err);
    }
  }

  // ─── Neighbor Discovery (for topology) ───────────────────────────────────

  async collectNeighbors(): Promise<void> {
    try {
      const [neighbors, arpEntries, dhcpLeases, serverArpMap] = await Promise.all([
        this.client.execute('/ip/neighbor/print').catch(() => []),
        this.client.execute('/ip/arp/print').catch(() => []),
        this.client.execute('/ip/dhcp-server/lease/print').catch(() => []),
        buildServerArpMap(),
      ]);

      // Build MAC → IPv4 lookup from ARP and DHCP as fallback for neighbors
      // whose MNDP advertisement only contains an IPv6 address.
      const macToIpv4: Record<string, string> = {};
      for (const arp of arpEntries) {
        const mac = (arp['mac-address'] || '').toLowerCase().trim();
        const ip = (arp['address'] || '').trim();
        if (!mac || !ip || ip.includes(':')) continue;
        if (arp['complete'] === 'false' || arp['status'] === 'failed') continue;
        macToIpv4[mac] = ip;
      }
      for (const lease of dhcpLeases) {
        const mac = (lease['mac-address'] || '').toLowerCase().trim();
        const ip = (lease['address'] || '').trim();
        if (mac && ip && !ip.includes(':') && !macToIpv4[mac]) macToIpv4[mac] = ip;
      }

      // Wipe existing rows for this device so removed neighbors don't linger
      await query(`DELETE FROM topology_links WHERE from_device_id = $1`, [this.device.id]);

      for (const nb of neighbors) {
        // RouterOS returns comma-separated interface names like "ether1,bridge1" — the
        // first entry is always the physical port; the rest are the bridge/bond parents.
        // Store only the physical port so topology edges show the actual cable endpoint.
        const rawInterface = nb['interface'] || '';
        const fromInterface = (rawInterface.split(',')[0].trim() || rawInterface);

        // interface-name is the neighbor's own outgoing interface (format: bridge/port or just port)
        const toInterfaceRaw = (nb['interface-name'] || '').trim() || null;
        const toInterface = toInterfaceRaw || null;

        // discovered-by lists protocols that found this neighbor: lldp, cdp, mndp, etc.
        // Rank them by reliability: lldp (point-to-point) > cdp (also flooded in ROS but
        // implies same segment) > mndp (MikroTik broadcast, can span entire bridge domain).
        const discoveredByRaw = (nb['discovered-by'] || '').toLowerCase();
        let discoveredBy: string;
        if (discoveredByRaw.includes('lldp'))      discoveredBy = 'lldp';
        else if (discoveredByRaw.includes('cdp'))  discoveredBy = 'cdp';
        else if (discoveredByRaw.includes('mndp')) discoveredBy = 'mndp';
        else                                        discoveredBy = discoveredByRaw || 'mndp';
        // Store the full RouterOS list in discovered_by (column is VARCHAR(512)); the raw
        // string can be a long comma-separated list and used to exceed VARCHAR(50).
        const discoveredByStored = discoveredByRaw || null;

        // RouterOS v7+ may put an IPv6 link-local in 'address'. Try all known
        // IPv4 field names, split on whitespace/commas in case multiple are packed
        // into one field, and take the first value that looks like IPv4.
        const mac = (nb['mac-address'] || '').toLowerCase().trim();
        const ipv4FromNeighbor = [
          nb['ipv4-address'],
          nb['ip-address'],
          nb['address'],
        ]
          .flatMap((f) => (f || '').split(/[\s,]+/))
          .map((s) => s.trim())
          .find((s) => s && !s.includes(':')) ?? null;

        const neighborAddress = ipv4FromNeighbor
          || (mac ? macToIpv4[mac] ?? null : null)
          || (mac ? serverArpMap[mac] ?? null : null);
        const neighborIdentity = (nb['identity'] || '');
        const neighborPlatform = (nb['platform'] || '');
        const neighborMac = nb['mac-address'] ? String(nb['mac-address']) : null;
        const neighborCaps = (nb['system-caps-enabled'] || nb['system-caps'] || '');

        if (!fromInterface) continue;

        const oversize: { field: keyof typeof TOPOLOGY_LINK_LIMITS; limit: number; len: number }[] = [];
        const check = (field: keyof typeof TOPOLOGY_LINK_LIMITS, val: string | null | undefined) => {
          const o = topologyNeighborOversized(field, val);
          if (o) oversize.push({ field, ...o });
        };
        check('from_interface', fromInterface);
        check('to_interface', toInterface);
        check('neighbor_address', neighborAddress ? String(neighborAddress) : null);
        check('neighbor_identity', neighborIdentity || null);
        check('neighbor_platform', neighborPlatform || null);
        check('neighbor_mac', neighborMac);
        check('neighbor_caps', neighborCaps || null);
        check('discovered_by', discoveredByStored);

        if (oversize.length > 0) {
          console.warn(
            `[${this.device.name}] Skipping topology neighbor row: value(s) exceed DB column limits ` +
              `(no silent truncation). Details: ${JSON.stringify(oversize)}`
          );
          continue;
        }

        await query(
          `INSERT INTO topology_links
             (from_device_id, from_interface, to_interface, neighbor_address, neighbor_identity,
              neighbor_platform, neighbor_mac, neighbor_caps, link_type, discovered_by, discovered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
          [
            this.device.id,
            fromInterface,
            toInterface,
            neighborAddress ? String(neighborAddress) : null,
            neighborIdentity,
            neighborPlatform,
            neighborMac,
            neighborCaps || null,
            discoveredBy,
            discoveredByStored,
          ]
        );
      }

      // Try to resolve neighbor_address to a known device
      await query(
        `UPDATE topology_links tl
         SET to_device_id = d.id
         FROM devices d
         WHERE tl.from_device_id = $1
           AND d.ip_address = tl.neighbor_address
           AND tl.to_device_id IS DISTINCT FROM d.id`,
        [this.device.id]
      );
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect neighbors:`, err);
    }
  }

  async collectStp(): Promise<void> {
    try {
      const bridgePorts = await this.client
        .execute('/interface/bridge/port/print', { detail: '' })
        .catch(() => []);

      for (const port of bridgePorts) {
        const iface = (port['interface'] as string) || '';
        const role = (port['role'] as string) || '';
        const bridgeName = (port['bridge'] as string) || '';
        // Derive state from role — alternate/backup are blocking, root/designated are forwarding
        const state = (role === 'alternate' || role === 'backup') ? 'blocking' : 'forwarding';

        if (!iface) continue;

        await query(
          `UPDATE topology_links
           SET stp_role=$3, stp_state=$4, bridge_name=$5
           WHERE from_device_id=$1 AND from_interface=$2`,
          [this.device.id, iface, role || null, state, bridgeName || null]
        );
      }
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect STP:`, err);
    }
  }

  // ─── LLDP Management ──────────────────────────────────────────────────────

  async getLldpEnabled(): Promise<{ enabled: boolean; protocol: string }> {
    try {
      const result = await this.client
        .execute('/ip/neighbor/discovery-settings/print')
        .catch(() => [] as Record<string, string>[]);
      const settings = result[0] as Record<string, string> | undefined;
      const protocol = settings?.['protocol'] ?? '';
      if (!protocol) return { enabled: true, protocol: 'unknown' };
      const enabled = protocol.toLowerCase().includes('lldp');
      return { enabled, protocol };
    } catch {
      return { enabled: true, protocol: 'unknown' };
    }
  }

  async setLldpEnabled(enabled: boolean): Promise<void> {
    const current = await this.getLldpEnabled();
    const currentProtocol = current.protocol === 'unknown' ? 'cdp,lldp,mndp' : current.protocol;
    let protocols = currentProtocol
      .split(',')
      .map((p: string) => p.trim())
      .filter((p: string) => p && p.toLowerCase() !== 'lldp');
    if (enabled) protocols = [...protocols, 'lldp'];
    const newProtocol = protocols.join(',') || 'mndp';
    await this.client.execute('/ip/neighbor/discovery-settings/set', { protocol: newProtocol });
  }

  // ─── SNMP Management ──────────────────────────────────────────────────────

  async getSnmpConfig(): Promise<{
    enabled: boolean; contact: string; location: string; trap_target: string;
    community_name: string; version: 'v1' | 'v2c' | 'v3';
    auth_protocol: string; priv_protocol: string;
  }> {
    try {
      const [globals, communities] = await Promise.all([
        this.client.execute('/snmp/print').catch(() => [] as Record<string, string>[]),
        this.client.execute('/snmp/community/print').catch(() => [] as Record<string, string>[]),
      ]);
      const g = (globals as Record<string, string>[])[0] ?? {};
      const enabled  = g['enabled'] !== 'false' && g['enabled'] !== 'no';
      const contact  = g['contact']  ?? '';
      const location = g['location'] ?? '';
      const trap_target = g['trap-target'] ?? '';
      const trapVersion = g['trap-version'] ?? '2';

      // Pick first non-"public" community, fall back to first
      const comm = ((communities as Record<string, string>[]).find(c => c['name'] !== 'public')
        ?? (communities as Record<string, string>[])[0]) ?? {};
      const community_name    = comm['name'] ?? 'public';
      const security          = comm['security'] ?? 'none';
      const auth_protocol     = comm['authentication-protocol'] ?? 'MD5';
      const priv_protocol     = comm['encryption-protocol'] ?? 'none';

      let version: 'v1' | 'v2c' | 'v3';
      if (security === 'authorized' || security === 'private') {
        version = 'v3';
      } else {
        version = trapVersion === '1' ? 'v1' : 'v2c';
      }

      return { enabled, contact, location, trap_target, community_name, version, auth_protocol, priv_protocol };
    } catch {
      return { enabled: false, contact: '', location: '', trap_target: '', community_name: 'public', version: 'v2c', auth_protocol: 'MD5', priv_protocol: 'none' };
    }
  }

  async setSnmpConfig(config: {
    enabled: boolean; contact?: string; location?: string; trap_target?: string;
    community_name: string; version: 'v1' | 'v2c' | 'v3';
    auth_protocol?: string; auth_password?: string;
    priv_protocol?: string; priv_password?: string;
  }): Promise<void> {
    // 1. Global settings
    const globalParams: Record<string, string> = { enabled: config.enabled ? 'yes' : 'no' };
    if (config.contact  !== undefined) globalParams['contact']      = config.contact;
    if (config.location !== undefined) globalParams['location']     = config.location;
    if (config.trap_target !== undefined) globalParams['trap-target'] = config.trap_target;
    globalParams['trap-version'] = config.version === 'v1' ? '1' : config.version === 'v3' ? '3' : '2';
    await this.client.execute('/snmp/set', globalParams);

    // 2. Community security level
    let security = 'none';
    if (config.version === 'v3') {
      const hasPriv = config.priv_protocol && config.priv_protocol !== 'none' && config.priv_password;
      security = hasPriv ? 'private' : 'authorized';
    }

    const communityParams: Record<string, string> = { name: config.community_name, security };
    if (config.version === 'v3') {
      if (config.auth_protocol && config.auth_protocol !== 'none') {
        communityParams['authentication-protocol'] = config.auth_protocol;
        if (config.auth_password) communityParams['authentication-password'] = config.auth_password;
      }
      if (config.priv_protocol && config.priv_protocol !== 'none') {
        communityParams['encryption-protocol'] = config.priv_protocol;
        if (config.priv_password) communityParams['encryption-password'] = config.priv_password;
      }
    }

    // Find existing community by name or fall back to first
    const communities = await this.client.execute('/snmp/community/print').catch(() => [] as Record<string, string>[]);
    const existing = (communities as Record<string, string>[]).find(c => c['name'] === config.community_name)
      ?? (communities as Record<string, string>[])[0];

    if (existing?.['.id']) {
      await this.client.execute('/snmp/community/set', { '.id': existing['.id'], ...communityParams });
    } else {
      await this.client.execute('/snmp/community/add', communityParams);
    }
  }

  // ─── Full config snapshot ─────────────────────────────────────────────────

  async saveFullConfig(): Promise<void> {
    try {
      const [interfaces, vlans, routes, firewall, dhcp, dns] = await Promise.all([
        this.client.execute('/interface/print', { detail: '' }).catch(() => []),
        this.client.execute('/interface/bridge/vlan/print', { detail: '' }).catch(() => []),
        this.client.execute('/ip/route/print', { detail: '' }).catch(() => []),
        this.client.execute('/ip/firewall/filter/print', { detail: '' }).catch(() => []),
        this.client.execute('/ip/dhcp-server/print', { detail: '' }).catch(() => []),
        this.client.execute('/ip/dns/print', { detail: '' }).catch(() => []),
      ]);

      const config = { interfaces, vlans, routes, firewall, dhcp, dns };

      await query(
        `INSERT INTO device_configs (device_id, config_json) VALUES ($1, $2)`,
        [this.device.id, JSON.stringify(config)]
      );

      // Keep only last 10 full config snapshots per device
      await query(
        `DELETE FROM device_configs WHERE device_id = $1 AND id NOT IN (
           SELECT id FROM device_configs WHERE device_id = $1 ORDER BY collected_at DESC LIMIT 10
         )`,
        [this.device.id]
      );
    } catch (err) {
      console.error(`[${this.device.name}] Failed to save config:`, err);
    }
  }

  async updateDeviceStatus(status: string): Promise<void> {
    await query(
      `UPDATE devices SET status = $1, last_seen = NOW(), updated_at = NOW() WHERE id = $2`,
      [status, this.device.id]
    );
  }

  // ─── Wifi package detection ───────────────────────────────────────────────

  private wifiPackageCache: 'wifi' | 'wireless' | 'none' | null = null;

  async detectWifiPackage(): Promise<'wifi' | 'wireless' | 'none'> {
    if (this.wifiPackageCache !== null) return this.wifiPackageCache;
    // Try RouterOS 7 "wifi" package first (Wi-Fi 6/7 hardware — wlan names are wifi1, wifi2)
    try {
      await this.client.execute('/interface/wifi/print');
      this.wifiPackageCache = 'wifi';
      return 'wifi';
    } catch { /* fall through */ }
    // Try legacy "wireless" package (RouterOS 6.x / older 7.x hardware)
    try {
      await this.client.execute('/interface/wireless/print');
      this.wifiPackageCache = 'wireless';
      return 'wireless';
    } catch { /* fall through */ }
    this.wifiPackageCache = 'none';
    return 'none';
  }

  // Normalize RouterOS 7 wifi package dot-notation fields to flat keys
  private normalizeWifiInterface(raw: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...raw };
    if (raw['configuration.ssid']               !== undefined) out['ssid']                  = raw['configuration.ssid'];
    if (raw['configuration.mode']               !== undefined) out['mode']                  = raw['configuration.mode'];
    if (raw['channel.band']                     !== undefined) out['band']                  = raw['channel.band'];
    if (raw['channel.frequency']                !== undefined) out['frequency']             = raw['channel.frequency'];
    if (raw['channel.width']                    !== undefined) out['channel-width']         = raw['channel.width'];
    if (raw['security.authentication-types']    !== undefined) out['authentication-types']  = raw['security.authentication-types'];
    if (raw['security.passphrase']              !== undefined) out['passphrase']            = raw['security.passphrase'];
    if (raw['security.encryption']              !== undefined) out['encryption']            = raw['security.encryption'];
    // "inactive" field: true = radio is NOT running
    if (raw['inactive'] !== undefined && out['running'] === undefined) {
      out['running'] = raw['inactive'] === 'false' ? 'true' : 'false';
    }
    return out;
  }

  // ─── Wireless Interfaces → Postgres ───────────────────────────────────────

  async collectWirelessInterfaces(): Promise<void> {
    try {
      const pkg = await this.detectWifiPackage();
      if (pkg === 'none') return;

      const rawList = pkg === 'wifi'
        ? await this.client.execute('/interface/wifi/print').catch(() => [] as Record<string, string>[])
        : await this.client.execute('/interface/wireless/print', { detail: '' }).catch(() => [] as Record<string, string>[]);

      const wlans = pkg === 'wifi' ? rawList.map(r => this.normalizeWifiInterface(r)) : rawList;
      if (wlans.length === 0) return;

      for (const wlan of wlans) {
        const name = wlan['name'];
        if (!name) continue;
        const freq  = parseInt(wlan['frequency'] || '0', 10);
        const txPow = parseInt(wlan['tx-power'] || '0', 10);
        const gain  = parseInt(wlan['antenna-gain'] || '0', 10);

        await query(
          `INSERT INTO wireless_interfaces
            (device_id, name, ssid, mode, band, frequency, channel_width, tx_power,
             tx_power_mode, antenna_gain, country, installation, disabled, running,
             mac_address, security_profile, config_json, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (device_id, name) DO UPDATE SET
             ssid=$3, mode=$4, band=$5, frequency=$6, channel_width=$7, tx_power=$8,
             tx_power_mode=$9, antenna_gain=$10, country=$11, installation=$12,
             disabled=$13, running=$14, mac_address=$15, security_profile=$16,
             config_json=$17, updated_at=NOW()`,
          [
            this.device.id, name,
            wlan['ssid'] || null,
            wlan['mode'] || null,
            wlan['band'] || null,
            !isNaN(freq) && freq > 0 ? freq : null,
            wlan['channel-width'] || null,
            !isNaN(txPow) && txPow > 0 ? txPow : null,
            wlan['tx-power-mode'] || null,
            !isNaN(gain) ? gain : null,
            wlan['country'] || null,
            wlan['installation'] || 'indoor',
            wlan['disabled'] === 'true',
            wlan['running'] === 'true',
            wlan['mac-address'] || null,
            wlan['security-profile'] || null,
            JSON.stringify(wlan),
          ]
        );
      }
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect wireless interfaces:`, err);
    }
  }

  // ─── Wireless Stats → InfluxDB ────────────────────────────────────────────

  async collectWirelessStats(): Promise<void> {
    try {
      const pkg = await this.detectWifiPackage();
      if (pkg === 'none') return;

      const [rawList, regTable] = await Promise.all([
        pkg === 'wifi'
          ? this.client.execute('/interface/wifi/print').catch(() => [] as Record<string, string>[])
          : this.client.execute('/interface/wireless/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
        pkg === 'wifi'
          ? this.client.execute('/interface/wifi/registration-table/print').catch(() => [] as Record<string, string>[])
          : this.client.execute('/interface/wireless/registration-table/print').catch(() => [] as Record<string, string>[]),
      ]);

      const wlans = pkg === 'wifi' ? rawList.map(r => this.normalizeWifiInterface(r)) : rawList;
      if (wlans.length === 0) return;

      const clientsByIface: Record<string, number> = {};
      for (const r of regTable) {
        const iface = r['interface'];
        if (iface) clientsByIface[iface] = (clientsByIface[iface] || 0) + 1;
      }

      const writeApi = getWriteApi();
      for (const wlan of wlans) {
        const name = wlan['name'];
        if (!name || wlan['disabled'] === 'true') continue;
        const clientCount = clientsByIface[name] || 0;
        const noiseFloor  = parseInt(wlan['noise-floor'] || '0', 10);

        const point = new Point('wireless_stats')
          .tag('device_id', String(this.device.id))
          .tag('device_name', this.device.name)
          .tag('interface', name)
          .tag('ssid', wlan['ssid'] || name)
          .intField('registered_clients', clientCount)
          .timestamp(new Date());

        if (!isNaN(noiseFloor) && noiseFloor !== 0) {
          point.intField('noise_floor', noiseFloor);
        }
        writeApi.writePoint(point);

        await query(
          `UPDATE wireless_interfaces SET registered_clients=$1, updated_at=NOW()
           WHERE device_id=$2 AND name=$3`,
          [clientCount, this.device.id, name]
        );
      }
      await writeApi.flush().catch((e) => console.error('InfluxDB flush error:', e));
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect wireless stats:`, err);
    }
  }

  // ─── Security Profiles → Postgres ─────────────────────────────────────────

  async collectSecurityProfiles(): Promise<void> {
    try {
      const pkg = await this.detectWifiPackage();
      if (pkg === 'none') return;

      if (pkg === 'wifi') {
        // Try named /interface/wifi/security profiles first.
        // Fall back to synthesizing from interface inline security.* fields if none exist.
        const named = await this.client.execute('/interface/wifi/security/print').catch(() => [] as Record<string, string>[]);
        const sourceList: Array<{ name: string; raw: Record<string, string> }> = named.length > 0
          ? named.map(p => ({ name: p['name'], raw: p }))
          : (await this.client.execute('/interface/wifi/print').catch(() => [] as Record<string, string>[]))
              .filter(r => r['security.authentication-types'] || r['security.passphrase'])
              .map(r => ({
                name: r['name'],
                raw: {
                  'authentication-types': r['security.authentication-types'] || '',
                  passphrase:             r['security.passphrase'] || '',
                  encryption:             r['security.encryption'] || '',
                },
              }));

        for (const { name, raw } of sourceList) {
          if (!name) continue;
          const authTypes = (raw['authentication-types'] || '').split(',').filter(Boolean);
          await query(
            `INSERT INTO wireless_security_profiles
              (device_id, name, mode, authentication_types, unicast_ciphers, group_ciphers,
               management_protection, config_json, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
             ON CONFLICT (device_id, name) DO UPDATE SET
               mode=$3, authentication_types=$4, unicast_ciphers=$5, group_ciphers=$6,
               management_protection=$7, config_json=$8, updated_at=NOW()`,
            [
              this.device.id, name,
              'dynamic-keys', authTypes, [], [], 'disabled',
              JSON.stringify(raw),
            ]
          );
        }
        return;
      }

      // Legacy wireless package
      const profiles = await this.client
        .execute('/interface/wireless/security-profiles/print')
        .catch(() => [] as Record<string, string>[]);

      for (const p of profiles) {
        const name = p['name'];
        if (!name) continue;
        const authTypes      = (p['authentication-types'] || '').split(',').filter(Boolean);
        const unicastCiphers = (p['unicast-ciphers'] || '').split(',').filter(Boolean);
        const groupCiphers   = (p['group-ciphers'] || '').split(',').filter(Boolean);

        await query(
          `INSERT INTO wireless_security_profiles
            (device_id, name, mode, authentication_types, unicast_ciphers, group_ciphers,
             management_protection, config_json, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (device_id, name) DO UPDATE SET
             mode=$3, authentication_types=$4, unicast_ciphers=$5, group_ciphers=$6,
             management_protection=$7, config_json=$8, updated_at=NOW()`,
          [
            this.device.id, name,
            p['mode'] || 'none',
            authTypes, unicastCiphers, groupCiphers,
            p['management-protection'] || 'disabled',
            JSON.stringify(p),
          ]
        );
      }
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect security profiles:`, err);
    }
  }

  // ─── Wireless live-query helpers (for routes) ──────────────────────────────

  // Field map for translating old wireless-style flat keys → new wifi dot-notation
  private static readonly WIFI_FIELD_MAP: Record<string, string> = {
    'ssid':                   'configuration.ssid',
    'mode':                   'configuration.mode',
    'band':                   'channel.band',
    'frequency':              'channel.frequency',
    'channel-width':          'channel.width',
    'passphrase':             'security.passphrase',
    'wpa2-pre-shared-key':    'security.passphrase',
    'authentication-types':   'security.authentication-types',
    'encryption':             'security.encryption',
    'security-profile':       'security',   // old pkg "security-profile" → new pkg "security"
    'disabled':               'disabled',
    'master-interface':       'master-interface',
    'name':                   'name',
  };

  // Params valid only in the legacy wireless package — silently dropped for new wifi package
  private static readonly WIFI_UNSUPPORTED_PARAMS = new Set([
    'tx-power-mode', 'tx-power', 'antenna-gain',
    'country', 'installation',
    'wpa-pre-shared-key', 'unicast-ciphers', 'group-ciphers', 'management-protection',
  ]);

  private translateToWifiParams(params: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    // Virtual APs (master-interface set) inherit mode from their master — RouterOS rejects
    // configuration.mode if it is sent explicitly for a virtual interface.
    const isVirtualAp = !!params['master-interface'];
    for (const [k, v] of Object.entries(params)) {
      if (DeviceCollector.WIFI_UNSUPPORTED_PARAMS.has(k)) continue;
      if (k === 'mode' && isVirtualAp) continue;
      const mapped = DeviceCollector.WIFI_FIELD_MAP[k];
      out[mapped ?? k] = v;
    }
    return out;
  }

  // ─── Bridge helpers ───────────────────────────────────────────────────────

  async getBridges(): Promise<Record<string, string>[]> {
    return this.client.execute('/interface/bridge/print').catch(() => []);
  }

  async getBridgePorts(): Promise<Record<string, string>[]> {
    return this.client.execute('/interface/bridge/port/print').catch(() => []);
  }

  /**
   * Add, update, or remove a bridge port membership for a wifi interface.
   * Pass bridge=null to remove the interface from any bridge it's in.
   */
  async setInterfaceBridge(
    ifaceName: string,
    bridge: string | null,
    pvid?: number,
  ): Promise<void> {
    const ports = await this.getBridgePorts();
    const existing = ports.find(p => p['interface'] === ifaceName);

    if (!bridge) {
      if (existing) {
        await this.client.execute('/interface/bridge/port/remove', { '.id': existing['.id'] });
      }
      return;
    }

    const extra: Record<string, string> = {};
    if (pvid !== undefined && pvid > 0) extra['pvid'] = String(pvid);

    if (existing) {
      await this.client.execute('/interface/bridge/port/set', {
        '.id': existing['.id'], bridge, ...extra,
      });
    } else {
      await this.client.execute('/interface/bridge/port/add', {
        interface: ifaceName, bridge, ...extra,
      });
    }
  }

  // ─── Live wireless interface list (enriched with bridge port data) ─────────

  async getWirelessInterfaces(): Promise<Record<string, string>[]> {
    const pkg = await this.detectWifiPackage();
    if (pkg === 'none') return [];

    const [rawIfaces, bridgePorts] = await Promise.all([
      pkg === 'wifi'
        ? this.client.execute('/interface/wifi/print').catch(() => [] as Record<string, string>[])
        : this.client.execute('/interface/wireless/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
      this.getBridgePorts(),
    ]);

    const ifaces = pkg === 'wifi'
      ? rawIfaces.map(r => this.normalizeWifiInterface(r))
      : rawIfaces;

    // Enrich each interface with its bridge port membership (if any)
    const portByIface = new Map(bridgePorts.map(p => [p['interface'], p]));
    return ifaces.map(iface => {
      const port = portByIface.get(iface['name']);
      if (!port) return iface;
      return {
        ...iface,
        bridge:           port['bridge'] || '',
        'bridge-pvid':    port['pvid']   || '',
        'bridge-port-id': port['.id']    || '',
      };
    });
  }

  /**
   * Returns the next available interface name (e.g. wifi3, wifi4 …) by
   * fetching the live list from the device and skipping any names already in use.
   * Uses the correct prefix for the package in use (wifi vs wlan).
   */
  async getNextInterfaceName(): Promise<string> {
    const pkg = await this.detectWifiPackage();
    const prefix = pkg === 'wifi' ? 'wifi' : 'wlan';
    const raw = pkg === 'wifi'
      ? await this.client.execute('/interface/wifi/print').catch(() => [] as Record<string, string>[])
      : await this.client.execute('/interface/wireless/print').catch(() => [] as Record<string, string>[]);
    const existing = new Set(raw.map(i => i['name'] || ''));
    let idx = 1;
    while (existing.has(`${prefix}${idx}`)) idx++;
    return `${prefix}${idx}`;
  }

  async setWirelessInterface(name: string, params: Record<string, string>): Promise<void> {
    const pkg = await this.detectWifiPackage();
    if (pkg === 'wifi') {
      await this.client.execute('/interface/wifi/set', { '.id': name, ...this.translateToWifiParams(params) });
    } else {
      // Legacy wireless: drop inline security params — not supported directly on the interface
      const { passphrase, 'authentication-types': _at, ...legacyParams } = params;
      void passphrase; void _at;
      await this.client.execute('/interface/wireless/set', { '.id': name, ...legacyParams });
    }
  }

  async addWirelessInterface(params: Record<string, string>): Promise<void> {
    const pkg = await this.detectWifiPackage();
    if (pkg === 'wifi') {
      await this.client.execute('/interface/wifi/add', this.translateToWifiParams(params));
    } else {
      // Legacy wireless: drop inline security params — not supported directly on the interface
      const { passphrase, 'authentication-types': _at, ...legacyParams } = params;
      void passphrase; void _at;
      await this.client.execute('/interface/wireless/add', legacyParams);
    }
  }

  async removeWirelessInterface(name: string): Promise<void> {
    const pkg = await this.detectWifiPackage();
    const cmd = pkg === 'wifi' ? '/interface/wifi/remove' : '/interface/wireless/remove';
    await this.client.execute(cmd, { '.id': name });
  }

  async getSecurityProfilesLive(): Promise<Record<string, string>[]> {
    const pkg = await this.detectWifiPackage();
    if (pkg === 'wifi') {
      // Check for named /interface/wifi/security profiles first.
      const named = await this.client.execute('/interface/wifi/security/print').catch(() => [] as Record<string, string>[]);
      if (named.length > 0) {
        return named.map(p => ({
          'name':                 p['name'],
          'mode':                 'dynamic-keys',
          'authentication-types': p['authentication-types'] || '',
          'passphrase':           p['passphrase'] || '',
          'encryption':           p['encryption'] || '',
          'ft':                   p['ft'] || 'false',
          'ft-over-ds':           p['ft-over-ds'] || 'false',
        }));
      }
      // No named profiles — synthesize from inline interface security.* fields.
      const ifaces = await this.client.execute('/interface/wifi/print').catch(() => [] as Record<string, string>[]);
      return ifaces
        .filter(r => r['security.authentication-types'] || r['security.passphrase'])
        .map(r => ({
          'name':                 r['name'],
          'mode':                 'dynamic-keys',
          'authentication-types': r['security.authentication-types'] || '',
          'passphrase':           r['security.passphrase'] || '',
          'encryption':           r['security.encryption'] || '',
          'ft':                   r['security.ft'] || 'false',
          'ft-over-ds':           r['security.ft-over-ds'] || 'false',
        }));
    }
    return this.client.execute('/interface/wireless/security-profiles/print').catch(() => []);
  }

  async addSecurityProfile(params: Record<string, string>): Promise<void> {
    const pkg = await this.detectWifiPackage();
    if (pkg === 'wifi') {
      const secParams: Record<string, string> = {};
      if (params['name'])                 secParams['name']                 = params['name'];
      if (params['authentication-types']) secParams['authentication-types'] = params['authentication-types'];
      if (params['passphrase'])           secParams['passphrase']           = params['passphrase'];
      if (params['encryption'])           secParams['encryption']           = params['encryption'];
      await this.client.execute('/interface/wifi/security/add', secParams);
    } else {
      // Legacy wireless package uses wpa-pre-shared-key / wpa2-pre-shared-key
      const legacyParams: Record<string, string> = { ...params };
      if (params['passphrase']) {
        legacyParams['wpa-pre-shared-key']  = params['passphrase'];
        legacyParams['wpa2-pre-shared-key'] = params['passphrase'];
        delete legacyParams['passphrase'];
      }
      await this.client.execute('/interface/wireless/security-profiles/add', legacyParams);
    }
  }

  async setSecurityProfile(name: string, params: Record<string, string>): Promise<void> {
    const pkg = await this.detectWifiPackage();
    if (pkg === 'wifi') {
      const secParams: Record<string, string> = { '.id': name };
      if (params['mode'])                 secParams['mode']                 = params['mode'];
      if (params['authentication-types']) secParams['authentication-types'] = params['authentication-types'];
      if (params['passphrase'])           secParams['passphrase']           = params['passphrase'];
      if (params['encryption'])           secParams['encryption']           = params['encryption'];
      await this.client.execute('/interface/wifi/security/set', secParams);
    } else {
      const legacyParams: Record<string, string> = { ...params };
      if (params['passphrase']) {
        legacyParams['wpa-pre-shared-key']  = params['passphrase'];
        legacyParams['wpa2-pre-shared-key'] = params['passphrase'];
        delete legacyParams['passphrase'];
      }
      await this.client.execute('/interface/wireless/security-profiles/set', { '.id': name, ...legacyParams });
    }
  }

  async removeSecurityProfile(name: string): Promise<void> {
    const pkg = await this.detectWifiPackage();
    const cmd = pkg === 'wifi'
      ? '/interface/wifi/security/remove'
      : '/interface/wireless/security-profiles/remove';
    await this.client.execute(cmd, { '.id': name });
  }

  async getWifiRadioInfo(): Promise<Record<string, string>[]> {
    const pkg = await this.detectWifiPackage();
    if (pkg !== 'wifi') return [];
    return this.client.execute('/interface/wifi/radio/print').catch(() => []);
  }

  async getWirelessRegistrationTable(): Promise<Record<string, string>[]> {
    const pkg = await this.detectWifiPackage();
    const cmd = pkg === 'wifi'
      ? '/interface/wifi/registration-table/print'
      : '/interface/wireless/registration-table/print';
    return this.client.execute(cmd).catch(() => []);
  }

  async getWirelessMonitor(iface: string): Promise<Record<string, string>[]> {
    const pkg = await this.detectWifiPackage();
    const cmd = pkg === 'wifi' ? '/interface/wifi/monitor' : '/interface/wireless/monitor';
    return this.client.execute(cmd, { '.id': iface, once: '' }).catch(() => []);
  }

  async scanWireless(iface: string, durationMs = 5_000): Promise<Record<string, string>[]> {
    const pkg = await this.detectWifiPackage();
    const cmd = pkg === 'wifi' ? '/interface/wifi/scan' : '/interface/wireless/scan';
    return this.client.executeStreaming(cmd, { '.id': iface }, durationMs).catch(() => []);
  }

  // Run a spectral scan on a wifi interface for ~10 s and return the raw rows.
  // Only supported on the new wifi package — returns [] if unavailable.
  async collectSpectralScan(iface: string): Promise<Record<string, string>[]> {
    const pkg = await this.detectWifiPackage();
    if (pkg !== 'wifi') return [];
    return this.client
      .executeStreaming('/interface/wifi/spectral-scan', { '.id': iface }, 10_000)
      .catch(() => []);
  }

  // ─── Write-back operations ─────────────────────────────────────────────────

  async setInterfaceEnabled(name: string, enabled: boolean): Promise<void> {
    const cmd = enabled ? '/interface/enable' : '/interface/disable';
    await this.client.execute(cmd, { numbers: name });
  }

  async setInterfaceComment(name: string, comment: string): Promise<void> {
    await this.client.execute('/interface/set', { numbers: name, comment });
  }

  async getDetailedInterface(name: string): Promise<Record<string, string> | null> {
    const results = await this.client.execute('/interface/print', { detail: '' }, [`?name=${name}`]);
    return results[0] || null;
  }

  async getRoutingTable(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/route/print', { detail: '' });
  }

  async getFirewallRules(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/firewall/filter/print', { detail: '' });
  }

  async addFirewallRule(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/firewall/filter/add', params);
  }

  async updateFirewallRule(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/firewall/filter/set', { '.id': id, ...params });
  }

  async deleteFirewallRule(id: string): Promise<void> {
    await this.client.execute('/ip/firewall/filter/remove', { '.id': id });
  }

  async getNatRules(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/firewall/nat/print', { detail: '' });
  }

  async addNatRule(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/firewall/nat/add', params);
  }

  async updateNatRule(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/firewall/nat/set', { '.id': id, ...params });
  }

  async deleteNatRule(id: string): Promise<void> {
    await this.client.execute('/ip/firewall/nat/remove', { '.id': id });
  }

  // ─── Bridge ────────────────────────────────────────────────────────────────

  async setBridgeVlanFiltering(bridgeName: string, enabled: boolean): Promise<void> {
    const bridges = await this.client.execute('/interface/bridge/print');
    const bridge = bridges.find((b) => b['name'] === bridgeName);
    if (!bridge || !bridge['.id']) throw new Error(`Bridge '${bridgeName}' not found`);
    await this.client.execute('/interface/bridge/set', {
      '.id': bridge['.id'],
      'vlan-filtering': enabled ? 'yes' : 'no',
    });
  }

  async getSystemResource(): Promise<Record<string, string>> {
    const res = await this.client.execute('/system/resource/print');
    return res[0] || {};
  }

  async getSystemIdentity(): Promise<string> {
    const res = await this.client.execute('/system/identity/print');
    return res[0]?.['name'] || '';
  }

  async setBridgePortPvid(bridge: string, port: string, pvid: number): Promise<void> {
    const ports = await this.client.execute('/interface/bridge/port/print', {}, [`?interface=${port}`, `?bridge=${bridge}`]);
    if (ports[0]?.['.id']) {
      await this.client.execute('/interface/bridge/port/set', { '.id': ports[0]['.id'], pvid: String(pvid) });
    }
  }

  // ─── MTU ──────────────────────────────────────────────────────────────────

  async setInterfaceMtu(name: string, mtu: number): Promise<void> {
    // Step 1: raise l2mtu so RouterOS doesn't cap the L3 mtu below the requested value.
    // This silently fails on logical interfaces (bridge, vlan) where l2mtu is derived —
    // that is safe because RouterOSClient now properly drains !done after !trap.
    await this.client.execute('/interface/set', {
      numbers: name,
      'l2mtu': String(mtu + 8),
    }).catch(() => {});

    // Step 2: set the L3 mtu — always runs regardless of l2mtu outcome above.
    await this.client.execute('/interface/set', { numbers: name, mtu: String(mtu) });
  }

  // ─── PoE ──────────────────────────────────────────────────────────────────

  async setPoeOut(name: string, poeOut: 'auto-on' | 'forced-on' | 'off'): Promise<void> {
    const ports = await this.client
      .execute('/interface/ethernet/poe/print', {}, [`?name=${name}`])
      .catch(() => []);
    if (ports[0]?.['.id']) {
      await this.client.execute('/interface/ethernet/poe/set', {
        '.id': ports[0]['.id'],
        'poe-out': poeOut,
      });
    }
  }

  async getPoEStatus(name: string): Promise<Record<string, string> | null> {
    const result = await this.client
      .execute('/interface/ethernet/poe/print', {}, [`?name=${name}`])
      .catch(() => []);
    return result[0] || null;
  }

  async getAllPoEStatus(): Promise<Record<string, string>[]> {
    return this.client.execute('/interface/ethernet/poe/print', { detail: '' }).catch(() => []);
  }

  // ─── Port VLAN config ─────────────────────────────────────────────────────

  async setPortVlanConfig(
    portName: string,
    pvid: number,
    taggedVlans: number[],
    untaggedVlans: number[]
  ): Promise<void> {
    // 1. Find the bridge port entry and set PVID
    const bridgePorts = await this.client
      .execute('/interface/bridge/port/print', {}, [`?interface=${portName}`])
      .catch(() => []);

    const bridgePortEntry = bridgePorts[0];
    if (bridgePortEntry?.['.id']) {
      await this.client.execute('/interface/bridge/port/set', {
        '.id': bridgePortEntry['.id'],
        pvid: String(pvid),
      });
    }

    const bridge = bridgePortEntry?.['bridge'] || '';
    if (!bridge) return;

    // 2. Update tagged VLANs in bridge VLAN table
    for (const vlanId of taggedVlans) {
      const existing = await this.client
        .execute('/interface/bridge/vlan/print', {}, [`?bridge=${bridge}`, `?vlan-ids=${vlanId}`])
        .catch(() => []);

      if (existing[0]?.['.id']) {
        const currentTagged = this.parseList(existing[0]['tagged'] || '');
        const currentUntagged = this.parseList(existing[0]['untagged'] || '');
        const newTagged = [...new Set([...currentTagged, portName])];
        const newUntagged = currentUntagged.filter((p) => p !== portName);
        await this.client.execute('/interface/bridge/vlan/set', {
          '.id': existing[0]['.id'],
          tagged: newTagged.join(','),
          untagged: newUntagged.join(','),
        });
      }
    }

    // 3. Update untagged VLANs in bridge VLAN table
    for (const vlanId of untaggedVlans) {
      const existing = await this.client
        .execute('/interface/bridge/vlan/print', {}, [`?bridge=${bridge}`, `?vlan-ids=${vlanId}`])
        .catch(() => []);

      if (existing[0]?.['.id']) {
        const currentTagged = this.parseList(existing[0]['tagged'] || '');
        const currentUntagged = this.parseList(existing[0]['untagged'] || '');
        const newUntagged = [...new Set([...currentUntagged, portName])];
        const newTagged = currentTagged.filter((p) => p !== portName);
        await this.client.execute('/interface/bridge/vlan/set', {
          '.id': existing[0]['.id'],
          tagged: newTagged.join(','),
          untagged: newUntagged.join(','),
        });
      }
    }
  }

  /**
   * Ensure a given interface is an untagged member of `vlanId` in the bridge
   * VLAN table. Looks up which bridge the interface belongs to, then either
   * updates an existing VLAN entry or creates a new one.
   */
  async ensureVlanMembership(interfaceName: string, vlanId: number): Promise<void> {
    const bridgePorts = await this.client
      .execute('/interface/bridge/port/print', {}, [`?interface=${interfaceName}`])
      .catch(() => []);
    const bridgePort = (bridgePorts[0] as Record<string, string> | undefined);
    const bridge = bridgePort?.['bridge'];
    if (!bridge) return; // interface not in a bridge yet

    const existing = await this.client
      .execute('/interface/bridge/vlan/print', {}, [`?bridge=${bridge}`, `?vlan-ids=${vlanId}`])
      .catch(() => []);
    const entry = (existing[0] as Record<string, string> | undefined);

    if (entry?.['.id']) {
      const currentTagged = this.parseList(entry['tagged'] || '');
      const currentUntagged = this.parseList(entry['untagged'] || '');
      if (!currentUntagged.includes(interfaceName)) {
        const newUntagged = [...currentUntagged, interfaceName];
        const newTagged = currentTagged.filter(p => p !== interfaceName);
        await this.client.execute('/interface/bridge/vlan/set', {
          '.id': entry['.id'],
          tagged: newTagged.join(','),
          untagged: newUntagged.join(','),
        });
      }
    } else {
      await this.client.execute('/interface/bridge/vlan/add', {
        bridge,
        'vlan-ids': String(vlanId),
        untagged: interfaceName,
      });
    }
  }

  // ─── System Config ────────────────────────────────────────────────────────

  async getSystemConfig(): Promise<{
    identity: string;
    ntp: Record<string, string>;
    dns: Record<string, string>;
  }> {
    const [identity, ntp, dns] = await Promise.all([
      this.client.execute('/system/identity/print').catch(() => [{}]),
      this.client.execute('/system/ntp/client/print').catch(() => [{}]),
      this.client.execute('/ip/dns/print').catch(() => [{}]),
    ]);

    const ntpConfig: Record<string, string> = { ...(ntp[0] as Record<string, string>) };

    // RouterOS v7 removed primary-ntp/secondary-ntp; servers live in a separate list
    if (!ntpConfig['primary-ntp']) {
      const servers = await this.client
        .execute('/system/ntp/client/servers/print')
        .catch(() => []);
      if (servers[0]) ntpConfig['primary-ntp'] = (servers[0] as Record<string, string>)['address'] || '';
      if (servers[1]) ntpConfig['secondary-ntp'] = (servers[1] as Record<string, string>)['address'] || '';
    }

    // RouterOS 7 DNS returns booleans as "true"/"false" instead of "yes"/"no"
    const dnsRaw = (dns[0] as Record<string, string>) || {};
    const dnsNormalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(dnsRaw)) {
      dnsNormalized[k] = v === 'true' ? 'yes' : v === 'false' ? 'no' : v;
    }

    return {
      identity: (identity[0] as Record<string, string>)?.['name'] || '',
      ntp: ntpConfig,
      dns: dnsNormalized,
    };
  }

  async setSystemIdentity(name: string): Promise<void> {
    await this.client.execute('/system/identity/set', { name });
  }

  async setNtpConfig(enabled: boolean, primaryNtp: string, secondaryNtp: string): Promise<void> {
    // Try RouterOS v6 format first (primary-ntp / secondary-ntp as direct properties)
    try {
      await this.client.execute('/system/ntp/client/set', {
        enabled: enabled ? 'yes' : 'no',
        'primary-ntp': primaryNtp,
        'secondary-ntp': secondaryNtp,
      });
      return;
    } catch {
      // RouterOS v7 dropped primary-ntp/secondary-ntp — fall through to server-list approach
    }

    // RouterOS v7: enabled flag is separate; servers are managed as a list
    await this.client.execute('/system/ntp/client/set', {
      enabled: enabled ? 'yes' : 'no',
    });

    // Replace existing server entries
    const existing = await this.client
      .execute('/system/ntp/client/servers/print')
      .catch(() => []);
    for (const s of existing) {
      await this.client
        .execute('/system/ntp/client/servers/remove', { '.id': (s as Record<string, string>)['.id'] })
        .catch(() => {});
    }
    if (primaryNtp) {
      await this.client.execute('/system/ntp/client/servers/add', { address: primaryNtp });
    }
    if (secondaryNtp) {
      await this.client.execute('/system/ntp/client/servers/add', { address: secondaryNtp });
    }
  }

  async setDnsConfig(servers: string, allowRemoteRequests: boolean): Promise<void> {
    await this.client.execute('/ip/dns/set', {
      servers,
      'allow-remote-requests': allowRemoteRequests ? 'yes' : 'no',
    });
  }

  // ─── IP Addresses ─────────────────────────────────────────────────────────

  async getIpAddresses(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/address/print', { detail: '' }).catch(() => []);
  }

  async addIpAddress(address: string, interfaceName: string): Promise<void> {
    await this.client.execute('/ip/address/add', { address, interface: interfaceName });
  }

  async removeIpAddress(id: string): Promise<void> {
    await this.client.execute('/ip/address/remove', { numbers: id });
  }

  // ─── Clock / Time ─────────────────────────────────────────────────────────

  async getClockConfig(): Promise<{ date: string; time: string; timezone: string }> {
    const result = await this.client.execute('/system/clock/print').catch(() => [{}]);
    const r = (result[0] || {}) as Record<string, string>;
    // RouterOS date format: "mar/25/2026" → "2026-03-25"
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    let isoDate = '';
    const rosDate = r['date'] || '';
    if (rosDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(rosDate)) {
        // RouterOS 7 may already return ISO format
        isoDate = rosDate;
      } else {
        // RouterOS 6 format: "mar/25/2026"
        const parts = rosDate.split('/');
        if (parts.length === 3) {
          const [mon, day, year] = parts;
          const monthNum = months[mon?.toLowerCase()];
          if (monthNum && day && year) {
            isoDate = `${year}-${monthNum}-${day.padStart(2, '0')}`;
          }
        }
      }
    }
    return {
      date: isoDate,
      time: (r['time'] || '').substring(0, 5), // "HH:MM:SS" → "HH:MM"
      timezone: r['time-zone-name'] || 'UTC',
    };
  }

  async setClockConfig(params: { date?: string; time?: string; timezone?: string }): Promise<void> {
    const months: Record<string, string> = {
      '01': 'jan', '02': 'feb', '03': 'mar', '04': 'apr', '05': 'may', '06': 'jun',
      '07': 'jul', '08': 'aug', '09': 'sep', '10': 'oct', '11': 'nov', '12': 'dec',
    };
    const args: Record<string, string> = {};
    if (params.date) {
      // "2026-03-25" → "mar/25/2026"
      const [year, month, day] = params.date.split('-');
      args['date'] = `${months[month] || 'jan'}/${day}/${year}`;
    }
    if (params.time) args['time'] = params.time.length === 5 ? `${params.time}:00` : params.time;
    if (params.timezone) args['time-zone-name'] = params.timezone;
    if (Object.keys(args).length) {
      await this.client.execute('/system/clock/set', args);
    }
  }

  // ─── Route management ─────────────────────────────────────────────────────

  async addRoute(dstAddress: string, gateway: string, distance?: number, comment?: string): Promise<void> {
    const params: Record<string, string> = { 'dst-address': dstAddress, gateway };
    if (distance !== undefined) params['distance'] = String(distance);
    if (comment) params['comment'] = comment;
    await this.client.execute('/ip/route/add', params);
  }

  async removeRoute(routeId: string): Promise<void> {
    await this.client.execute('/ip/route/remove', { numbers: routeId });
  }

  // ─── VLAN management ──────────────────────────────────────────────────────

  async addBridgeVlan(bridge: string, vlanId: number, taggedPorts: string[], untaggedPorts: string[]): Promise<void> {
    const params: Record<string, string> = { bridge, 'vlan-ids': String(vlanId) };
    if (taggedPorts.length) params['tagged'] = taggedPorts.join(',');
    if (untaggedPorts.length) params['untagged'] = untaggedPorts.join(',');
    await this.client.execute('/interface/bridge/vlan/add', params);
  }

  async updateBridgeVlan(bridge: string, vlanId: number, taggedPorts: string[], untaggedPorts: string[]): Promise<void> {
    await this.removeBridgeVlan(bridge, vlanId);
    await this.addBridgeVlan(bridge, vlanId, taggedPorts, untaggedPorts);
  }

  async removeBridgeVlan(bridge: string, vlanId: number): Promise<void> {
    const entries = await this.client
      .execute('/interface/bridge/vlan/print', {}, [`?bridge=${bridge}`, `?vlan-ids=${vlanId}`])
      .catch(() => []);
    for (const entry of entries) {
      const id = (entry as Record<string, string>)['.id'];
      if (id) await this.client.execute('/interface/bridge/vlan/remove', { numbers: id }).catch(() => {});
    }
  }

  // ─── Bond (LAG / LACP) management ────────────────────────────────────────

  // RouterOS uses '1sec' / '30sec' for lacp-rate, not 'fast' / 'slow'
  private mapLacpRate(rate: string): string {
    if (rate === 'fast') return '1sec';
    if (rate === 'slow') return '30sec';
    return rate;
  }

  // RouterOS uses 'layer-2', 'layer-2-and-3', 'layer-3-and-4'
  private mapHashPolicy(policy: string): string {
    if (policy === 'layer2')   return 'layer-2';
    if (policy === 'layer2+3') return 'layer-2-and-3';
    if (policy === 'layer3+4') return 'layer-3-and-4';
    return policy;
  }

  async createBond(name: string, slaves: string[], mode: string, opts: {
    lacpRate?: string; hashPolicy?: string; mtu?: number; minLinks?: number;
  }): Promise<void> {
    // Remove each slave from any bridge, recording the first bridge found
    let originalBridge: string | null = null;
    for (const slave of slaves) {
      const bridgePorts = await this.client.execute('/interface/bridge/port/print', {}, [`?interface=${slave}`]).catch(() => []);
      for (const bp of bridgePorts) {
        if (bp['.id']) {
          if (!originalBridge) originalBridge = bp['bridge'] ?? null;
          await this.client.execute('/interface/bridge/port/remove', { '.id': bp['.id'] });
        }
      }
    }
    const params: Record<string, string> = { name, slaves: slaves.join(','), mode };
    if (opts.lacpRate)   params['lacp-rate'] = this.mapLacpRate(opts.lacpRate);
    if (opts.hashPolicy) params['transmit-hash-policy'] = this.mapHashPolicy(opts.hashPolicy);
    if (opts.mtu)        params['mtu'] = String(opts.mtu);
    if (opts.minLinks != null) params['min-links'] = String(opts.minLinks);
    await this.client.execute('/interface/bonding/add', params);
    // Add the new bond interface to the same bridge the slaves were removed from
    if (originalBridge) {
      await this.client.execute('/interface/bridge/port/add', {
        bridge: originalBridge,
        interface: name,
      }).catch(() => {});
    }
  }

  async updateBond(name: string, slaves: string[], mode: string, opts: {
    lacpRate?: string; hashPolicy?: string; mtu?: number; minLinks?: number;
  }): Promise<void> {
    const list = await this.client.execute('/interface/bonding/print', {}, [`?name=${name}`]);
    const id = list[0]?.['.id'];
    if (!id) throw new Error(`Bond '${name}' not found on device`);
    const params: Record<string, string> = { '.id': id, slaves: slaves.join(','), mode };
    if (opts.lacpRate)   params['lacp-rate'] = this.mapLacpRate(opts.lacpRate);
    if (opts.hashPolicy) params['transmit-hash-policy'] = this.mapHashPolicy(opts.hashPolicy);
    if (opts.mtu)        params['mtu'] = String(opts.mtu);
    if (opts.minLinks != null) params['min-links'] = String(opts.minLinks);
    await this.client.execute('/interface/bonding/set', params);
  }

  async deleteBond(name: string): Promise<void> {
    const list = await this.client.execute('/interface/bonding/print', {}, [`?name=${name}`]);
    const id = list[0]?.['.id'];
    if (!id) throw new Error(`Bond '${name}' not found on device`);
    const slaves = (list[0]?.['slaves'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    // Check if the bond is itself a bridge member
    const bondBridgePorts = await this.client.execute('/interface/bridge/port/print', {}, [`?interface=${name}`]).catch(() => []);
    const bridgeName = bondBridgePorts[0]?.['bridge'] ?? null;
    if (bondBridgePorts[0]?.['.id']) {
      await this.client.execute('/interface/bridge/port/remove', { '.id': bondBridgePorts[0]['.id'] });
    }
    await this.client.execute('/interface/bonding/remove', { '.id': id });
    // Re-add each slave to the bridge the bond was in
    if (bridgeName) {
      for (const slave of slaves) {
        await this.client.execute('/interface/bridge/port/add', {
          bridge: bridgeName,
          interface: slave,
        }).catch(() => {});
      }
    }
  }

  // ─── Hardware Health ──────────────────────────────────────────────────────

  async getHardware(): Promise<{
    health: Record<string, string>[];
    disks: Record<string, string>[];
  }> {
    const [health, externalDisks, resource] = await Promise.all([
      this.client.execute('/system/health/print').catch(() => []),
      this.client.execute('/disk/print').catch(() => []),
      this.client.execute('/system/resource/print').catch(() => []),
    ]);

    const disks: Record<string, string>[] = [];

    // Internal flash storage from system resource (values are raw bytes)
    const res = (resource[0] || {}) as Record<string, string>;
    const hddTotal = res['hdd-total'] || res['total-hdd-space'] || '';
    const hddFree = res['hdd-free'] || res['free-hdd-space'] || '';
    if (hddTotal) {
      disks.push({
        name: 'flash',
        label: 'Internal Flash',
        type: 'flash',
        total: hddTotal,
        free: hddFree,
      });
    }

    // External / additional disks (values are human-readable, e.g. "7.5GiB")
    for (const d of externalDisks) {
      disks.push(d as Record<string, string>);
    }

    return { health, disks };
  }

  // ─── Firmware updates ─────────────────────────────────────────────────────

  async checkForUpdates(): Promise<Record<string, string>> {
    await this.client.execute('/system/package/update/check-for-updates').catch(() => {});
    // Give the device a moment to complete the check
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    const result = await this.client
      .execute('/system/package/update/print')
      .catch(() => [] as Record<string, string>[]);
    return (result[0] as Record<string, string>) || {};
  }

  async installUpdate(): Promise<void> {
    await this.client.execute('/system/package/update/install');
  }

  async checkRouterboardUpgrade(): Promise<{ currentFirmware: string; upgradeFirmware: string; upgradeAvailable: boolean }> {
    const result = await this.client.execute('/system/routerboard/print').catch(() => [] as Record<string, string>[]);
    const rb = (result[0] as Record<string, string>) || {};
    const currentFirmware = (rb['current-firmware'] || '').trim();
    const upgradeFirmware = (rb['upgrade-firmware'] || '').trim();
    const upgradeAvailable = Boolean(upgradeFirmware && currentFirmware && upgradeFirmware !== currentFirmware);
    return { currentFirmware, upgradeFirmware, upgradeAvailable };
  }

  async installRouterboardUpgrade(): Promise<void> {
    await this.client.execute('/system/routerboard/upgrade');
    await this.client.execute('/system/reboot');
  }

  async reboot(): Promise<void> {
    await this.client.execute('/system/reboot');
  }

  // ─── Ethernet monitor / SFP DDM ───────────────────────────────────────────

  async getPortMonitor(name: string): Promise<Record<string, string>> {
    const results = await this.client
      .execute('/interface/ethernet/monitor', { numbers: name, once: '' })
      .catch(() => []);
    return (results[0] as Record<string, string>) || {};
  }

  async setFecMode(name: string, fecMode: string): Promise<void> {
    await this.client.execute('/interface/ethernet/set', { numbers: name, 'fec-mode': fecMode });
  }

  async setFlowControl(name: string, txFc: string, rxFc: string): Promise<void> {
    await this.client.execute('/interface/ethernet/set', {
      numbers: name,
      'tx-flow-control': txFc,
      'rx-flow-control': rxFc,
    });
  }

  async setAutoNegotiation(name: string, autoNeg: boolean, speed?: string): Promise<void> {
    const params: Record<string, string> = {
      numbers: name,
      'auto-negotiation': autoNeg ? 'yes' : 'no',
    };
    if (!autoNeg && speed) params['speed'] = speed;
    await this.client.execute('/interface/ethernet/set', params);
  }

  // ─── Routing Protocols ────────────────────────────────────────────────────

  async getOspfData(): Promise<{
    instances: Record<string, string>[];
    areas: Record<string, string>[];
    interfaceTemplates: Record<string, string>[];
    neighbors: Record<string, string>[];
  }> {
    const [instances, areas, interfaceTemplates, neighbors] = await Promise.all([
      this.client.execute('/routing/ospf/instance/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
      this.client.execute('/routing/ospf/area/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
      // ROS7 uses interface-template, ROS6 uses interface
      this.client.execute('/routing/ospf/interface-template/print', { detail: '' })
        .catch(() => this.client.execute('/routing/ospf/interface/print', { detail: '' }).catch(() => [] as Record<string, string>[])),
      this.client.execute('/routing/ospf/neighbor/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
    ]);
    return { instances, areas, interfaceTemplates, neighbors };
  }

  async addOspfInstance(params: Record<string, string>): Promise<void> {
    await this.client.execute('/routing/ospf/instance/add', params);
  }

  async removeOspfInstance(id: string): Promise<void> {
    await this.client.execute('/routing/ospf/instance/remove', { '.id': id });
  }

  async addOspfArea(params: Record<string, string>): Promise<void> {
    await this.client.execute('/routing/ospf/area/add', params);
  }

  async removeOspfArea(id: string): Promise<void> {
    await this.client.execute('/routing/ospf/area/remove', { '.id': id });
  }

  async getBgpData(): Promise<{
    connections: Record<string, string>[];
    sessions: Record<string, string>[];
    templates: Record<string, string>[];
  }> {
    // ROS7 uses /routing/bgp/connection, ROS6 uses /routing/bgp/peer
    const [connections, sessions, templates] = await Promise.all([
      this.client.execute('/routing/bgp/connection/print', { detail: '' })
        .catch(() => this.client.execute('/routing/bgp/peer/print', { detail: '' }).catch(() => [] as Record<string, string>[])),
      this.client.execute('/routing/bgp/session/print', { detail: '' }).catch(() => [] as Record<string, string>[]),
      this.client.execute('/routing/bgp/template/print', { detail: '' })
        .catch(() => this.client.execute('/routing/bgp/instance/print', { detail: '' }).catch(() => [] as Record<string, string>[])),
    ]);
    return { connections, sessions, templates };
  }

  async addBgpConnection(params: Record<string, string>): Promise<void> {
    // Try ROS7 path first, then ROS6
    await this.client.execute('/routing/bgp/connection/add', params)
      .catch(() => this.client.execute('/routing/bgp/peer/add', params));
  }

  async removeBgpConnection(id: string): Promise<void> {
    await this.client.execute('/routing/bgp/connection/remove', { '.id': id })
      .catch(() => this.client.execute('/routing/bgp/peer/remove', { '.id': id }));
  }

  async getRoutingTablesData(): Promise<Record<string, string>[]> {
    return this.client.execute('/routing/table/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addRoutingTable(params: Record<string, string>): Promise<void> {
    await this.client.execute('/routing/table/add', params);
  }

  async removeRoutingTable(id: string): Promise<void> {
    await this.client.execute('/routing/table/remove', { '.id': id });
  }

  async getRouteFiltersData(): Promise<{
    rules: Record<string, string>[];
    chains: string[];
  }> {
    // ROS7 uses /routing/filter/rule, ROS6 uses /routing/filter
    const rules = await this.client.execute('/routing/filter/rule/print', { detail: '' })
      .catch(() => this.client.execute('/routing/filter/print', { detail: '' }).catch(() => [] as Record<string, string>[]));
    const chains = [...new Set(rules.map(r => r['chain']).filter(Boolean))];
    return { rules, chains };
  }

  async addFilterRule(params: Record<string, string>): Promise<void> {
    await this.client.execute('/routing/filter/rule/add', params)
      .catch(() => this.client.execute('/routing/filter/add', params));
  }

  async updateFilterRule(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/routing/filter/rule/set', { '.id': id, ...params })
      .catch(() => this.client.execute('/routing/filter/set', { '.id': id, ...params }));
  }

  async removeFilterRule(id: string): Promise<void> {
    await this.client.execute('/routing/filter/rule/remove', { '.id': id })
      .catch(() => this.client.execute('/routing/filter/remove', { '.id': id }));
  }

  async getRouterIds(): Promise<Record<string, string>[]> {
    return this.client.execute('/routing/id/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  // ─── Network Services ─────────────────────────────────────────────────────────

  // DHCP ────────────────────────────────────────────────────────────────────────

  async getDhcpInterfaces(): Promise<Record<string, string>[]> {
    const all = await this.client.execute('/interface/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
    // Exclude interface types that can't meaningfully serve as a DHCP binding
    const excluded = new Set(['pppoe-out', 'pptp-client', 'l2tp-client', 'ovpn-client', 'sstp-client', 'lte', 'lo', 'ipip', 'eoip', 'gre', 'vxlan', 'wireguard']);
    return all.filter(i => !excluded.has(i['type'] || ''));
  }

  async getDhcpServers(protocol: 'ipv4' | 'ipv6'): Promise<Record<string, string>[]> {
    const cmd = protocol === 'ipv4' ? '/ip/dhcp-server/print' : '/ipv6/dhcp-server/print';
    return this.client.execute(cmd, { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addDhcpServer(params: Record<string, string>, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/dhcp-server' : '/ipv6/dhcp-server';
    await this.client.execute(`${base}/add`, params);
  }

  async updateDhcpServer(id: string, params: Record<string, string>, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/dhcp-server' : '/ipv6/dhcp-server';
    await this.client.execute(`${base}/set`, { '.id': id, ...params });
  }

  async removeDhcpServer(id: string, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/dhcp-server' : '/ipv6/dhcp-server';
    await this.client.execute(`${base}/remove`, { '.id': id });
  }

  async setDhcpServerDisabled(id: string, disabled: boolean, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/dhcp-server' : '/ipv6/dhcp-server';
    const cmd = disabled ? `${base}/disable` : `${base}/enable`;
    await this.client.execute(cmd, { '.id': id });
  }

  async getDhcpPools(protocol: 'ipv4' | 'ipv6'): Promise<Record<string, string>[]> {
    const cmd = protocol === 'ipv4' ? '/ip/pool/print' : '/ipv6/pool/print';
    return this.client.execute(cmd, { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addDhcpPool(params: Record<string, string>, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/pool' : '/ipv6/pool';
    await this.client.execute(`${base}/add`, params);
  }

  async removeDhcpPool(id: string, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/pool' : '/ipv6/pool';
    await this.client.execute(`${base}/remove`, { '.id': id });
  }

  async getDhcpLeases(protocol: 'ipv4' | 'ipv6'): Promise<Record<string, string>[]> {
    const cmd = protocol === 'ipv4'
      ? '/ip/dhcp-server/lease/print'
      : '/ipv6/dhcp-server/binding/print';
    return this.client.execute(cmd, { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addStaticDhcpLease(params: Record<string, string>, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/dhcp-server/lease' : '/ipv6/dhcp-server/binding';
    await this.client.execute(`${base}/add`, params);
  }

  async removeStaticDhcpLease(id: string, protocol: 'ipv4' | 'ipv6'): Promise<void> {
    const base = protocol === 'ipv4' ? '/ip/dhcp-server/lease' : '/ipv6/dhcp-server/binding';
    await this.client.execute(`${base}/remove`, { '.id': id });
  }

  // DNS ─────────────────────────────────────────────────────────────────────────

  async getDnsSettings(): Promise<Record<string, string>> {
    const rows = await this.client.execute('/ip/dns/print', {}).catch(() => [] as Record<string, string>[]);
    const row = rows[0] ?? {};
    // RouterOS 7 DNS returns booleans as "true"/"false" instead of "yes"/"no"
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v === 'true' ? 'yes' : v === 'false' ? 'no' : v;
    }
    return out;
  }

  async setDnsSettings(settings: {
    servers?: string;
    allow_remote_requests?: boolean;
    max_udp_packet_size?: string;
    cache_size?: string;
    cache_max_ttl?: string;
  }): Promise<void> {
    const params: Record<string, string> = {};
    if (settings.servers !== undefined) params['servers'] = settings.servers;
    if (settings.allow_remote_requests !== undefined) {
      params['allow-remote-requests'] = settings.allow_remote_requests ? 'yes' : 'no';
    }
    if (settings.max_udp_packet_size) params['max-udp-packet-size'] = settings.max_udp_packet_size;
    if (settings.cache_size) params['cache-size'] = settings.cache_size;
    if (settings.cache_max_ttl) params['cache-max-ttl'] = settings.cache_max_ttl;
    await this.client.execute('/ip/dns/set', params);
  }

  async getDnsStaticEntries(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/dns/static/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addDnsStaticEntry(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/dns/static/add', params);
  }

  async updateDnsStaticEntry(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/dns/static/set', { '.id': id, ...params });
  }

  async removeDnsStaticEntry(id: string): Promise<void> {
    await this.client.execute('/ip/dns/static/remove', { '.id': id });
  }

  async flushDnsCache(): Promise<void> {
    await this.client.execute('/ip/dns/cache/flush', {});
  }

  // NTP ─────────────────────────────────────────────────────────────────────────

  async getNtpSettings(): Promise<{
    server: Record<string, string>;
    client: Record<string, string>;
  }> {
    // RouterOS 7 NTP module returns boolean fields as "true"/"false" rather than
    // the "yes"/"no" used by every other RouterOS API. Normalize here so the rest
    // of the app can use a consistent contract.
    const normalizeBools = (r: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = v === 'true' ? 'yes' : v === 'false' ? 'no' : v;
      }
      return out;
    };

    const [server, client] = await Promise.allSettled([
      this.client.execute('/system/ntp/server/print', {}).then(r => normalizeBools(r[0] ?? {})),
      this.client.execute('/system/ntp/client/print', {}).then(r => normalizeBools(r[0] ?? {})),
    ]);
    return {
      server: server.status === 'fulfilled' ? server.value : {},
      client: client.status === 'fulfilled' ? client.value : {},
    };
  }

  async setNtpSettings(settings: {
    server_enabled?: boolean;
    server_broadcast?: boolean;
    server_manycast?: boolean;
    client_enabled?: boolean;
    client_mode?: string;
    client_servers?: string;
  }): Promise<void> {
    const serverParams: Record<string, string> = {};
    if (settings.server_enabled !== undefined) serverParams['enabled'] = settings.server_enabled ? 'yes' : 'no';
    if (settings.server_broadcast !== undefined) serverParams['broadcast'] = settings.server_broadcast ? 'yes' : 'no';
    if (settings.server_manycast !== undefined) serverParams['manycast'] = settings.server_manycast ? 'yes' : 'no';
    if (Object.keys(serverParams).length > 0) {
      await this.client.execute('/system/ntp/server/set', serverParams);
    }

    const clientParams: Record<string, string> = {};
    if (settings.client_enabled !== undefined) clientParams['enabled'] = settings.client_enabled ? 'yes' : 'no';
    if (settings.client_mode) clientParams['mode'] = settings.client_mode;
    if (settings.client_servers !== undefined) clientParams['servers'] = settings.client_servers;
    if (Object.keys(clientParams).length > 0) {
      await this.client.execute('/system/ntp/client/set', clientParams);
    }
  }

  // Syslog (logging actions + rules) ───────────────────────────────────────────

  async getSyslogActions(): Promise<Record<string, string>[]> {
    return this.client.execute('/system/logging/action/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addSyslogAction(params: Record<string, string>): Promise<void> {
    await this.client.execute('/system/logging/action/add', params);
  }

  async updateSyslogAction(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/system/logging/action/set', { '.id': id, ...params });
  }

  async removeSyslogAction(id: string): Promise<void> {
    await this.client.execute('/system/logging/action/remove', { '.id': id });
  }

  async getSyslogRules(): Promise<Record<string, string>[]> {
    return this.client.execute('/system/logging/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addSyslogRule(params: Record<string, string>): Promise<void> {
    await this.client.execute('/system/logging/add', params);
  }

  async updateSyslogRule(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/system/logging/set', { '.id': id, ...params });
  }

  async removeSyslogRule(id: string): Promise<void> {
    await this.client.execute('/system/logging/remove', { '.id': id });
  }

  async toggleSyslogRule(id: string, disabled: boolean): Promise<void> {
    await this.client.execute('/system/logging/set', { '.id': id, 'disabled': disabled ? 'yes' : 'no' });
  }

  // WireGuard ───────────────────────────────────────────────────────────────────

  async getWireGuardInterfaces(): Promise<Record<string, string>[]> {
    return this.client.execute('/interface/wireguard/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addWireGuardInterface(params: Record<string, string>): Promise<Record<string, string>[]> {
    await this.client.execute('/interface/wireguard/add', params);
    // Return updated list so caller gets the new interface with its generated public key
    return this.getWireGuardInterfaces();
  }

  async updateWireGuardInterface(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/interface/wireguard/set', { '.id': id, ...params });
  }

  async removeWireGuardInterface(id: string): Promise<void> {
    await this.client.execute('/interface/wireguard/remove', { '.id': id });
  }

  async setWireGuardInterfaceDisabled(id: string, disabled: boolean): Promise<void> {
    const cmd = disabled ? '/interface/wireguard/disable' : '/interface/wireguard/enable';
    await this.client.execute(cmd, { '.id': id });
  }

  async getWireGuardPeers(): Promise<Record<string, string>[]> {
    return this.client.execute('/interface/wireguard/peers/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addWireGuardPeer(params: Record<string, string>): Promise<void> {
    await this.client.execute('/interface/wireguard/peers/add', params);
  }

  async updateWireGuardPeer(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/interface/wireguard/peers/set', { '.id': id, ...params });
  }

  async removeWireGuardPeer(id: string): Promise<void> {
    await this.client.execute('/interface/wireguard/peers/remove', { '.id': id });
  }
}
