import { createHash } from 'crypto';
import { RouterOSClient } from './RouterOSClient';
import { query, queryOne } from '../../config/database';
import { getWriteApi } from '../../config/influxdb';
import { Point } from '@influxdata/influxdb-client';
import { decrypt } from '../../utils/crypto';
import { lookupVendor } from '../../utils/oui';
import { buildServerArpMap } from '../../utils/serverArp';
import { BackupService } from '../BackupService';
import { alertService } from '../AlertService';

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

/** Normalise a RouterOS band string + frequency (MHz) to a coarse RF band tag. */
function rfBand(band: string | undefined, frequency: number): '2.4' | '5' | '6' | 'unknown' {
  const b = (band || '').toLowerCase();
  if (b.includes('6ghz') || (frequency >= 5925 && frequency <= 7125)) return '6';
  if (b.includes('5ghz') || (frequency >= 4900 && frequency < 5925)) return '5';
  if (b.includes('2ghz') || (frequency >= 2400 && frequency < 2500)) return '2.4';
  return 'unknown';
}

/** A coarse RF band tag → the RouterOS-style band prefix we store for display. */
function bandPrefix(frequency: number): string | null {
  const b = rfBand(undefined, frequency);
  return b === '2.4' ? '2ghz' : b === '5' ? '5ghz' : b === '6' ? '6ghz' : null;
}

/**
 * Parse the new wifi package's monitor "channel" string into frequency + width.
 * Format: "<freq>/<phy>[/<control-positions>]" e.g. "2412/ax/Ce", "5180/ax/Ceee".
 * The control-position letters encode width: 1→20, 2→40, 4→80, 8→160 MHz.
 */
function parseWifiMonitorChannel(channel: string): { frequency: number; width: string } | null {
  if (!channel) return null;
  const segs = channel.split('/');
  const frequency = parseInt(segs[0], 10);
  if (!frequency || isNaN(frequency)) return null;
  const letters = (segs[2] || '').replace(/[^a-zA-Z]/g, '').length;
  const width = letters >= 8 ? '160mhz' : letters >= 4 ? '80mhz' : letters >= 2 ? '40mhz' : '20mhz';
  return { frequency, width };
}

export interface DeviceRow {
  id: number;
  name: string;
  ip_address: string;
  api_port: number;
  ssh_port?: number;
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
    if (this.device.device_type === 'switch') {
      await this.collectPoePower();
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
    // Wireless data belongs in a full resync too — without this, a manual sync
    // never refreshed radios/SSIDs (or pruned ones deleted on the device), so
    // the UI could only catch up on the 5-minute slow poll.
    if (this.device.device_type === 'wireless_ap') {
      await this.collectWirelessInterfaces();
      await this.collectSecurityProfiles();
    }
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

      // Drop rows for interfaces removed on the device (deleted VLAN/bridge/bond).
      // Safe: /interface/print above throws on failure, so reaching this point
      // means we have an authoritative list rather than a failed fetch.
      const presentNames = allIfaces.map((i) => i['name']).filter(Boolean);
      await query(
        `DELETE FROM interfaces WHERE device_id = $1 AND NOT (name = ANY($2::text[]))`,
        [this.device.id, presentNames]
      );
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
          `INSERT INTO clients (device_id, mac_address, hostname, ip_address, interface_name, vlan_id, tx_bytes, rx_bytes, signal_strength, client_type, active, last_seen, first_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,NOW(),NOW())
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
             last_seen=NOW(),
             first_seen=COALESCE(clients.first_seen, NOW())`,
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

  /**
   * Strip the volatile header RouterOS stamps onto every `/export` (a line like
   * `# 2026-06-06 14:26:09 by RouterOS 7.23.1`). Everything else in the export is
   * configuration, so what remains hashes stably across exports of an unchanged
   * device. We also trim trailing whitespace for a clean diff.
   */
  private static normalizeRsc(rsc: string): string {
    return rsc
      .split('\n')
      .filter((line) => !/^# \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} by RouterOS/.test(line))
      .join('\n')
      .replace(/\s+$/, '');
  }

  /** Compact summary of an .rsc change as added/removed line counts. */
  private static summarizeRscDiff(oldText: string, newText: string): string {
    const counts = (text: string): Map<string, number> => {
      const m = new Map<string, number>();
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line) m.set(line, (m.get(line) ?? 0) + 1);
      }
      return m;
    };
    const oldC = counts(oldText);
    const newC = counts(newText);
    let added = 0;
    let removed = 0;
    for (const [line, n] of newC) added += Math.max(0, n - (oldC.get(line) ?? 0));
    for (const [line, n] of oldC) removed += Math.max(0, n - (newC.get(line) ?? 0));
    if (!added && !removed) return 'Settings modified';
    const parts: string[] = [];
    if (added) parts.push(`+${added}`);
    if (removed) parts.push(`−${removed}`);
    return `${parts.join(' / ')} line${added + removed === 1 ? '' : 's'}`;
  }

  /** Drop snapshots beyond the retention count, removing any linked .rsc backups too. */
  private async pruneConfigSnapshots(): Promise<void> {
    const retRow = await queryOne<{ value: number }>(
      `SELECT value FROM app_settings WHERE key = 'config_snapshot_retention'`
    );
    const retention = typeof retRow?.value === 'number' && retRow.value > 0 ? retRow.value : 30;

    const stale = await query<{ id: number; backup_id: number | null }>(
      `SELECT id, backup_id FROM device_configs
       WHERE device_id = $1 AND id NOT IN (
         SELECT id FROM device_configs WHERE device_id = $1 ORDER BY collected_at DESC LIMIT $2
       )`,
      [this.device.id, retention]
    );
    if (!stale.length) return;

    const backupService = new BackupService();
    for (const row of stale) {
      // Deleting the backup cascades to the device_configs row (FK ON DELETE CASCADE).
      if (row.backup_id) {
        await backupService.deleteBackup(row.backup_id).catch(() => { /* best-effort */ });
      }
    }
    // Remove any rows that had no linked backup (cascade only covers linked ones).
    await query(`DELETE FROM device_configs WHERE id = ANY($1::int[])`, [stale.map((r) => r.id)]);
  }

  /**
   * Capture a config snapshot from the device's `/export` .rsc — the canonical,
   * config-only, restorable representation. Deduplicates by content hash (no-op
   * when nothing changed), stores the .rsc as a linked backup so the snapshot is
   * restorable, and fires a `config_drift` alert when the config changed.
   * Returns true when a new snapshot row was created, false on dedup/failure.
   */
  async snapshotConfig(reason = 'sync'): Promise<boolean> {
    try {
      const backupService = new BackupService();
      const device = this.device as unknown as import('../BackupService').BackupDevice;

      // The export requires SSH; without it there's no restorable snapshot to take.
      let rsc: string;
      try {
        rsc = await backupService.exportConfig(device);
      } catch (e) {
        console.warn(`[${this.device.name}] config snapshot skipped — /export failed: ${(e as Error).message}`);
        return false;
      }

      const text = DeviceCollector.normalizeRsc(rsc);
      const hash = createHash('sha256').update(text).digest('hex');

      const latest = await queryOne<{ config_hash: string | null; config_text: string | null }>(
        `SELECT config_hash, config_text FROM device_configs
         WHERE device_id = $1 ORDER BY collected_at DESC LIMIT 1`,
        [this.device.id]
      );

      // No change since the last snapshot — nothing to store.
      if (latest && latest.config_hash === hash) return false;

      const isFirst = !latest;
      const summary = isFirst
        ? 'Initial snapshot'
        : DeviceCollector.summarizeRscDiff(latest.config_text ?? '', text);

      // Persist the exact .rsc we just hashed as a restorable backup; the snapshot
      // and this backup are one artifact (FK cascade keeps them in lockstep).
      let backupId: number | null = null;
      try {
        backupId = await backupService.createBackupFromContent(
          device,
          rsc,
          `Config snapshot (${reason})`,
          'config-snapshot'
        );
      } catch (e) {
        console.warn(`[${this.device.name}] snapshot backup unavailable: ${(e as Error).message}`);
      }

      await query(
        `INSERT INTO device_configs (device_id, config_json, config_text, config_hash, change_summary, backup_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.device.id, '{}', text, hash, summary, backupId]
      );

      await this.pruneConfigSnapshots();

      // Alert on drift — skip the very first snapshot (nothing to compare against).
      if (!isFirst) {
        alertService.dispatch('config_drift', `Configuration changed on ${this.device.name}: ${summary}`, {
          deviceId: this.device.id,
          deviceName: this.device.name,
          details: summary,
        }).catch(() => { /* alerting is best-effort */ });
      }
      return true;
    } catch (err) {
      console.error(`[${this.device.name}] Failed to save config:`, err);
      return false;
    }
  }

  /** Back-compat entry point used by the full-sync flow. */
  async saveFullConfig(): Promise<void> {
    await this.snapshotConfig('full-sync');
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

      // null = the fetch itself failed. Distinguished from an empty list (device
      // genuinely has no wireless interfaces) so a transient API error can never
      // be mistaken for "everything was deleted" during the prune below.
      const rawList = pkg === 'wifi'
        ? await this.client.execute('/interface/wifi/print').catch(() => null)
        : await this.client.execute('/interface/wireless/print', { detail: '' }).catch(() => null);
      if (rawList === null) return;

      const wlans = pkg === 'wifi' ? rawList.map(r => this.normalizeWifiInterface(r)) : rawList;

      // New wifi package: the configured channel is usually "auto", so
      // /interface/wifi/print returns no frequency. Pull the live operating
      // channel from monitor for each physical radio; virtual APs inherit their
      // master's channel. (Legacy "wireless" print already includes frequency.)
      const liveFreq: Record<string, number> = {};
      const liveWidth: Record<string, string> = {};
      if (pkg === 'wifi') {
        const physical = wlans.filter(w => w['name'] && !w['master-interface']);
        await Promise.all(physical.map(async (w) => {
          const rname = w['name'];
          try {
            const mon = await this.client.execute('/interface/wifi/monitor', { '.id': rname, once: '' });
            const parsed = parseWifiMonitorChannel(mon[0]?.['channel'] || '');
            if (parsed) { liveFreq[rname] = parsed.frequency; liveWidth[rname] = parsed.width; }
          } catch { /* ignore per-radio monitor failures */ }
        }));
      }

      for (const wlan of wlans) {
        const name = wlan['name'];
        if (!name) continue;
        const master = wlan['master-interface'];
        const liveF = liveFreq[name] ?? (master ? liveFreq[master] : undefined);
        const liveW = liveWidth[name] ?? (master ? liveWidth[master] : undefined);
        const freq  = liveF ?? parseInt(wlan['frequency'] || '0', 10);
        const txPow = parseInt(wlan['tx-power'] || '0', 10);
        const gain  = parseInt(wlan['antenna-gain'] || '0', 10);
        const bandStr = wlan['band'] || (liveF ? bandPrefix(liveF) : null);
        const widthStr = wlan['channel-width'] || liveW || null;

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
            bandStr || null,
            !isNaN(freq) && freq > 0 ? freq : null,
            widthStr,
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

      // Drop rows for interfaces that no longer exist on the device (e.g. a
      // virtual AP removed directly in WinBox/WebFig). Without this the upsert
      // above only ever adds, so deleted radios linger in the UI forever.
      const present = wlans.map((w) => w['name']).filter(Boolean);
      await query(
        `DELETE FROM wireless_interfaces WHERE device_id = $1 AND NOT (name = ANY($2::text[]))`,
        [this.device.id, present]
      );
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
      // Per-radio transmit link quality. Legacy "wireless" registration tables
      // expose tx-ccq (0-100, higher = better); we derive a retry % as 100-CCQ
      // and average it per radio. The new "wifi" package omits CCQ, so this is
      // simply left empty there (the quality panel shows a clean empty state).
      const ccqSumByIface: Record<string, number> = {};
      const ccqCountByIface: Record<string, number> = {};
      for (const r of regTable) {
        const iface = r['interface'];
        if (!iface) continue;
        clientsByIface[iface] = (clientsByIface[iface] || 0) + 1;
        const ccqRaw = r['tx-ccq'];
        if (ccqRaw != null && ccqRaw !== '') {
          const ccq = parseInt(ccqRaw, 10);
          if (!isNaN(ccq)) {
            ccqSumByIface[iface]   = (ccqSumByIface[iface]   || 0) + ccq;
            ccqCountByIface[iface] = (ccqCountByIface[iface] || 0) + 1;
          }
        }
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

        // Per-radio TX retry % time series (only when CCQ data is available)
        const ccqCount = ccqCountByIface[name] || 0;
        if (ccqCount > 0) {
          const avgCcq = ccqSumByIface[name] / ccqCount;
          const retryPct = Math.max(0, Math.min(100, 100 - avgCcq));
          writeApi.writePoint(
            new Point('wireless_radio_quality')
              .tag('device_id', String(this.device.id))
              .tag('device_name', this.device.name)
              .tag('interface', name)
              .tag('band', rfBand(wlan['band'], parseInt(wlan['frequency'] || '0', 10)))
              .floatField('tx_retry_pct', Math.round(retryPct * 10) / 10)
              .intField('avg_ccq', Math.round(avgCcq))
              .timestamp(new Date())
          );
        }

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

  /** Remove stored security profiles that no longer exist on the device. */
  private async pruneSecurityProfiles(present: string[]): Promise<void> {
    await query(
      `DELETE FROM wireless_security_profiles WHERE device_id = $1 AND NOT (name = ANY($2::text[]))`,
      [this.device.id, present]
    );
  }

  // ─── Security Profiles → Postgres ─────────────────────────────────────────

  async collectSecurityProfiles(): Promise<void> {
    try {
      const pkg = await this.detectWifiPackage();
      if (pkg === 'none') return;

      if (pkg === 'wifi') {
        // Try named /interface/wifi/security profiles first.
        // Fall back to synthesizing from interface inline security.* fields if none exist.
        // null = fetch failed (leave existing rows alone); [] = genuinely none.
        const named = await this.client.execute('/interface/wifi/security/print').catch(() => null);
        if (named === null) return;

        let sourceList: Array<{ name: string; raw: Record<string, string> }>;
        if (named.length > 0) {
          sourceList = named.map(p => ({ name: p['name'], raw: p }));
        } else {
          const ifaceList = await this.client.execute('/interface/wifi/print').catch(() => null);
          if (ifaceList === null) return;
          sourceList = ifaceList
            .filter(r => r['security.authentication-types'] || r['security.passphrase'])
            .map(r => ({
              name: r['name'],
              raw: {
                'authentication-types': r['security.authentication-types'] || '',
                passphrase:             r['security.passphrase'] || '',
                encryption:             r['security.encryption'] || '',
              },
            }));
        }

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
        await this.pruneSecurityProfiles(sourceList.map((s) => s.name).filter(Boolean));
        return;
      }

      // Legacy wireless package
      const profiles = await this.client
        .execute('/interface/wireless/security-profiles/print')
        .catch(() => null);
      if (profiles === null) return;

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
      await this.pruneSecurityProfiles(profiles.map((p) => p['name']).filter(Boolean));
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

  async getInterfacesLive(): Promise<Record<string, string>[]> {
    return this.client.execute('/interface/print').catch(() => []);
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

  // `stats` makes RouterOS include the per-rule bytes/packets hit counters so
  // the UI can show which rules are matching (and flag dead, zero-hit rules).
  async getFirewallRules(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/firewall/filter/print', { detail: '', stats: '' });
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

  // Reorder: RouterOS evaluates rules top-to-bottom, so order is decisive.
  // `destination` is the .id the rule should be placed *before* (RouterOS
  // semantics), or omitted to move to the end.
  async moveFirewallRule(id: string, destination?: string): Promise<void> {
    const params: Record<string, string> = { numbers: id };
    if (destination) params.destination = destination;
    await this.client.execute('/ip/firewall/filter/move', params);
  }

  async resetFirewallCounters(): Promise<void> {
    await this.client.execute('/ip/firewall/filter/reset-counters-all', {});
  }

  async getNatRules(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/firewall/nat/print', { detail: '', stats: '' });
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

  async moveNatRule(id: string, destination?: string): Promise<void> {
    const params: Record<string, string> = { numbers: id };
    if (destination) params.destination = destination;
    await this.client.execute('/ip/firewall/nat/move', params);
  }

  // ─── Firewall Address Lists (reusable address objects) ──────────────────────

  async getAddressLists(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/firewall/address-list/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addAddressListEntry(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/firewall/address-list/add', params);
  }

  async updateAddressListEntry(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/firewall/address-list/set', { '.id': id, ...params });
  }

  async removeAddressListEntry(id: string): Promise<void> {
    await this.client.execute('/ip/firewall/address-list/remove', { '.id': id });
  }

  // ─── Connection tracking (live active connections) ──────────────────────────

  async getConnections(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/firewall/connection/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  // /ip/firewall/connection/tracking holds the global conntrack state. `enabled`
  // is yes / no / auto (auto = on only once firewall/NAT/mangle rules exist).
  async getConnectionTracking(): Promise<Record<string, string>> {
    const rows = await this.client.execute('/ip/firewall/connection/tracking/print', {}).catch(() => [] as Record<string, string>[]);
    return rows[0] || {};
  }

  // ─── Simple Queues (per-client / per-subnet bandwidth control) ──────────────

  async getSimpleQueues(): Promise<Record<string, string>[]> {
    return this.client.execute('/queue/simple/print', { detail: '', stats: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addSimpleQueue(params: Record<string, string>): Promise<void> {
    await this.client.execute('/queue/simple/add', params);
  }

  async updateSimpleQueue(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/queue/simple/set', { '.id': id, ...params });
  }

  async removeSimpleQueue(id: string): Promise<void> {
    await this.client.execute('/queue/simple/remove', { '.id': id });
  }

  // ─── Hotspot (Guest WiFi captive portal + vouchers) ─────────────────────────

  async getHotspotServers(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/hotspot/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async setHotspotServerDisabled(id: string, disabled: boolean): Promise<void> {
    await this.client.execute('/ip/hotspot/set', { '.id': id, disabled: disabled ? 'yes' : 'no' });
  }

  async removeHotspotServer(id: string): Promise<void> {
    await this.client.execute('/ip/hotspot/remove', { '.id': id });
  }

  async getHotspotProfiles(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/hotspot/profile/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addHotspotProfile(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/hotspot/profile/add', params);
  }

  async getHotspotUserProfiles(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/hotspot/user/profile/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addHotspotUserProfile(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/hotspot/user/profile/add', params);
  }

  async getHotspotUsers(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/hotspot/user/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addHotspotUser(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/hotspot/user/add', params);
  }

  async removeHotspotUser(id: string): Promise<void> {
    await this.client.execute('/ip/hotspot/user/remove', { '.id': id });
  }

  async getHotspotActive(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/hotspot/active/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async disconnectHotspotActive(id: string): Promise<void> {
    await this.client.execute('/ip/hotspot/active/remove', { '.id': id });
  }

  async getWalledGarden(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/hotspot/walled-garden/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addWalledGardenEntry(dstHost: string, comment?: string): Promise<void> {
    const params: Record<string, string> = { 'dst-host': dstHost, action: 'allow' };
    if (comment) params['comment'] = comment;
    await this.client.execute('/ip/hotspot/walled-garden/add', params);
  }

  async removeWalledGardenEntry(id: string): Promise<void> {
    await this.client.execute('/ip/hotspot/walled-garden/remove', { '.id': id });
  }

  /**
   * Full guest-network orchestration. Optionally creates the guest SSID itself
   * (a virtual AP on every physical radio) and segregates the traffic onto a
   * VLAN, then runs the captive-portal chain on the resulting interface:
   *
   *   [virtual APs] → [bridge/VLAN wiring] → pool → gw address → DHCP →
   *   hotspot profile → portal server → guest user profile → [masquerade NAT]
   *
   * Topologies:
   *  - ssid + vlanId:  new SSIDs joined to the main bridge with PVID=vlanId,
   *                    portal binds to a new /interface/vlan on that bridge.
   *  - ssid only:      new SSIDs joined to a dedicated guest bridge, portal
   *                    binds to that bridge (guests stay off the main LAN).
   *  - neither:        portal binds to the provided existing interface.
   */
  async setupGuestNetwork(opts: {
    name: string;
    gatewayCidr: string;
    poolRange: string;
    dnsName?: string;
    rateLimit?: string;
    interfaceName?: string;                    // existing-interface path
    ssid?: { ssid: string; passphrase?: string };
    vlanId?: number;
    masquerade?: boolean;
  }): Promise<{
    server: string; profile: string; userProfile: string; pool: string;
    targetInterface: string; ssidInterfaces: string[]; vlanInterface?: string;
    warnings: string[];
  }> {
    const { name, ssid, vlanId, masquerade } = opts;
    const warnings: string[] = [];
    const ssidInterfaces: string[] = [];
    let targetInterface = opts.interfaceName || '';
    let vlanInterface: string | undefined;

    if (ssid) {
      // 1. Create a virtual AP for the guest SSID on every physical radio
      const pkg = await this.detectWifiPackage();
      if (pkg === 'none') throw new Error('No wireless package detected on this device — cannot create a guest SSID');
      const raw = pkg === 'wifi'
        ? await this.client.execute('/interface/wifi/print').catch(() => [] as Record<string, string>[])
        : await this.client.execute('/interface/wireless/print').catch(() => [] as Record<string, string>[]);
      const physicals = raw.filter(r => !r['master-interface'] && r['name']);
      if (physicals.length === 0) throw new Error('No physical radios found to attach the guest SSID to');

      const existingBySsid = raw.filter(r =>
        (r['ssid'] || r['configuration.ssid'] || '') === ssid.ssid && r['master-interface']);
      if (existingBySsid.length > 0) {
        // Idempotency: SSID already exists — reuse it
        for (const e of existingBySsid) ssidInterfaces.push(e['name']);
      } else {
        for (const radio of physicals) {
          const ifaceName = await this.getNextInterfaceName();
          const params: Record<string, string> = {
            name: ifaceName,
            'master-interface': radio['name'],
            ssid: ssid.ssid,
            disabled: 'no',
          };
          if (pkg !== 'wifi') params['mode'] = 'ap-bridge';
          if (ssid.passphrase) {
            params['passphrase'] = ssid.passphrase;
            params['authentication-types'] = 'wpa2-psk';
          }
          await this.addWirelessInterface(params);
          ssidInterfaces.push(ifaceName);
        }
        if (pkg !== 'wifi' && ssid.passphrase) {
          warnings.push('Legacy wireless package: passphrase requires a security profile — the guest SSID was created OPEN. Assign a security profile manually if you need WPA2.');
        }
      }

      // 2. Wire the new SSIDs into the L2 topology
      const bridges = await this.getBridges();
      if (vlanId) {
        const mainBridge = bridges[0]?.['name'];
        if (!mainBridge) throw new Error('No bridge found on this device to attach the guest VLAN to');
        for (const iface of ssidInterfaces) {
          await this.setInterfaceBridge(iface, mainBridge, vlanId);
          await this.ensureVlanMembership(iface, vlanId);
        }
        // The bridge itself must be a tagged member so the L3 VLAN interface works
        await this.ensureBridgeTaggedMember(mainBridge, vlanId);
        // L3 VLAN interface the portal binds to
        vlanInterface = `${name}-vlan${vlanId}`;
        const vlans = await this.client.execute('/interface/vlan/print').catch(() => [] as Record<string, string>[]);
        const existing = vlans.find(v => v['interface'] === mainBridge && v['vlan-id'] === String(vlanId));
        if (existing) {
          vlanInterface = existing['name'];
        } else {
          await this.client.execute('/interface/vlan/add', {
            name: vlanInterface, 'vlan-id': String(vlanId), interface: mainBridge,
          });
        }
        targetInterface = vlanInterface;
        if (bridges[0]?.['vlan-filtering'] !== 'true') {
          warnings.push(`Bridge "${mainBridge}" has VLAN filtering disabled — guest VLAN ${vlanId} tagging won't isolate traffic until you enable it (Ports → bridge → VLAN filtering). Enabling it can interrupt management access, so review trunk/tagged config first.`);
        }
      } else {
        // Dedicated guest bridge keeps guests off the main LAN
        const guestBridge = `${name}-br`;
        if (!bridges.some(b => b['name'] === guestBridge)) {
          await this.client.execute('/interface/bridge/add', { name: guestBridge });
        }
        for (const iface of ssidInterfaces) {
          await this.setInterfaceBridge(iface, guestBridge);
        }
        targetInterface = guestBridge;
      }
    }

    if (!targetInterface) throw new Error('No target interface — provide interfaceName or ssid');

    // 3. Captive-portal chain on the target interface
    const chain = await this.setupHotspot({
      name, interfaceName: targetInterface,
      gatewayCidr: opts.gatewayCidr, poolRange: opts.poolRange,
      dnsName: opts.dnsName, rateLimit: opts.rateLimit,
    });

    // 4. Masquerade so guests can reach the internet
    if (masquerade) {
      const gwIp = opts.gatewayCidr.split('/')[0];
      const prefix = opts.gatewayCidr.split('/')[1] || '24';
      const network = `${this.networkAddressOf(gwIp, parseInt(prefix, 10))}/${prefix}`;
      const natComment = `${name}-guest-masquerade`;
      const natRules = await this.client.execute('/ip/firewall/nat/print').catch(() => [] as Record<string, string>[]);
      if (!natRules.some(r => (r['comment'] || '') === natComment)) {
        await this.client.execute('/ip/firewall/nat/add', {
          chain: 'srcnat', action: 'masquerade', 'src-address': network, comment: natComment,
        });
      }
    }

    return { ...chain, targetInterface, ssidInterfaces, vlanInterface, warnings };
  }

  /** Ensure the bridge itself is a tagged member of a VLAN (needed for L3 VLAN interfaces). */
  private async ensureBridgeTaggedMember(bridge: string, vlanId: number): Promise<void> {
    const rows = await this.client
      .execute('/interface/bridge/vlan/print', {}, [`?bridge=${bridge}`, `?vlan-ids=${vlanId}`])
      .catch(() => [] as Record<string, string>[]);
    const entry = rows[0];
    if (entry?.['.id']) {
      const tagged = (entry['tagged'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!tagged.includes(bridge)) {
        await this.client.execute('/interface/bridge/vlan/set', {
          '.id': entry['.id'], tagged: [...tagged, bridge].join(','),
        });
      }
    } else {
      await this.client.execute('/interface/bridge/vlan/add', {
        bridge, 'vlan-ids': String(vlanId), tagged: bridge,
      });
    }
  }

  /**
   * Orchestrated guest-hotspot setup — the API equivalent of RouterOS's
   * interactive `/ip hotspot setup` wizard. Creates (idempotently, keyed on the
   * guest network name): IP pool → gateway address on the interface → DHCP
   * server + network → hotspot profile → hotspot server → guest user profile.
   * Returns the names it created so the route can report/rollback.
   */
  async setupHotspot(opts: {
    name: string;            // logical name, e.g. "guest" → pool/profile/server names derive from it
    interfaceName: string;   // bridge/vlan/wifi interface to run the portal on
    gatewayCidr: string;     // e.g. "10.5.50.1/24" — address added to the interface
    poolRange: string;       // e.g. "10.5.50.10-10.5.50.254"
    dnsName?: string;        // portal hostname, e.g. "wifi.guest"
    rateLimit?: string;      // default guest speed, e.g. "10M/10M" (rx/tx)
  }): Promise<{ server: string; profile: string; userProfile: string; pool: string }> {
    const { name, interfaceName, gatewayCidr, poolRange, dnsName, rateLimit } = opts;
    const poolName = `${name}-pool`;
    const profileName = `${name}-profile`;
    const userProfileName = `${name}-guest`;
    const gwIp = gatewayCidr.split('/')[0];

    // 1. IP pool
    const pools = await this.client.execute('/ip/pool/print').catch(() => []);
    if (!pools.some(p => p['name'] === poolName)) {
      await this.client.execute('/ip/pool/add', { name: poolName, ranges: poolRange });
    }

    // 2. Gateway address on the interface
    const addrs = await this.client.execute('/ip/address/print').catch(() => []);
    if (!addrs.some(a => (a['address'] || '') === gatewayCidr && (a['interface'] || '') === interfaceName)) {
      await this.client.execute('/ip/address/add', { address: gatewayCidr, interface: interfaceName });
    }

    // 3. DHCP server + network
    const dhcpServers = await this.client.execute('/ip/dhcp-server/print').catch(() => []);
    if (!dhcpServers.some(s => s['name'] === `${name}-dhcp`)) {
      await this.client.execute('/ip/dhcp-server/add', {
        name: `${name}-dhcp`, interface: interfaceName, 'address-pool': poolName, disabled: 'no',
      });
    }
    const prefix = gatewayCidr.split('/')[1] || '24';
    const network = this.networkAddressOf(gwIp, parseInt(prefix, 10));
    const dhcpNets = await this.client.execute('/ip/dhcp-server/network/print').catch(() => []);
    if (!dhcpNets.some(n => (n['address'] || '') === `${network}/${prefix}`)) {
      await this.client.execute('/ip/dhcp-server/network/add', {
        address: `${network}/${prefix}`, gateway: gwIp, 'dns-server': gwIp,
      });
    }

    // 4. Hotspot profile
    const profiles = await this.getHotspotProfiles();
    if (!profiles.some(p => p['name'] === profileName)) {
      const params: Record<string, string> = {
        name: profileName, 'hotspot-address': gwIp, 'login-by': 'http-chap,http-pap',
      };
      if (dnsName) params['dns-name'] = dnsName;
      await this.addHotspotProfile(params);
    }

    // 5. Hotspot server
    const servers = await this.getHotspotServers();
    if (!servers.some(s => s['name'] === name)) {
      await this.client.execute('/ip/hotspot/add', {
        name, interface: interfaceName, 'address-pool': poolName, profile: profileName, disabled: 'no',
      });
    }

    // 6. Guest user profile (bandwidth cap + no inter-guest traffic)
    const userProfiles = await this.getHotspotUserProfiles();
    if (!userProfiles.some(p => p['name'] === userProfileName)) {
      const params: Record<string, string> = {
        name: userProfileName, 'shared-users': '1',
      };
      if (rateLimit) params['rate-limit'] = rateLimit;
      await this.addHotspotUserProfile(params);
    }

    return { server: name, profile: profileName, userProfile: userProfileName, pool: poolName };
  }

  /** Compute the network address for an IPv4 + prefix (e.g. 10.5.50.1/24 → 10.5.50.0). */
  private networkAddressOf(ip: string, prefix: number): string {
    const parts = ip.split('.').map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return ip;
    const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const net = (addr & mask) >>> 0;
    return [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.');
  }

  // ─── IP Services (for security-posture audit + hardening) ───────────────────

  async getServices(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/service/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async setServiceDisabled(id: string, disabled: boolean): Promise<void> {
    await this.client.execute('/ip/service/set', { '.id': id, disabled: disabled ? 'yes' : 'no' });
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

  async collectPoePower(): Promise<void> {
    try {
      const ports = await this.client
        .execute('/interface/ethernet/poe/monitor', { once: '' })
        .catch(() => [] as Record<string, string>[]);
      if (ports.length === 0) return;

      const writeApi = getWriteApi();
      for (const port of ports) {
        const name = port['name'] || port['port-name'] || '';
        if (!name) continue;
        const watts = parseFloat(port['poe-out-voltage'] || '0') * parseFloat(port['poe-out-current'] || '0') / 1000;
        const currentMa = parseFloat(port['poe-out-current'] || '0');
        const voltageV = parseFloat(port['poe-out-voltage'] || '0');
        writeApi.writePoint(
          new Point('poe_power')
            .tag('device_id', String(this.device.id))
            .tag('device_name', this.device.name)
            .tag('port', name)
            .floatField('watts', parseFloat(watts.toFixed(2)))
            .floatField('current_ma', currentMa)
            .floatField('voltage_v', voltageV)
            .timestamp(new Date())
        );
      }
      await writeApi.flush().catch((e) => console.error('InfluxDB PoE flush error:', e));
    } catch (err) {
      console.error(`[${this.device.name}] Failed to collect PoE power:`, err);
    }
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

  // Traffic Flow (NetFlow/IPFIX export) ─────────────────────────────────────────

  async getTrafficFlowSettings(): Promise<Record<string, string> | null> {
    const rows = await this.client.execute('/ip/traffic-flow/print', {}).catch(() => [] as Record<string, string>[]);
    return rows[0] || null;
  }

  async setTrafficFlowSettings(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/traffic-flow/set', params);
  }

  async getTrafficFlowTargets(): Promise<Record<string, string>[]> {
    return this.client.execute('/ip/traffic-flow/target/print', { detail: '' }).catch(() => [] as Record<string, string>[]);
  }

  async addTrafficFlowTarget(params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/traffic-flow/target/add', params);
  }

  async updateTrafficFlowTarget(id: string, params: Record<string, string>): Promise<void> {
    await this.client.execute('/ip/traffic-flow/target/set', { '.id': id, ...params });
  }

  async removeTrafficFlowTarget(id: string): Promise<void> {
    await this.client.execute('/ip/traffic-flow/target/remove', { '.id': id });
  }
}
