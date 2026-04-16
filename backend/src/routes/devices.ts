import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { encrypt, decrypt } from '../utils/crypto';
import { RouterOSClient } from '../services/mikrotik/RouterOSClient';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import { PollerService } from '../services/PollerService';

const router = Router();
router.use(requireAuth);

let pollerService: PollerService | null = null;
export function setPollerService(p: PollerService): void {
  pollerService = p;
}

// GET /api/devices
router.get('/', async (_req: Request, res: Response) => {
  const devices = await query(
    `SELECT id, name, ip_address, api_port, api_username, model, serial_number,
            firmware_version, ros_version, latest_ros_version, firmware_update_available,
            device_type, status, last_seen, notes,
            location_address, location_lat::float8 AS location_lat, location_lng::float8 AS location_lng,
            rack_name, rack_slot, created_at
     FROM devices ORDER BY name ASC`
  );
  res.json(devices);
});

// ─── Routers overview (router-type devices with route counts) ─────────────────
router.get('/routers/overview', async (_req: Request, res: Response) => {
  const routers = await query(`
    SELECT d.id, d.name, d.ip_address, d.model, d.device_type, d.status, d.last_seen,
           d.ros_version, d.firmware_version, d.serial_number, d.rack_name, d.rack_slot,
           COUNT(i.id) FILTER (WHERE i.running = true  AND i.disabled = false) AS ifaces_up,
           COUNT(i.id) FILTER (WHERE i.running = false AND i.disabled = false) AS ifaces_down,
           COUNT(i.id) FILTER (WHERE i.disabled = true)                        AS ifaces_disabled,
           COUNT(i.id)                                                          AS ifaces_total
    FROM devices d
    LEFT JOIN interfaces i ON i.device_id = d.id
      AND (i.type ILIKE 'ether%' OR i.type ILIKE 'sfp%'
           OR i.name ILIKE 'ether%' OR i.name ILIKE 'sfp%')
    WHERE d.device_type = 'router'
    GROUP BY d.id
    ORDER BY d.name ASC
  `);
  res.json(routers);
});

// GET /api/devices/discovered — unresolved MikroTik neighbors from topology_links
router.get('/discovered', async (_req: Request, res: Response) => {
  const rows = await query<{
    neighbor_identity: string | null;
    neighbor_address: string | null;
    neighbor_mac: string | null;
    neighbor_platform: string | null;
    discovered_at: string;
    seen_by: string;
  }>(`
    SELECT tl.neighbor_identity,
           COALESCE(NULLIF(tl.neighbor_address, ''), c.ip_address) AS neighbor_address,
           tl.neighbor_mac,
           tl.neighbor_platform, tl.discovered_at, d.name AS seen_by
    FROM topology_links tl
    JOIN devices d ON d.id = tl.from_device_id
    LEFT JOIN clients c ON LOWER(c.mac_address) = LOWER(tl.neighbor_mac)
                        AND c.ip_address IS NOT NULL AND c.ip_address != ''
    WHERE tl.to_device_id IS NULL
      AND tl.neighbor_platform ILIKE '%mikrotik%'
      AND (tl.neighbor_address IS NULL OR tl.neighbor_address = '' OR tl.neighbor_address NOT LIKE '%:%')
    ORDER BY tl.discovered_at DESC
  `);

  // Deduplicate by MAC (most reliable), fallback to IP, then identity
  const seen = new Map<string, typeof rows[0] & { seen_by_list: string[] }>();
  for (const row of rows) {
    const key = row.neighbor_mac || row.neighbor_address || row.neighbor_identity || '';
    if (!key) continue;
    if (seen.has(key)) {
      const existing = seen.get(key)!;
      if (!existing.seen_by_list.includes(row.seen_by)) {
        existing.seen_by_list.push(row.seen_by);
      }
    } else {
      seen.set(key, { ...row, seen_by_list: [row.seen_by] });
    }
  }

  const results = Array.from(seen.values()).map((r) => ({
    identity: r.neighbor_identity || '',
    address: r.neighbor_address || '',
    mac_address: r.neighbor_mac || '',
    platform: r.neighbor_platform || '',
    discovered_at: r.discovered_at,
    seen_by: r.seen_by_list.join(', '),
  }));

  res.json(results);
});

// POST /api/devices
router.post('/', requireWrite, async (req: Request, res: Response) => {
  const { name, ip_address, api_port = 8728, api_username, api_password,
          ssh_port = 22, ssh_username, ssh_password, device_type = 'router', notes } = req.body;

  if (!name || !ip_address || !api_username || !api_password) {
    return res.status(400).json({ error: 'name, ip_address, api_username, api_password are required' });
  }

  // Test connection before saving
  const testClient = new RouterOSClient(ip_address, api_port, api_username, api_password, 10_000);
  try {
    await testClient.connect();
    testClient.disconnect();
  } catch (err) {
    return res.status(422).json({
      error: `Cannot connect to device: ${(err as Error).message}`,
    });
  }

  const encryptedPass = encrypt(api_password);
  const encryptedSshPass = ssh_password ? encrypt(ssh_password) : null;

  const rows = await query<{ id: number }>(
    `INSERT INTO devices (name, ip_address, api_port, api_username, api_password_encrypted,
                          ssh_port, ssh_username, ssh_password_encrypted, device_type, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown') RETURNING id`,
    [name, ip_address, api_port, api_username, encryptedPass,
     ssh_port, ssh_username || null, encryptedSshPass, device_type, notes || null]
  );

  const newId = rows[0].id;

  // Trigger full sync in background
  if (pollerService) {
    await pollerService.scheduleDeviceSync(newId, 'full');
  }

  const device = await queryOne(
    `SELECT id, name, ip_address, api_port, api_username, model, serial_number,
            firmware_version, ros_version, device_type, status, last_seen, notes, created_at
     FROM devices WHERE id = $1`,
    [newId]
  );

  return res.status(201).json(device);
});

// GET /api/devices/:id
router.get('/:id', async (req: Request, res: Response) => {
  const device = await queryOne(
    `SELECT id, name, ip_address, api_port, api_username, ssh_port, ssh_username, model,
            serial_number, firmware_version, ros_version, device_type, status, last_seen,
            notes, location_address,
            location_lat::float8 AS location_lat,
            location_lng::float8 AS location_lng,
            rack_name, rack_slot, created_at, updated_at
     FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!device) return res.status(404).json({ error: 'Device not found' });
  return res.json(device);
});

// PATCH /api/devices/:id/location — save physical location & rack info
router.patch('/:id/location', requireWrite, async (req: Request, res: Response) => {
  const { location_address, location_lat, location_lng, rack_name, rack_slot, notes } = req.body;
  const existing = await queryOne(`SELECT id FROM devices WHERE id = $1`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Device not found' });

  await query(
    `UPDATE devices SET
       location_address = $1,
       location_lat     = $2,
       location_lng     = $3,
       rack_name        = $4,
       rack_slot        = $5,
       notes            = $6,
       updated_at       = NOW()
     WHERE id = $7`,
    [
      location_address ?? null,
      location_lat     ?? null,
      location_lng     ?? null,
      rack_name        ?? null,
      rack_slot        ?? null,
      notes            ?? null,
      req.params.id,
    ]
  );

  const updated = await queryOne(
    `SELECT id, name, ip_address, api_port, api_username, ssh_port, ssh_username, model,
            serial_number, firmware_version, ros_version, device_type, status, last_seen,
            notes, location_address,
            location_lat::float8 AS location_lat,
            location_lng::float8 AS location_lng,
            rack_name, rack_slot, created_at, updated_at
     FROM devices WHERE id = $1`,
    [req.params.id]
  );
  return res.json(updated);
});

// PUT /api/devices/:id
router.put('/:id', requireWrite, async (req: Request, res: Response) => {
  const { name, api_port, api_username, api_password, ssh_port, ssh_username,
          ssh_password, device_type, notes } = req.body;

  const existing = await queryOne<{ id: number; api_password_encrypted: string }>(
    `SELECT id, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!existing) return res.status(404).json({ error: 'Device not found' });

  const encPass = api_password ? encrypt(api_password) : existing.api_password_encrypted;
  const encSshPass = ssh_password ? encrypt(ssh_password) : null;

  await query(
    `UPDATE devices SET
       name=COALESCE($1,name), api_port=COALESCE($2,api_port),
       api_username=COALESCE($3,api_username), api_password_encrypted=$4,
       ssh_port=COALESCE($5,ssh_port), ssh_username=COALESCE($6,ssh_username),
       ssh_password_encrypted=COALESCE($7,ssh_password_encrypted),
       device_type=COALESCE($8,device_type), notes=COALESCE($9,notes),
       updated_at=NOW()
     WHERE id = $10`,
    [name, api_port, api_username, encPass, ssh_port, ssh_username, encSshPass, device_type, notes, req.params.id]
  );

  const updated = await queryOne(
    `SELECT id, name, ip_address, api_port, api_username, model, serial_number,
            firmware_version, ros_version, device_type, status, last_seen, notes
     FROM devices WHERE id = $1`,
    [req.params.id]
  );
  return res.json(updated);
});

// DELETE /api/devices/:id
router.delete('/:id', requireWrite, async (req: Request, res: Response) => {
  const result = await query(`DELETE FROM devices WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!result.length) return res.status(404).json({ error: 'Device not found' });
  return res.json({ message: 'Device deleted' });
});

// POST /api/devices/:id/sync - run a full resync and wait for it to complete
router.post('/:id/sync', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(
    `SELECT * FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.collectAll();
    return res.json({ message: 'Sync completed' });
  } catch (err) {
    return res.status(500).json({ error: `Sync failed: ${(err as Error).message}` });
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/interfaces
router.get('/:id/interfaces', async (req: Request, res: Response) => {
  const ifaces = await query(
    `SELECT * FROM interfaces WHERE device_id = $1 ORDER BY name ASC`,
    [req.params.id]
  );
  return res.json(ifaces);
});

// PUT /api/devices/:id/interfaces/:name
router.put('/:id/interfaces/:name', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<{ id: number; ip_address: string; api_port: number; api_username: string; api_password_encrypted: string }>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow as unknown as DeviceRow);
  try {
    await collector.connect();
    const { disabled, comment, mtu, poe_out, fec_mode, tx_flow_control, rx_flow_control, auto_negotiation, speed } = req.body;
    if (typeof disabled === 'boolean') {
      await collector.setInterfaceEnabled(req.params.name, !disabled);
    }
    if (comment !== undefined) {
      await collector.setInterfaceComment(req.params.name, comment);
    }
    if (typeof mtu === 'number' && mtu >= 576 && mtu <= 9216) {
      await collector.setInterfaceMtu(req.params.name, mtu);
    }
    if (poe_out && ['auto-on', 'forced-on', 'off'].includes(poe_out)) {
      await collector.setPoeOut(req.params.name, poe_out as 'auto-on' | 'forced-on' | 'off');
    }
    if (fec_mode && ['clause-74', 'clause-91', 'off'].includes(fec_mode)) {
      await collector.setFecMode(req.params.name, fec_mode);
    }
    if (tx_flow_control !== undefined || rx_flow_control !== undefined) {
      const txFc = tx_flow_control ?? 'off';
      const rxFc = rx_flow_control ?? 'off';
      if (['on', 'off', 'auto'].includes(txFc) && ['on', 'off', 'auto'].includes(rxFc)) {
        await collector.setFlowControl(req.params.name, txFc, rxFc);
      }
    }
    if (typeof auto_negotiation === 'boolean') {
      await collector.setAutoNegotiation(req.params.name, auto_negotiation, speed);
    }
    await collector.collectInterfaces();
    return res.json({ message: 'Interface updated' });
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/ports/:name/vlan - configure VLAN for a switch port
router.put('/:id/ports/:name/vlan', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const { pvid, tagged_vlans = [], untagged_vlans = [] } = req.body;
  if (pvid !== undefined && (typeof pvid !== 'number' || pvid < 1 || pvid > 4094)) {
    return res.status(400).json({ error: 'pvid must be 1-4094' });
  }

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.setPortVlanConfig(
      req.params.name,
      pvid ?? 1,
      tagged_vlans as number[],
      untagged_vlans as number[]
    );
    await collector.collectVlans();
    return res.json({ message: 'VLAN configuration applied' });
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/vlans
router.get('/:id/vlans', async (req: Request, res: Response) => {
  const vlans = await query(`SELECT * FROM vlans WHERE device_id = $1 ORDER BY vlan_id ASC`, [req.params.id]);
  return res.json(vlans);
});

// GET /api/devices/:id/ports/:name/monitor — live ethernet monitor + SFP DDM
router.get('/:id/ports/:name/monitor', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<{ id: number; ip_address: string; api_port: number; api_username: string; api_password_encrypted: string }>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow as unknown as DeviceRow);
  try {
    await collector.connect();
    const monitor = await collector.getPortMonitor(req.params.name);
    return res.json(monitor);
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/ports (switch port layout with VLAN info)
router.get('/:id/ports', async (req: Request, res: Response) => {
  const [ifaces, bridgePorts, vlans] = await Promise.all([
    query(`SELECT * FROM interfaces WHERE device_id = $1 ORDER BY name`, [req.params.id]),
    query(`SELECT * FROM bridge_vlan_entries WHERE device_id = $1`, [req.params.id]),
    query(`SELECT * FROM vlans WHERE device_id = $1`, [req.params.id]),
  ]);

  // Enrich interface data with VLAN info
  const bridgePortMap = new Map(bridgePorts.map((bp: Record<string, unknown>) => [bp['port'], bp]));

  const ports = ifaces
    .filter((i: Record<string, unknown>) =>
      String(i['type'] || '').match(/^(ether|sfp|combo|bridge|bond)/i) ||
      String(i['name'] || '').match(/^(ether|sfp|combo|bridge|bond|lag)/i)
    )
    .map((i: Record<string, unknown>) => ({
      ...i,
      bridgeInfo: bridgePortMap.get(i['name']) || null,
    }));

  return res.json({ ports, vlans });
});

// GET /api/devices/:id/routing
router.get('/:id/routing', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<{ id: number; ip_address: string; api_port: number; api_username: string; api_password_encrypted: string }>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow as any);
  try {
    await collector.connect();
    const routes = await collector.getRoutingTable();
    return res.json(routes);
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/firewall
router.get('/:id/firewall', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    return res.json(await collector.getFirewallRules());
  } finally {
    collector.disconnect();
  }
});

const FW_FIELD_MAP: Record<string, string> = {
  chain: 'chain', action: 'action', protocol: 'protocol', comment: 'comment', disabled: 'disabled',
  src_address: 'src-address', dst_address: 'dst-address',
  src_port: 'src-port', dst_port: 'dst-port',
  in_interface: 'in-interface', out_interface: 'out-interface',
  connection_state: 'connection-state', jump_target: 'jump-target',
  log: 'log', log_prefix: 'log-prefix',
  src_address_list: 'src-address-list', dst_address_list: 'dst-address-list',
};

function bodyToRosParams(body: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [jsKey, rosKey] of Object.entries(FW_FIELD_MAP)) {
    const val = body[jsKey];
    if (val !== undefined && val !== null && val !== '') {
      params[rosKey] = String(val);
    }
  }
  return params;
}

// POST /api/devices/:id/firewall
router.post('/:id/firewall', requireWrite, async (req: Request, res: Response) => {
  const { chain, action } = req.body;
  if (!chain || !action) return res.status(400).json({ error: 'chain and action are required' });
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addFirewallRule(bodyToRosParams(req.body));
    return res.status(201).json(await collector.getFirewallRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/firewall/:ruleId
router.put('/:id/firewall/:ruleId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.updateFirewallRule(req.params.ruleId, bodyToRosParams(req.body));
    return res.json(await collector.getFirewallRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// DELETE /api/devices/:id/firewall/:ruleId
router.delete('/:id/firewall/:ruleId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.deleteFirewallRule(req.params.ruleId);
    return res.json({ message: 'Rule deleted' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// ─── NAT Rules ────────────────────────────────────────────────────────────────
const NAT_FIELD_MAP: Record<string, string> = {
  chain: 'chain', action: 'action', protocol: 'protocol', comment: 'comment', disabled: 'disabled',
  src_address: 'src-address', dst_address: 'dst-address',
  src_port: 'src-port', dst_port: 'dst-port',
  in_interface: 'in-interface', out_interface: 'out-interface',
  to_addresses: 'to-addresses', to_ports: 'to-ports',
  log: 'log', log_prefix: 'log-prefix',
};

function natBodyToRosParams(body: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [jsKey, rosKey] of Object.entries(NAT_FIELD_MAP)) {
    const val = body[jsKey];
    if (val !== undefined && val !== null && val !== '') {
      params[rosKey] = String(val);
    }
  }
  return params;
}

// GET /api/devices/:id/nat
router.get('/:id/nat', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    return res.json(await collector.getNatRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/nat
router.post('/:id/nat', requireWrite, async (req: Request, res: Response) => {
  const { chain, action } = req.body;
  if (!chain || !action) return res.status(400).json({ error: 'chain and action are required' });
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addNatRule(natBodyToRosParams(req.body));
    return res.status(201).json(await collector.getNatRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/nat/:ruleId
router.put('/:id/nat/:ruleId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.updateNatRule(req.params.ruleId, natBodyToRosParams(req.body));
    return res.json(await collector.getNatRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// DELETE /api/devices/:id/nat/:ruleId
router.delete('/:id/nat/:ruleId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.deleteNatRule(req.params.ruleId);
    return res.json({ message: 'NAT rule deleted' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/resources (live resource usage)
router.get('/:id/resources', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const resource = await collector.getSystemResource();
    return res.json(resource);
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/system-config
router.get('/:id/system-config', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const config = await collector.getSystemConfig();
    return res.json(config);
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/system-config
router.put('/:id/system-config', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const { identity, ntp_enabled, ntp_primary, ntp_secondary, dns_servers, dns_allow_remote } = req.body;

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    if (identity !== undefined) {
      await collector.setSystemIdentity(identity);
    }
    if (ntp_primary !== undefined) {
      await collector.setNtpConfig(
        ntp_enabled !== false,
        ntp_primary || '',
        ntp_secondary || ''
      );
    }
    if (dns_servers !== undefined) {
      await collector.setDnsConfig(dns_servers, dns_allow_remote === true);
    }
    return res.json({ message: 'System configuration updated' });
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/ip-addresses
router.get('/:id/ip-addresses', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const addresses = await collector.getIpAddresses();
    return res.json(addresses);
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/ip-addresses
router.post('/:id/ip-addresses', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const { address, interface: iface } = req.body;
  if (!address || !iface) {
    return res.status(400).json({ error: 'address and interface are required' });
  }

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addIpAddress(address, iface);
    const addresses = await collector.getIpAddresses();
    return res.status(201).json(addresses);
  } finally {
    collector.disconnect();
  }
});

// DELETE /api/devices/:id/ip-addresses/:addrId
router.delete('/:id/ip-addresses/:addrId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeIpAddress(req.params.addrId);
    return res.json({ message: 'IP address removed' });
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/check-update
router.post('/:id/check-update', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const updateInfo = await collector.checkForUpdates();

    // Persist results so the UI reflects the latest check immediately
    const latestVersion = (updateInfo['latest-version'] ?? '').trim();
    const installedVersion = (updateInfo['installed-version'] ?? '').trim();
    const statusText = (updateInfo['status'] ?? '').toLowerCase();
    const hasUpdate =
      statusText.includes('available') ||
      (latestVersion && installedVersion && latestVersion !== installedVersion);

    await query(
      `UPDATE devices SET firmware_update_available = $1, latest_ros_version = $2, updated_at = NOW() WHERE id = $3`,
      [hasUpdate, latestVersion || null, deviceRow.id]
    );

    return res.json(updateInfo);
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/install-update
router.post('/:id/install-update', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.installUpdate();
    // Clear the update flag — device is rebooting with new firmware
    await query(
      `UPDATE devices SET firmware_update_available = FALSE, updated_at = NOW() WHERE id = $1`,
      [deviceRow.id]
    );
    return res.json({ message: 'Update installation initiated. Device will reboot.' });
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/reboot
router.post('/:id/reboot', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.reboot();
    return res.json({ message: 'Reboot command sent. Device will restart shortly.' });
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/clock
router.get('/:id/clock', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const clock = await collector.getClockConfig();
    return res.json(clock);
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/clock
router.put('/:id/clock', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.setClockConfig(req.body);
    return res.json({ message: 'Clock updated' });
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/routing (add static route)
router.post('/:id/routing', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const { dst_address, gateway, distance, comment } = req.body;
  if (!dst_address || !gateway) {
    return res.status(400).json({ error: 'dst_address and gateway are required' });
  }

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addRoute(dst_address, gateway, distance, comment);
    return res.status(201).json({ message: 'Route added' });
  } finally {
    collector.disconnect();
  }
});

// DELETE /api/devices/:id/routing/:routeId
router.delete('/:id/routing/:routeId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeRoute(req.params.routeId);
    return res.json({ message: 'Route removed' });
  } finally {
    collector.disconnect();
  }
});

// ─── OSPF ─────────────────────────────────────────────────────────────────────
router.get('/:id/routing/ospf', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    return res.json(await collector.getOspfData());
  } finally { collector.disconnect(); }
});

router.post('/:id/routing/ospf/instance', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addOspfInstance(req.body);
    return res.status(201).json(await collector.getOspfData());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

router.delete('/:id/routing/ospf/instance/:itemId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeOspfInstance(decodeURIComponent(req.params.itemId));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

router.post('/:id/routing/ospf/area', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addOspfArea(req.body);
    return res.status(201).json(await collector.getOspfData());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

router.delete('/:id/routing/ospf/area/:itemId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeOspfArea(decodeURIComponent(req.params.itemId));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

// ─── BGP ──────────────────────────────────────────────────────────────────────
router.get('/:id/routing/bgp', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    return res.json(await collector.getBgpData());
  } finally { collector.disconnect(); }
});

router.post('/:id/routing/bgp/connection', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addBgpConnection(req.body);
    return res.status(201).json(await collector.getBgpData());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

router.delete('/:id/routing/bgp/connection/:itemId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeBgpConnection(decodeURIComponent(req.params.itemId));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

// ─── Routing Tables ───────────────────────────────────────────────────────────
router.get('/:id/routing/tables', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    return res.json(await collector.getRoutingTablesData());
  } finally { collector.disconnect(); }
});

router.post('/:id/routing/tables', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addRoutingTable(req.body);
    return res.status(201).json(await collector.getRoutingTablesData());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

router.delete('/:id/routing/tables/:itemId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeRoutingTable(decodeURIComponent(req.params.itemId));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

// ─── Route Filters ────────────────────────────────────────────────────────────
router.get('/:id/routing/filters', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    return res.json(await collector.getRouteFiltersData());
  } finally { collector.disconnect(); }
});

router.post('/:id/routing/filters/rule', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addFilterRule(req.body);
    return res.status(201).json(await collector.getRouteFiltersData());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

router.put('/:id/routing/filters/rule/:itemId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.updateFilterRule(decodeURIComponent(req.params.itemId), req.body);
    return res.json(await collector.getRouteFiltersData());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

router.delete('/:id/routing/filters/rule/:itemId', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeFilterRule(decodeURIComponent(req.params.itemId));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally { collector.disconnect(); }
});

// ─── Router IDs ───────────────────────────────────────────────────────────────
router.get('/:id/routing/router-id', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    return res.json(await collector.getRouterIds());
  } finally { collector.disconnect(); }
});

// POST /api/devices/:id/vlans (add bridge VLAN)
router.post('/:id/vlans', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const { bridge, vlan_id, tagged_ports = [], untagged_ports = [] } = req.body;
  if (!bridge || !vlan_id || vlan_id < 1 || vlan_id > 4094) {
    return res.status(400).json({ error: 'bridge and vlan_id (1-4094) are required' });
  }

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addBridgeVlan(bridge, vlan_id, tagged_ports, untagged_ports);
    await collector.collectVlans();
    const vlans = await query(`SELECT * FROM vlans WHERE device_id = $1 ORDER BY vlan_id ASC`, [req.params.id]);
    return res.status(201).json(vlans);
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/vlans/:vlanDbId (update tagged/untagged ports)
router.put('/:id/vlans/:vlanDbId', requireWrite, async (req: Request, res: Response) => {
  const vlan = await queryOne<{ id: number; vlan_id: number; bridge: string }>(
    `SELECT id, vlan_id, bridge FROM vlans WHERE id = $1 AND device_id = $2`,
    [req.params.vlanDbId, req.params.id]
  );
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });

  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const { tagged_ports = [], untagged_ports = [] } = req.body;

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.updateBridgeVlan(vlan.bridge, vlan.vlan_id, tagged_ports, untagged_ports);
    await collector.collectVlans();
    const vlans = await query(`SELECT * FROM vlans WHERE device_id = $1 ORDER BY vlan_id ASC`, [req.params.id]);
    return res.json(vlans);
  } finally {
    collector.disconnect();
  }
});

// DELETE /api/devices/:id/vlans/:vlanDbId
router.delete('/:id/vlans/:vlanDbId', requireWrite, async (req: Request, res: Response) => {
  const vlan = await queryOne<{ vlan_id: number; bridge: string }>(
    `SELECT vlan_id, bridge FROM vlans WHERE id = $1 AND device_id = $2`,
    [req.params.vlanDbId, req.params.id]
  );
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });

  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.removeBridgeVlan(vlan.bridge, vlan.vlan_id);
    await query(`DELETE FROM vlans WHERE id = $1`, [req.params.vlanDbId]);
    return res.json({ message: 'VLAN removed' });
  } finally {
    collector.disconnect();
  }
});

// ─── Bond (LAG / LACP) routes ────────────────────────────────────────────────

// POST /api/devices/:id/bonds
router.post('/:id/bonds', requireWrite, async (req: Request, res: Response) => {
  const { name, mode, slaves, lacp_rate, transmit_hash_policy, mtu, min_links } = req.body;
  if (!name || !mode || !Array.isArray(slaves) || slaves.length < 2) {
    return res.status(400).json({ error: 'name, mode, and at least 2 slaves are required' });
  }
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.createBond(name, slaves, mode, {
      lacpRate: lacp_rate, hashPolicy: transmit_hash_policy, mtu, minLinks: min_links,
    });
    await collector.collectInterfaces();
    const ports = await query(`SELECT * FROM interfaces WHERE device_id = $1 ORDER BY name`, [req.params.id]);
    return res.status(201).json(ports.find((p: Record<string, unknown>) => p['name'] === name) ?? { message: 'Bond created' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/bonds/:bondName
router.put('/:id/bonds/:bondName', requireWrite, async (req: Request, res: Response) => {
  const { mode, slaves, lacp_rate, transmit_hash_policy, mtu, min_links } = req.body;
  if (!mode || !Array.isArray(slaves) || slaves.length < 1) {
    return res.status(400).json({ error: 'mode and slaves are required' });
  }
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.updateBond(req.params.bondName, slaves, mode, {
      lacpRate: lacp_rate, hashPolicy: transmit_hash_policy, mtu, minLinks: min_links,
    });
    await collector.collectInterfaces();
    return res.json({ message: 'Bond updated' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// DELETE /api/devices/:id/bonds/:bondName
router.delete('/:id/bonds/:bondName', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.deleteBond(req.params.bondName);
    await query(`DELETE FROM interfaces WHERE device_id = $1 AND name = $2`, [req.params.id, req.params.bondName]);
    await collector.collectInterfaces();
    return res.json({ message: 'Bond deleted' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/bridge/:bridgeName/vlan-filtering
router.put('/:id/bridge/:bridgeName/vlan-filtering', requireWrite, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled: boolean };
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.setBridgeVlanFiltering(req.params.bridgeName, Boolean(enabled));
    await collector.collectInterfaces();
    return res.json({ success: true, vlan_filtering: enabled });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/hardware (live health: temps, voltages, fans, PSU)
router.get('/:id/hardware', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const health = await collector.getHardware();
    return res.json(health);
  } finally {
    collector.disconnect();
  }
});

// GET /api/devices/:id/wireless — cached wireless interfaces from postgres (for Radios tab)
router.get('/:id/wireless', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT * FROM wireless_interfaces WHERE device_id = $1 ORDER BY name ASC`,
    [req.params.id]
  );
  return res.json(rows);
});

// GET /api/devices/:id/wireless/metrics — InfluxDB wireless_stats time series
router.get('/:id/wireless/metrics', async (req: Request, res: Response) => {
  const { iface, range = '6h' } = req.query as { iface?: string; range?: string };

  const ranges: Record<string, string> = {
    '1h': '1h', '3h': '3h', '6h': '6h', '12h': '12h', '24h': '24h', '7d': '7d',
  };
  const fluxRange = ranges[range] || '6h';

  const { getQueryApi } = await import('../config/influxdb');
  const queryApi = getQueryApi();

  const org = process.env.INFLUXDB_ORG || 'mikrotik';
  const bucket = process.env.INFLUXDB_BUCKET || 'mikrotik';

  const ifaceFilter = iface
    ? `|> filter(fn: (r) => r["interface"] == "${iface}")`
    : '';

  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -${fluxRange})
      |> filter(fn: (r) => r["_measurement"] == "wireless_stats")
      |> filter(fn: (r) => r["device_id"] == "${req.params.id}")
      ${ifaceFilter}
      |> filter(fn: (r) => r["_field"] == "registered_clients" or r["_field"] == "noise_floor")
      |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
      |> pivot(rowKey:["_time","interface","ssid"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"])
  `;

  try {
    const rows: { time: string; interface: string; ssid?: string; registered_clients?: number; noise_floor?: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      queryApi.queryRows(flux, {
        next(row, tableMeta) {
          const obj = tableMeta.toObject(row) as Record<string, unknown>;
          rows.push({
            time: String(obj['_time'] || obj['time'] || ''),
            interface: String(obj['interface'] || ''),
            ssid: obj['ssid'] ? String(obj['ssid']) : undefined,
            registered_clients: obj['registered_clients'] != null ? Number(obj['registered_clients']) : undefined,
            noise_floor: obj['noise_floor'] != null ? Number(obj['noise_floor']) : undefined,
          });
        },
        error: reject,
        complete: resolve,
      });
    });
    return res.json(rows);
  } catch (err) {
    console.error('Wireless metrics InfluxDB error:', err);
    return res.json([]);
  }
});

// POST /api/devices/:id/test
router.post('/:id/test', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const client = new RouterOSClient(
    deviceRow.ip_address, deviceRow.api_port,
    deviceRow.api_username, decrypt(deviceRow.api_password_encrypted), 8000
  );
  try {
    await client.connect();
    const identity = await client.execute('/system/identity/print');
    client.disconnect();
    return res.json({ success: true, identity: identity[0]?.['name'] });
  } catch (err) {
    client.disconnect();
    return res.status(422).json({ success: false, error: (err as Error).message });
  }
});

// ─── Network Tools ─────────────────────────────────────────────────────────
// Tools use a long read-timeout (120s) since ping/traceroute/ip-scan can take time.

async function getToolDevice(id: string) {
  return queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
}

function makeToolClient(device: DeviceRow): RouterOSClient {
  return new RouterOSClient(
    device.ip_address, device.api_port, device.api_username,
    decrypt(device.api_password_encrypted),
    15_000,   // connect timeout
    120_000   // read timeout — traceroute/ip-scan can take a while
  );
}

// POST /api/devices/:id/tools/ping
router.post('/:id/tools/ping', requireWrite, async (req: Request, res: Response) => {
  const { address, count, interface: iface } = req.body as { address?: string; count?: number; interface?: string };
  if (!address) return res.status(400).json({ error: 'address is required' });

  const device = await getToolDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const client = makeToolClient(device);
  try {
    await client.connect();
    const params: Record<string, string> = {
      address,
      count: String(Math.min(Math.max(1, Number(count) || 4), 20)),
    };
    if (iface) params['interface'] = iface;
    const results = await client.execute('/tool/ping', params);
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    client.disconnect();
  }
});

// POST /api/devices/:id/tools/traceroute
router.post('/:id/tools/traceroute', requireWrite, async (req: Request, res: Response) => {
  const { address } = req.body as { address?: string };
  if (!address) return res.status(400).json({ error: 'address is required' });

  const device = await getToolDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const client = makeToolClient(device);
  try {
    await client.connect();
    const raw = await client.execute('/tool/traceroute', { address, count: '3', timeout: '1' });

    // RouterOS sends multiple !re updates per hop as probes return.
    // Deduplicate by .id, keeping the last (most complete) row per hop.
    const byId = new Map<string, Record<string, string>>();
    for (const row of raw) {
      if (row['id']) byId.set(row['id'], row);
    }
    const results = Array.from(byId.values()).sort(
      (a, b) => Number(a['id'] || 0) - Number(b['id'] || 0)
    );
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    client.disconnect();
  }
});

// POST /api/devices/:id/tools/ip-scan
router.post('/:id/tools/ip-scan', requireWrite, async (req: Request, res: Response) => {
  const { addressRange, interface: iface, rdns } = req.body as {
    addressRange?: string;
    interface?: string;
    rdns?: boolean;
  };
  if (!addressRange) return res.status(400).json({ error: 'addressRange is required' });
  if (!iface) return res.status(400).json({ error: 'interface is required' });

  const device = await getToolDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const client = makeToolClient(device);
  try {
    await client.connect();
    // /tool/ip-scan is a generator — it never sends !done on its own.
    // Use executeStreaming to collect results for up to 30s then cancel.
    const raw = await client.executeStreaming('/tool/ip-scan', {
      'address-range': addressRange,
      interface: iface,
    }, 30_000);

    // ip-scan re-emits the same host on every rescan cycle — deduplicate by address,
    // keeping the last-seen entry (RouterOS updates fields like status over time).
    const seen = new Map<string, Record<string, string>>();
    for (const entry of raw) {
      const key = entry['address'] ?? JSON.stringify(entry);
      seen.set(key, entry);
    }
    const results = Array.from(seen.values());

    if (!rdns) return res.json(results);

    // Perform reverse DNS lookups concurrently on all discovered IPs.
    const { reverse } = await import('dns/promises');
    const enriched = await Promise.all(
      results.map(async (r) => {
        const ip = r['address'];
        if (!ip) return { ...r, hostname: '' };
        try {
          const names = await reverse(ip);
          return { ...r, hostname: names[0] ?? '' };
        } catch {
          return { ...r, hostname: '' };
        }
      })
    );
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    client.disconnect();
  }
});

// POST /api/devices/:id/tools/wol
router.post('/:id/tools/wol', requireWrite, async (req: Request, res: Response) => {
  const { mac, interface: iface } = req.body as { mac?: string; interface?: string };
  if (!mac) return res.status(400).json({ error: 'mac is required' });
  if (!iface) return res.status(400).json({ error: 'interface is required' });

  // Basic MAC validation
  if (!/^([0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'Invalid MAC address format' });
  }

  const device = await getToolDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const client = makeToolClient(device);
  try {
    await client.connect();
    await client.execute('/tool/wol', { mac, interface: iface });
    return res.json({ success: true, message: `WoL magic packet sent to ${mac} on ${iface}` });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    client.disconnect();
  }
});

export default router;
