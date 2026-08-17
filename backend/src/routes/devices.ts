import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { Client as SshClient } from 'ssh2';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { encrypt, decrypt } from '../utils/crypto';
import { RouterOSClient } from '../services/mikrotik/RouterOSClient';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import { PollerService } from '../services/PollerService';
import type { CredentialPresetRow } from './credentialPresets';
import { createDeviceFromBody, type CreateDeviceInput, type CreateDeviceContext } from '../services/deviceCreation';
import { parsePort } from '../utils/parsePort';
import { safeConnectionError } from '../utils/safeClientError';
import { detectLockoutRisk } from '../utils/firewallSafety';
import { withSafeApply, type GuardDevice } from '../services/changeGuard/ChangeGuard';
import { captureSnapshot, resolveManagementPath } from '../services/changeGuard/pathModel';
import { analyzeChange, type PlannedChange } from '../services/changeGuard/analyzeChange';
import { redis } from '../config/redis';
import { enqueueBulkAddJob, getBulkAddJobState } from '../services/DeviceBulkAddWorker';

// Resolve a credential preset id into decrypted credentials. Returns null if
// no id was provided; throws a readable error if the id is invalid.
async function loadCredentialPreset(
  id: number | null | undefined,
  ctx?: CreateDeviceContext
): Promise<{
  api_username: string;
  api_password: string;
  api_port: number | null;
  ssh_username: string | null;
  ssh_password: string | null;
  ssh_port: number | null;
} | null> {
  if (id === null || id === undefined) return null;
  const preset = await queryOne<CredentialPresetRow>(
    `SELECT * FROM credential_presets WHERE id = $1`,
    [id]
  );
  if (!preset) throw new Error(`Credential preset ${id} not found`);
  const allowOp = preset.allow_operator_use !== false;
  if (ctx?.requestingUserRole === 'operator' && !allowOp) {
    const err = new Error('This credential preset is restricted to administrators');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
  return {
    api_username: preset.api_username,
    api_password: decrypt(preset.api_password_encrypted),
    api_port: preset.api_port,
    ssh_username: preset.ssh_username,
    ssh_password: preset.ssh_password_encrypted ? decrypt(preset.ssh_password_encrypted) : null,
    ssh_port: preset.ssh_port,
  };
}

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
            routerboard_upgrade_available, upgrade_firmware_version,
            device_type, status, last_seen, notes,
            location_address, location_lat::float8 AS location_lat, location_lng::float8 AS location_lng,
            rack_name, rack_slot, created_at
     FROM devices ORDER BY name ASC`
  );

  // Attach tags to each device
  const tagRows = await query<{ device_id: number; id: number; name: string; color: string }>(
    `SELECT dt.device_id, t.id, t.name, t.color
     FROM device_tags dt JOIN tags t ON t.id = dt.tag_id`
  );
  const tagsByDevice: Record<number, { id: number; name: string; color: string }[]> = {};
  for (const t of tagRows) {
    if (!tagsByDevice[t.device_id]) tagsByDevice[t.device_id] = [];
    tagsByDevice[t.device_id].push({ id: t.id, name: t.name, color: t.color });
  }
  const result = (devices as { id: number }[]).map((d) => ({
    ...d,
    tags: tagsByDevice[d.id] ?? [],
  }));

  res.json(result);
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

  // Build lookup tables for "is this actually a managed device we already know?"
  // We match a discovered neighbor to a managed device by any of:
  //   - its MAC matching any interface MAC of a managed device,
  //   - its IP matching the managed device's primary ip_address,
  //   - its identity matching the managed device's name.
  const [managedByMac, managedByIp, managedByName] = await Promise.all([
    query<{ device_id: number; device_name: string; mac: string }>(
      `SELECT i.device_id AS device_id, d.name AS device_name, LOWER(i.mac_address) AS mac
         FROM interfaces i
         JOIN devices d ON d.id = i.device_id
        WHERE i.mac_address IS NOT NULL AND i.mac_address <> ''`
    ),
    query<{ id: number; name: string; ip_address: string }>(
      `SELECT id, name, ip_address FROM devices WHERE ip_address IS NOT NULL AND ip_address <> ''`
    ),
    query<{ id: number; name: string }>(
      `SELECT id, name FROM devices WHERE name IS NOT NULL AND name <> ''`
    ),
  ]);
  const macToDevice = new Map<string, { id: number; name: string }>();
  for (const r of managedByMac) macToDevice.set(r.mac, { id: r.device_id, name: r.device_name });
  const ipToDevice = new Map<string, { id: number; name: string }>();
  for (const r of managedByIp) ipToDevice.set(r.ip_address, { id: r.id, name: r.name });
  const nameToDevice = new Map<string, { id: number; name: string }>();
  for (const r of managedByName) nameToDevice.set(r.name.toLowerCase(), { id: r.id, name: r.name });

  // Deduplicate across all three identifiers so that a neighbor seen by multiple managed
  // devices — some via LLDP (has MAC), others via MNDP (no MAC) — merges into one entry.
  // Three indexes cross-reference mac/ip/identity to the canonical dedup key.
  const seen = new Map<string, typeof rows[0] & { seen_by_list: string[] }>();
  const macIdx = new Map<string, string>();      // normalised-mac  → canonical key
  const ipIdx  = new Map<string, string>();      // ip              → canonical key
  const nameIdx = new Map<string, string>();     // lower-identity  → canonical key

  for (const row of rows) {
    const mac      = (row.neighbor_mac  || '').toLowerCase();
    const ip       = row.neighbor_address || '';
    const identity = (row.neighbor_identity || '').toLowerCase();

    // Find whether any identifier matches something already in the map
    const existingKey =
      (mac      && macIdx.get(mac))   ||
      (ip       && ipIdx.get(ip))     ||
      (identity && nameIdx.get(identity));

    if (existingKey) {
      const existing = seen.get(existingKey)!;
      if (row.seen_by && !existing.seen_by_list.includes(row.seen_by)) {
        existing.seen_by_list.push(row.seen_by);
      }
      // Register any newly-learned identifiers against the same key
      if (mac      && !macIdx.has(mac))       macIdx.set(mac,      existingKey);
      if (ip       && !ipIdx.has(ip))          ipIdx.set(ip,        existingKey);
      if (identity && !nameIdx.has(identity)) nameIdx.set(identity, existingKey);
    } else {
      const key = mac || ip || identity;
      if (!key) continue;
      seen.set(key, { ...row, seen_by_list: row.seen_by ? [row.seen_by] : [] });
      if (mac)      macIdx.set(mac,      key);
      if (ip)       ipIdx.set(ip,        key);
      if (identity) nameIdx.set(identity, key);
    }
  }

  const results = Array.from(seen.values()).map((r) => {
    const mac = (r.neighbor_mac || '').toLowerCase();
    const match =
      (mac && macToDevice.get(mac)) ||
      (r.neighbor_address && ipToDevice.get(r.neighbor_address)) ||
      (r.neighbor_identity && nameToDevice.get(r.neighbor_identity.toLowerCase())) ||
      null;
    return {
      identity: r.neighbor_identity || '',
      address: r.neighbor_address || '',
      mac_address: r.neighbor_mac || '',
      platform: r.neighbor_platform || '',
      discovered_at: r.discovered_at,
      seen_by: r.seen_by_list.join(', '),
      duplicate_of_device_id: match ? match.id : null,
      duplicate_of_device_name: match ? match.name : null,
    };
  });

  res.json(results);
});

// POST /api/devices
router.post('/', requireWrite, async (req: Request, res: Response) => {
  const result = await createDeviceFromBody(req.body, pollerService, {
    requestingUserRole: req.user?.role,
  });
  return res.status(result.status).json(result.body);
});

const BULK_ADD_META_TTL_SEC = 86400;

// POST /api/devices/bulk-add/jobs — enqueue Try-All style adds (survives tab close)
router.post('/bulk-add/jobs', requireWrite, async (req: Request, res: Response) => {
  const { items } = req.body as { items?: unknown };
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  if (items.length > 500) {
    return res.status(400).json({ error: 'items array exceeds maximum of 500' });
  }
  const jobId = randomUUID();
  const ownerUserId = req.user!.userId;
  await redis.set(
    `device-bulk-add:${jobId}:meta`,
    JSON.stringify({
      status: 'queued',
      total: items.length,
      processed: 0,
      owner_user_id: ownerUserId,
      created_at: new Date().toISOString(),
    }),
    'EX',
    BULK_ADD_META_TTL_SEC
  );
  await redis.set(`device-bulk-add:${jobId}:results`, '[]', 'EX', BULK_ADD_META_TTL_SEC);
  await enqueueBulkAddJob(jobId, items as CreateDeviceInput[]);
  return res.status(202).json({ job_id: jobId, total: items.length });
});

// POST /api/devices/bulk-add/jobs/:jobId/cancel — request cooperative cancel
router.post('/bulk-add/jobs/:jobId/cancel', requireWrite, async (req: Request, res: Response) => {
  const state = await getBulkAddJobState(req.params.jobId);
  if (!state.found) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }
  const ownerId = state.meta.owner_user_id;
  if (typeof ownerId !== 'number' || ownerId !== req.user!.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await redis.set(`device-bulk-add:${req.params.jobId}:cancel`, '1', 'EX', BULK_ADD_META_TTL_SEC);
  return res.json({ message: 'Cancel requested' });
});

// GET /api/devices/bulk-add/jobs/:jobId — poll job status and incremental results
router.get('/bulk-add/jobs/:jobId', requireWrite, async (req: Request, res: Response) => {
  const state = await getBulkAddJobState(req.params.jobId);
  if (!state.found) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }
  const ownerId = state.meta.owner_user_id;
  if (typeof ownerId !== 'number' || ownerId !== req.user!.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return res.json({
    job_id: req.params.jobId,
    ...state.meta,
    results: state.results,
  });
});

// GET /api/devices/:id
router.get('/:id', async (req: Request, res: Response) => {
  const device = await queryOne(
    `SELECT id, name, ip_address, api_port, api_username, ssh_port, ssh_username, model,
            serial_number, firmware_version, ros_version, latest_ros_version,
            firmware_update_available, routerboard_upgrade_available, upgrade_firmware_version,
            device_type, status, last_seen,
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
  const { name, ip_address, device_type, notes, credential_preset_id } = req.body as {
    name?: string;
    ip_address?: string;
    device_type?: string;
    notes?: string;
    credential_preset_id?: number | null;
  };

  const existing = await queryOne<{
    id: number;
    ip_address: string;
    api_port: number;
    api_username: string;
    api_password_encrypted: string;
    ssh_port: number | null;
  }>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted, ssh_port
       FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!existing) return res.status(404).json({ error: 'Device not found' });

  let preset: Awaited<ReturnType<typeof loadCredentialPreset>>;
  try {
    preset = await loadCredentialPreset(credential_preset_id ?? null, {
      requestingUserRole: req.user?.role,
    });
  } catch (err) {
    const status = (err as Error & { statusCode?: number }).statusCode ?? 400;
    return res.status(status).json({ error: (err as Error).message });
  }

  // When a preset is applied, its values take precedence over anything else
  // in the body so "apply preset" has a single unambiguous meaning.
  const api_port = preset?.api_port ?? parsePort(req.body.api_port, existing.api_port);
  const api_username = preset?.api_username ?? req.body.api_username;
  const api_password = preset?.api_password ?? req.body.api_password;
  const ssh_port = preset?.ssh_port ?? parsePort(req.body.ssh_port, existing.ssh_port ?? 22);
  const ssh_username = preset ? preset.ssh_username : req.body.ssh_username;
  const ssh_password = preset ? preset.ssh_password : req.body.ssh_password;

  // If the user is changing the IP (or port / username / password), verify the
  // RouterOS API is still reachable with the new values before persisting —
  // otherwise we could silently brick the device record.
  const ipChanged = typeof ip_address === 'string' && ip_address && ip_address !== existing.ip_address;
  const portChanged = typeof api_port === 'number' && api_port !== existing.api_port;
  const userChanged = typeof api_username === 'string' && api_username && api_username !== existing.api_username;
  const presetReplacesApiCreds = !!preset;
  if (ipChanged || portChanged || userChanged || api_password || presetReplacesApiCreds) {
    const testIp = ip_address ?? existing.ip_address;
    const testPort = api_port;
    const testUser = api_username ?? existing.api_username;
    const testPass = api_password ? api_password : decrypt(existing.api_password_encrypted);
    const testClient = new RouterOSClient(testIp, testPort, testUser, testPass, 10_000);
    try {
      await testClient.connect();
      testClient.disconnect();
    } catch (err) {
      return res.status(422).json({
        error: safeConnectionError('PUT /devices/:id', err),
      });
    }
  }

  const encPass = api_password ? encrypt(api_password) : existing.api_password_encrypted;
  const encSshPass = ssh_password ? encrypt(ssh_password) : null;

  await query(
    `UPDATE devices SET
       name=COALESCE($1,name), ip_address=COALESCE($2,ip_address),
       api_port=COALESCE($3,api_port),
       api_username=COALESCE($4,api_username), api_password_encrypted=$5,
       ssh_port=COALESCE($6,ssh_port), ssh_username=COALESCE($7,ssh_username),
       ssh_password_encrypted=COALESCE($8,ssh_password_encrypted),
       device_type=COALESCE($9,device_type), notes=COALESCE($10,notes),
       updated_at=NOW()
     WHERE id = $11`,
    [name, ip_address, api_port, api_username, encPass, ssh_port, ssh_username, encSshPass, device_type, notes, req.params.id]
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
// Guarded: changing a port's PVID or its tagged/untagged membership is one of the
// most common ways to strand the management VLAN on a switch.
router.put('/:id/ports/:name/vlan', requireWrite, async (req: Request, res: Response) => {
  const { pvid, tagged_vlans = [], untagged_vlans = [] } = req.body;
  if (pvid !== undefined && (typeof pvid !== 'number' || pvid < 1 || pvid > 4094)) {
    return res.status(400).json({ error: 'pvid must be 1-4094' });
  }

  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'port.vlan',
      summary: `VLAN config on port ${req.params.name} (pvid ${pvid ?? 1})`,
      change: {
        kind: 'port.vlan',
        port: req.params.name,
        pvid: pvid ?? 1,
        tagged: tagged_vlans as number[],
        untagged: untagged_vlans as number[],
      },
    },
    async (c) => {
      await c.setPortVlanConfig(
        req.params.name,
        pvid ?? 1,
        tagged_vlans as number[],
        untagged_vlans as number[]
      );
      return { message: 'VLAN configuration applied' };
    },
    async (c) => { await c.collectVlans(); }
  );
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

// GET /api/devices/:id/ports/:name/clients — clients on this port.
//
// The bridge FDB lists every MAC *reachable through* a port, so on an
// uplink/trunk it shows the whole network. We classify the port and, by
// default, only return clients that are genuinely *physically* connected
// (a single access VLAN, no infra neighbour, not an aggregation point).
// Pass ?all=true to get the raw FDB list regardless (the "view MAC table"
// disclosure in the UI).
const UPLINK_MAC_THRESHOLD = 8;
router.get('/:id/ports/:name/clients', async (req: Request, res: Response) => {
  const all = req.query.all === 'true';
  const rows = await query<{
    mac_address: string; hostname: string | null; custom_name: string | null;
    vendor: string | null; ip_address: string | null; client_type: string;
    vlan_id: number | null; signal_strength: number | null;
    first_seen: string | null; last_seen: string | null;
  }>(`
    SELECT mac_address, hostname, custom_name, vendor, ip_address, client_type,
           vlan_id, signal_strength, first_seen, last_seen
    FROM clients
    WHERE device_id = $1 AND interface_name = $2 AND active = TRUE
    ORDER BY COALESCE(NULLIF(custom_name, ''), hostname, mac_address) ASC
  `, [req.params.id, req.params.name]);

  // A discovered LLDP/MNDP neighbour on this interface means it links to
  // another managed device → definitively an uplink.
  const neighbor = await queryOne<{ neighbor_identity: string | null; neighbor_platform: string | null }>(
    `SELECT neighbor_identity, neighbor_platform FROM topology_links
     WHERE from_device_id = $1 AND from_interface = $2
     ORDER BY (neighbor_identity IS NOT NULL) DESC LIMIT 1`,
    [req.params.id, req.params.name]
  );

  const macCount = rows.length;
  const vlanCount = new Set(rows.filter(r => r.vlan_id != null).map(r => r.vlan_id)).size;

  let classification: 'access' | 'uplink' = 'access';
  let reason = '';
  if (neighbor) {
    classification = 'uplink';
    reason = `Links to ${neighbor.neighbor_identity || 'another device'}`;
  } else if (vlanCount > 1) {
    classification = 'uplink';
    reason = `MACs seen across ${vlanCount} VLANs — carrying tagged/trunk traffic`;
  } else if (macCount > UPLINK_MAC_THRESHOLD) {
    classification = 'uplink';
    reason = `${macCount} MAC addresses reachable through this port`;
  }

  res.json({
    classification,
    reason,
    mac_count: macCount,
    vlan_count: vlanCount,
    neighbor: neighbor || null,
    // Physically-connected view hides everything on an uplink; ?all=true returns the raw FDB.
    clients: all || classification === 'access' ? rows : [],
  });
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
  const { chain, action, force } = req.body;
  if (!chain || !action) return res.status(400).json({ error: 'chain and action are required' });
  const params = bodyToRosParams(req.body);
  // Safe-apply: refuse a self-lockout rule unless the operator confirms (force).
  if (!force) {
    const lock = detectLockoutRisk(params);
    if (lock.risky) return res.status(409).json({ lockout: true, reason: lock.reason });
  }
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.addFirewallRule(params);
    return res.status(201).json(await collector.getFirewallRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// PUT /api/devices/:id/firewall/:ruleId
router.put('/:id/firewall/:ruleId', requireWrite, async (req: Request, res: Response) => {
  const params = bodyToRosParams(req.body);
  if (!req.body.force) {
    const lock = detectLockoutRisk(params);
    if (lock.risky) return res.status(409).json({ lockout: true, reason: lock.reason });
  }
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.updateFirewallRule(req.params.ruleId, params);
    return res.json(await collector.getFirewallRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/firewall/move  { id, destination? }
router.post('/:id/firewall/move', requireWrite, async (req: Request, res: Response) => {
  const { id, destination } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.moveFirewallRule(String(id), destination ? String(destination) : undefined);
    return res.json(await collector.getFirewallRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/firewall/reset-counters
router.post('/:id/firewall/reset-counters', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.resetFirewallCounters();
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

// POST /api/devices/:id/nat/move  { id, destination? }
router.post('/:id/nat/move', requireWrite, async (req: Request, res: Response) => {
  const { id, destination } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.moveNatRule(String(id), destination ? String(destination) : undefined);
    return res.json(await collector.getNatRules());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

// ─── Firewall Address Lists ─────────────────────────────────────────────────────
// Shared helper for the security-feature routes below (DRYs the device fetch +
// connect/disconnect lifecycle the rest of this file uses inline).
/**
 * Run a device mutation under the Change Guard safety net (see
 * services/changeGuard/ChangeGuard.ts): the device saves a restore point and arms
 * a self-restore before the change, and disarms it only once we prove the device
 * is still reachable. Used for changes that can sever the manager's own path.
 *
 * The response always carries a `guard` block so the UI can say whether the change
 * was confirmed, is being auto-reverted, or ran unprotected.
 */
async function withGuardedChange<T>(
  id: string,
  req: Request,
  res: Response,
  meta: { kind: string; summary: string; change?: PlannedChange },
  fn: (c: DeviceCollector) => Promise<T>,
  afterConfirmed?: (c: DeviceCollector) => Promise<void>
): Promise<void> {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!deviceRow) { res.status(404).json({ error: 'Device not found' }); return; }

  // Pre-flight: simulate the change against live state and refuse a predicted
  // lockout unless the user has explicitly accepted it. Analysis failures must
  // never block a legitimate change — the auto-revert net still applies.
  if (meta.change && req.body?.confirm_lockout !== true) {
    try {
      const snap = await captureSnapshot(deviceRow as unknown as GuardDevice);
      const verdict = analyzeChange(snap, deviceRow as unknown as GuardDevice, meta.change);
      if (verdict.severity === 'critical') {
        res.status(409).json({
          lockout: true,
          reason: verdict.headline,
          verdict: {
            severity: verdict.severity,
            headline: verdict.headline,
            violations: verdict.violations,
            warnings: verdict.warnings,
            path: {
              mgmt_interface: verdict.path.mgmtInterface,
              bridge: verdict.path.bridge,
              mgmt_vlan_id: verdict.path.mgmtVlanId,
              tagged_management: verdict.path.taggedManagement,
              ingress_port: verdict.path.ingressPort,
              ingress_port_source: verdict.path.ingressPortSource,
              hops: verdict.path.hops,
            },
          },
        });
        return;
      }
    } catch (err) {
      console.warn(`[preflight] analysis skipped for device ${id}: ${(err as Error).message}`);
    }
  }

  const collector = new DeviceCollector(deviceRow);
  try {
    const outcome = await withSafeApply(
      deviceRow as unknown as GuardDevice,
      { ...meta, userId: req.user?.userId ?? null },
      async () => {
        await collector.connect();
        return fn(collector);
      }
    );

    // Only re-read the device once we know it's still reachable.
    if (outcome.confirmed && afterConfirmed) {
      await afterConfirmed(collector).catch(() => { /* best effort */ });
    }

    res.json({
      ...(typeof outcome.result === 'object' && outcome.result !== null
        ? outcome.result as Record<string, unknown>
        : { result: outcome.result }),
      guard: {
        protected: !outcome.unprotectedReason,
        confirmed: outcome.confirmed,
        auto_reverting: outcome.autoReverting,
        unprotected_reason: outcome.unprotectedReason ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    try { collector.disconnect(); } catch { /* device may be gone */ }
  }
}

async function withCollector<T>(
  id: string,
  res: Response,
  fn: (c: DeviceCollector) => Promise<T>
): Promise<void> {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!deviceRow) { res.status(404).json({ error: 'Device not found' }); return; }
  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const result = await fn(collector);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
}

// GET /api/devices/:id/management-path — how the manager reaches this device, and
// which objects are therefore load-bearing. Read-only; useful on its own and as the
// explanation behind a lockout warning.
router.get('/:id/management-path', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  try {
    const snap = await captureSnapshot(deviceRow as unknown as GuardDevice);
    const path = resolveManagementPath(snap, deviceRow as unknown as GuardDevice);
    return res.json(path);
  } catch (err) {
    return res.status(502).json({ error: `Could not read device state: ${(err as Error).message}` });
  }
});

// POST /api/devices/:id/preflight — analyse a change WITHOUT applying it, so the UI
// can warn while the user is still editing. Body: { change: PlannedChange }.
router.post('/:id/preflight', requireWrite, async (req: Request, res: Response) => {
  const change = req.body?.change as PlannedChange | undefined;
  if (!change || typeof change !== 'object' || !('kind' in change)) {
    return res.status(400).json({ error: 'change (with a kind) is required' });
  }
  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });
  try {
    const snap = await captureSnapshot(deviceRow as unknown as GuardDevice);
    return res.json(analyzeChange(snap, deviceRow as unknown as GuardDevice, change));
  } catch (err) {
    return res.status(502).json({ error: `Could not read device state: ${(err as Error).message}` });
  }
});

router.get('/:id/address-lists', async (req, res) => {
  await withCollector(req.params.id, res, (c) => c.getAddressLists());
});

router.post('/:id/address-lists', requireWrite, async (req, res) => {
  const { list, address } = req.body;
  if (!list || !address) return res.status(400).json({ error: 'list and address are required' });
  const params: Record<string, string> = { list: String(list), address: String(address) };
  if (req.body.comment) params.comment = String(req.body.comment);
  if (req.body.timeout) params.timeout = String(req.body.timeout);
  await withCollector(req.params.id, res, async (c) => { await c.addAddressListEntry(params); return c.getAddressLists(); });
});

router.put('/:id/address-lists/:entryId', requireWrite, async (req, res) => {
  const params: Record<string, string> = {};
  for (const k of ['list', 'address', 'comment'] as const) if (req.body[k] !== undefined) params[k] = String(req.body[k]);
  if (req.body.disabled !== undefined) params.disabled = req.body.disabled ? 'yes' : 'no';
  await withCollector(req.params.id, res, async (c) => { await c.updateAddressListEntry(req.params.entryId, params); return c.getAddressLists(); });
});

router.delete('/:id/address-lists/:entryId', requireWrite, async (req, res) => {
  await withCollector(req.params.id, res, async (c) => { await c.removeAddressListEntry(req.params.entryId); return { message: 'Entry removed' }; });
});

// ─── Active Connections (read-only) ─────────────────────────────────────────────
router.get('/:id/connections', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || '500'), 10) || 500, 2000);
  await withCollector(req.params.id, res, async (c) => {
    const [rows, tracking] = await Promise.all([c.getConnections(), c.getConnectionTracking()]);
    // Connection tables can be huge; cap and surface the total so the UI can note truncation.
    return { total: rows.length, connections: rows.slice(0, limit), tracking };
  });
});

// ─── Simple Queues (bandwidth control) ──────────────────────────────────────────
const QUEUE_FIELD_MAP: Record<string, string> = {
  name: 'name', target: 'target', max_limit: 'max-limit', burst_limit: 'burst-limit',
  burst_threshold: 'burst-threshold', burst_time: 'burst-time', priority: 'priority',
  comment: 'comment', parent: 'parent',
};
function queueBodyToRos(body: Record<string, unknown>): Record<string, string> {
  const p: Record<string, string> = {};
  for (const [js, ros] of Object.entries(QUEUE_FIELD_MAP)) {
    const v = body[js];
    if (v !== undefined && v !== null && v !== '') p[ros] = String(v);
  }
  if (body.disabled !== undefined) p.disabled = body.disabled ? 'yes' : 'no';
  return p;
}

router.get('/:id/queues', async (req, res) => {
  await withCollector(req.params.id, res, (c) => c.getSimpleQueues());
});

router.post('/:id/queues', requireWrite, async (req, res) => {
  const { name, target, max_limit } = req.body;
  if (!name || !target || !max_limit) return res.status(400).json({ error: 'name, target and max_limit are required' });
  await withCollector(req.params.id, res, async (c) => { await c.addSimpleQueue(queueBodyToRos(req.body)); return c.getSimpleQueues(); });
});

router.put('/:id/queues/:queueId', requireWrite, async (req, res) => {
  await withCollector(req.params.id, res, async (c) => { await c.updateSimpleQueue(req.params.queueId, queueBodyToRos(req.body)); return c.getSimpleQueues(); });
});

router.delete('/:id/queues/:queueId', requireWrite, async (req, res) => {
  await withCollector(req.params.id, res, async (c) => { await c.removeSimpleQueue(req.params.queueId); return { message: 'Queue removed' }; });
});

// ─── IP Services + Security Posture audit ────────────────────────────────────────
router.get('/:id/services', async (req, res) => {
  await withCollector(req.params.id, res, (c) => c.getServices());
});

router.put('/:id/services/:serviceId', requireWrite, async (req, res) => {
  if (typeof req.body.disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) is required' });

  const deviceRow = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  // Disabling the very service MikroTik Manager talks to is an immediate, certain
  // self-lockout — and unlike other changes there is no legitimate way to do it
  // from here, so it is refused outright rather than merely guarded.
  if (req.body.disabled === true) {
    const mgmtService = deviceRow.api_port === 8729 ? 'api-ssl' : 'api';
    const collector = new DeviceCollector(deviceRow);
    try {
      await collector.connect();
      const services = await collector.getServices();
      const target = (services as Record<string, string>[]).find((s) => s['.id'] === req.params.serviceId);
      if (target && target['name'] === mgmtService) {
        return res.status(409).json({
          lockout: true,
          reason: `'${mgmtService}' is the service MikroTik Manager uses to reach this device. `
            + `Disabling it would make the device unmanageable from here.`,
        });
      }
    } catch { /* fall through to the guarded path */ } finally {
      collector.disconnect();
    }
  }

  await withGuardedChange(
    req.params.id,
    req,
    res,
    { kind: 'service.toggle', summary: `${req.body.disabled ? 'Disable' : 'Enable'} IP service` },
    async (c) => {
      await c.setServiceDisabled(req.params.serviceId, req.body.disabled);
      return { services: await c.getServices() };
    }
  );
});

// GET /api/devices/:id/security-posture — computes a hardening checklist.
// Heuristic, not standards-based: graduated weighting that won't saturate to 0,
// de-duplicated services, and it never proposes disabling the management
// service MikroTik Manager itself connects through (that would self-lockout).
router.get('/:id/security-posture', async (req, res) => {
  const device = await queryOne<DeviceRow & {
    firmware_update_available?: boolean;
    latest_ros_version?: string | null;
    routerboard_upgrade_available?: boolean;
    firmware_version?: string | null;
    upgrade_firmware_version?: string | null;
  }>(`SELECT * FROM devices WHERE id = $1`, [req.params.id]);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // Which RouterOS service the platform uses to reach this device. Default api
  // (8728); api-ssl is 8729. We must never offer to disable this one.
  const mgmtService = device.api_port === 8729 ? 'api-ssl' : 'api';
  const isRouter = device.device_type === 'router';

  await withCollector(req.params.id, res, async (c) => {
    const [servicesRaw, fwRules, snmp] = await Promise.all([
      c.getServices().catch(() => [] as Record<string, string>[]),
      c.getFirewallRules().catch(() => [] as Record<string, string>[]),
      c.getSnmpConfig().catch(() => ({} as Record<string, string>)),
    ]);

    // De-duplicate /ip/service rows by name (some devices report duplicates,
    // e.g. api/route_BFD twice) so a service is only ever counted once.
    const services = Array.from(new Map(servicesRaw.map(s => [s['name'] ?? s['.id'], s])).values());

    type Sev = 'high' | 'medium' | 'low';
    type Check = { id: string; severity: Sev; title: string; detail: string; serviceId?: string };
    const checks: Check[] = [];

    for (const s of services) {
      const name = s['name'] ?? '';
      if (s['disabled'] === 'true') continue;

      if (name === 'telnet' || name === 'ftp') {
        checks.push({ id: `service-${name}`, severity: 'high', serviceId: s['.id'],
          title: `Cleartext service "${name}" is enabled`,
          detail: `${name} sends credentials and data unencrypted. Disable it; use SSH/SFTP instead.` });
      } else if (name === 'www') {
        checks.push({ id: 'service-www', severity: 'medium', serviceId: s['.id'],
          title: 'Unencrypted WebFig (www) is enabled',
          detail: 'The HTTP WebFig interface is unencrypted. Disable "www" and use "www-ssl" (HTTPS) instead.' });
      } else if (name === 'api' && mgmtService !== 'api') {
        // Plaintext API is on but the platform connects via api-ssl — safe to flag/disable.
        checks.push({ id: 'service-api', severity: 'medium', serviceId: s['.id'],
          title: 'Unencrypted API (api) is enabled',
          detail: 'The plaintext RouterOS API is exposed. Disable "api" and use "api-ssl" (8729).' });
      } else if (name === mgmtService && name === 'api') {
        // The platform is connected through cleartext API — advise, but do NOT
        // offer to disable it (that would cut MikroTik Manager off the device).
        checks.push({ id: 'mgmt-api-cleartext', severity: 'low',
          title: 'MikroTik Manager connects over cleartext API',
          detail: 'This device is managed via the unencrypted API (8728). Consider migrating the device and its credentials to API-SSL (8729) for encrypted management.' });
      }
    }

    // Input-chain firewall: a real concern on routers; switches/APs commonly
    // (and legitimately) rely on an upstream router's firewall, so it's only
    // informational there rather than a high-severity hit.
    const hasInputDrop = fwRules.some(r => (r['chain'] === 'input') && ['drop', 'reject'].includes(r['action'] ?? '') && r['disabled'] !== 'true');
    if (!hasInputDrop) {
      checks.push({
        id: 'no-input-firewall', severity: isRouter ? 'high' : 'low',
        title: 'No input-chain firewall rule',
        detail: isRouter
          ? 'This router has no enabled drop/reject rule on the input chain, leaving its own services exposed. Add a baseline input firewall.'
          : 'No input-chain firewall on this device. Switches/APs often rely on an upstream router firewall — confirm that is the case.',
      });
    }

    if (snmp && snmp['enabled'] === 'true') {
      checks.push({ id: 'snmp-enabled', severity: 'low', title: 'SNMP is enabled',
        detail: 'Ensure SNMP uses a non-default community string and is restricted to trusted addresses.' });
    }

    // Outdated firmware is a security exposure: RouterOS releases routinely
    // ship security fixes, so a pending update counts against the posture.
    // Titles stay version-free so the Security Center's "Common Findings"
    // rollup aggregates devices on different versions into one row.
    if (device.firmware_update_available && device.latest_ros_version) {
      checks.push({
        id: 'firmware-outdated', severity: 'medium',
        title: 'RouterOS update available',
        detail: `This device runs RouterOS ${device.ros_version || '(unknown)'} but ${device.latest_ros_version} is available. RouterOS releases regularly include security fixes — review the changelog and schedule the upgrade from the Firmware section.`,
      });
    }
    if (device.routerboard_upgrade_available) {
      checks.push({
        id: 'routerboot-outdated', severity: 'low',
        title: 'RouterBOOT upgrade pending',
        detail: `The bootloader (${device.firmware_version || 'current'}) has an available upgrade${device.upgrade_firmware_version ? ` to ${device.upgrade_firmware_version}` : ''}. Apply it after the next RouterOS upgrade from the device's Config tab.`,
      });
    }

    // Graduated score: lighter weights + a floor of 5 so it never reads a hard
    // 0 (which falsely implies "maximally insecure"). It's a relative hardening
    // indicator, not an absolute grade.
    const WEIGHT: Record<Sev, number> = { high: 15, medium: 7, low: 3 };
    const penalty = checks.reduce((n, c2) => n + WEIGHT[c2.severity], 0);
    const score = checks.length === 0 ? 100 : Math.max(5, 100 - penalty);
    return { score, checks };
  });
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
  const { address, interface: iface } = req.body;
  if (!address || !iface) {
    return res.status(400).json({ error: 'address and interface are required' });
  }

  await withGuardedChange(
    req.params.id,
    req,
    res,
    { kind: 'ip.add', summary: `Add ${address} on ${iface}` },
    async (c) => {
      await c.addIpAddress(address, iface);
      return { message: `Address ${address} added` };
    },
    async (c) => { await c.collectIpAddressesCache(); }
  );
});

// DELETE /api/devices/:id/ip-addresses/:addrId
// Guarded: removing the address the manager connects to is an immediate, total cut.
router.delete('/:id/ip-addresses/:addrId', requireWrite, async (req: Request, res: Response) => {
  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'ip.remove',
      summary: `Remove IP address ${req.params.addrId}`,
      change: { kind: 'ip.remove', addressId: req.params.addrId },
    },
    async (c) => {
      await c.removeIpAddress(req.params.addrId);
      return { message: 'IP address removed' };
    },
    async (c) => { await c.collectIpAddressesCache(); }
  );
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
      Boolean(latestVersion && installedVersion && latestVersion !== installedVersion);

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

// POST /api/devices/:id/check-routerboard
router.post('/:id/check-routerboard', async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    const info = await collector.checkRouterboardUpgrade();
    await query(
      `UPDATE devices SET routerboard_upgrade_available = $1, upgrade_firmware_version = $2, updated_at = NOW() WHERE id = $3`,
      [info.upgradeAvailable, info.upgradeFirmware || null, deviceRow.id]
    );
    return res.json(info);
  } finally {
    collector.disconnect();
  }
});

// POST /api/devices/:id/install-routerboard
router.post('/:id/install-routerboard', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(deviceRow);
  try {
    await collector.connect();
    await collector.installRouterboardUpgrade();
    await query(
      `UPDATE devices SET routerboard_upgrade_available = FALSE, updated_at = NOW() WHERE id = $1`,
      [deviceRow.id]
    );
    return res.json({ message: 'RouterBOOT upgrade initiated. Device will reboot.' });
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
// Guarded: a new low-distance default route can re-point the path back to the manager.
router.post('/:id/routing', requireWrite, async (req: Request, res: Response) => {
  const { dst_address, gateway, distance, comment } = req.body;
  if (!dst_address || !gateway) {
    return res.status(400).json({ error: 'dst_address and gateway are required' });
  }

  await withGuardedChange(
    req.params.id,
    req,
    res,
    { kind: 'route.add', summary: `Add route ${dst_address} via ${gateway}` },
    async (c) => {
      await c.addRoute(dst_address, gateway, distance, comment);
      return { message: 'Route added' };
    }
  );
});

// DELETE /api/devices/:id/routing/:routeId
// Guarded: removing the default route cuts off any manager that isn't on-subnet.
router.delete('/:id/routing/:routeId', requireWrite, async (req: Request, res: Response) => {
  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'route.remove',
      summary: `Remove route ${req.params.routeId}`,
      change: { kind: 'route.remove', routeId: req.params.routeId },
    },
    async (c) => {
      await c.removeRoute(req.params.routeId);
      return { message: 'Route removed' };
    }
  );
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
// Guarded: bridge VLAN table edits decide which ports (and the bridge/CPU port
// itself) may carry the management VLAN.
router.post('/:id/vlans', requireWrite, async (req: Request, res: Response) => {
  const { bridge, vlan_id, tagged_ports = [], untagged_ports = [] } = req.body;
  if (!bridge || !vlan_id || vlan_id < 1 || vlan_id > 4094) {
    return res.status(400).json({ error: 'bridge and vlan_id (1-4094) are required' });
  }

  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'vlan.add',
      summary: `Add VLAN ${vlan_id} on ${bridge}`,
      change: { kind: 'vlan.add', bridge, vlanId: vlan_id, tagged: tagged_ports, untagged: untagged_ports },
    },
    async (c) => {
      await c.addBridgeVlan(bridge, vlan_id, tagged_ports, untagged_ports);
      return { message: `VLAN ${vlan_id} added` };
    },
    async (c) => { await c.collectVlans(); }
  );
});

// PUT /api/devices/:id/vlans/:vlanDbId (update tagged/untagged ports)
router.put('/:id/vlans/:vlanDbId', requireWrite, async (req: Request, res: Response) => {
  const vlan = await queryOne<{ id: number; vlan_id: number; bridge: string }>(
    `SELECT id, vlan_id, bridge FROM vlans WHERE id = $1 AND device_id = $2`,
    [req.params.vlanDbId, req.params.id]
  );
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });

  const { tagged_ports = [], untagged_ports = [] } = req.body;

  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'vlan.update',
      summary: `Update VLAN ${vlan.vlan_id} membership on ${vlan.bridge}`,
      change: {
        kind: 'vlan.update', bridge: vlan.bridge, vlanId: vlan.vlan_id,
        tagged: tagged_ports, untagged: untagged_ports,
      },
    },
    async (c) => {
      await c.updateBridgeVlan(vlan.bridge, vlan.vlan_id, tagged_ports, untagged_ports);
      return { message: `VLAN ${vlan.vlan_id} updated` };
    },
    async (c) => { await c.collectVlans(); }
  );
});

// DELETE /api/devices/:id/vlans/:vlanDbId
router.delete('/:id/vlans/:vlanDbId', requireWrite, async (req: Request, res: Response) => {
  const vlan = await queryOne<{ vlan_id: number; bridge: string }>(
    `SELECT vlan_id, bridge FROM vlans WHERE id = $1 AND device_id = $2`,
    [req.params.vlanDbId, req.params.id]
  );
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });

  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'vlan.delete',
      summary: `Remove VLAN ${vlan.vlan_id} from ${vlan.bridge}`,
      change: { kind: 'vlan.delete', bridge: vlan.bridge, vlanId: vlan.vlan_id },
    },
    async (c) => {
      await c.removeBridgeVlan(vlan.bridge, vlan.vlan_id);
      return { message: 'VLAN removed' };
    },
    // Only drop the local row once the device is confirmed reachable — if the
    // change auto-reverts, the VLAN still exists on the device.
    async () => { await query(`DELETE FROM vlans WHERE id = $1`, [req.params.vlanDbId]); }
  );
});

// POST /api/devices/:id/vlans/copy (bulk copy VLANs from another switch)
router.post('/:id/vlans/copy', requireWrite, async (req: Request, res: Response) => {
  const deviceRow = await queryOne<any>(
    `SELECT id, ip_address, api_port, api_username, api_password_encrypted FROM devices WHERE id = $1`,
    [req.params.id]
  );
  if (!deviceRow) return res.status(404).json({ error: 'Device not found' });

  const { operations } = req.body as {
    operations: Array<{
      action: 'add' | 'update';
      vlan_id: number;
      bridge: string;
      tagged_ports: string[];
      untagged_ports: string[];
    }>;
  };

  if (!Array.isArray(operations) || operations.length === 0) {
    return res.status(400).json({ error: 'operations array is required and must not be empty' });
  }

  const collector = new DeviceCollector(deviceRow);
  const results: Array<{ vlan_id: number; action: string; success: boolean; error?: string }> = [];

  try {
    await collector.connect();

    for (const op of operations) {
      try {
        if (op.action === 'add') {
          await collector.addBridgeVlan(op.bridge, op.vlan_id, op.tagged_ports, op.untagged_ports);
        } else {
          await collector.updateBridgeVlan(op.bridge, op.vlan_id, op.tagged_ports, op.untagged_ports);
        }
        results.push({ vlan_id: op.vlan_id, action: op.action, success: true });
      } catch (err) {
        results.push({ vlan_id: op.vlan_id, action: op.action, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    await collector.collectVlans();
    const vlans = await query(`SELECT * FROM vlans WHERE device_id = $1 ORDER BY vlan_id ASC`, [req.params.id]);
    return res.json({ results, vlans });
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
  // Guarded: creating a bond pulls its member ports out of their bridge first, so a
  // failure part-way through can strand the uplink.
  await withGuardedChange(
    req.params.id,
    req,
    res,
    { kind: 'bond.create', summary: `Create bond '${name}' over ${slaves.join(', ')}` },
    async (c) => {
      await c.createBond(name, slaves, mode, {
        lacpRate: lacp_rate, hashPolicy: transmit_hash_policy, mtu, minLinks: min_links,
      });
      return { message: 'Bond created' };
    },
    async (c) => { await c.collectInterfaces(); }
  );
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
// Guarded: removing a bond releases its member ports, which can take the device
// off the network even when the bond looks unused.
router.delete('/:id/bonds/:bondName', requireWrite, async (req: Request, res: Response) => {
  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'bond.delete',
      summary: `Delete bond '${req.params.bondName}'`,
      change: { kind: 'bond.delete', name: req.params.bondName },
    },
    async (c) => {
      await c.deleteBond(req.params.bondName);
      return { message: 'Bond deleted' };
    },
    async (c) => {
      await query(`DELETE FROM interfaces WHERE device_id = $1 AND name = $2`, [req.params.id, req.params.bondName]);
      await c.collectInterfaces();
    }
  );
});

// PUT /api/devices/:id/bridge/:bridgeName/vlan-filtering
router.put('/:id/bridge/:bridgeName/vlan-filtering', requireWrite, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled: boolean };
  // Guarded: turning on vlan-filtering with untagged management on the bridge is
  // the single most common way to lock yourself out of a MikroTik.
  await withGuardedChange(
    req.params.id,
    req,
    res,
    {
      kind: 'bridge.vlan-filtering',
      summary: `${enabled ? 'Enable' : 'Disable'} VLAN filtering on bridge '${req.params.bridgeName}'`,
      change: {
        kind: 'bridge.vlan-filtering',
        bridge: req.params.bridgeName,
        enabled: Boolean(enabled),
      },
    },
    async (c) => {
      await c.setBridgeVlanFiltering(req.params.bridgeName, Boolean(enabled));
      return { success: true, vlan_filtering: enabled };
    },
    async (c) => { await c.collectInterfaces(); }
  );
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

// POST /api/devices/:id/tools/capture — packet capture via RouterOS sniffer + SFTP download
router.post('/:id/tools/capture', requireWrite, async (req: Request, res: Response) => {
  const { interface: iface, filter_ip, duration } = req.body as {
    interface?: string; filter_ip?: string; duration?: number;
  };
  const captureSec = Math.min(Math.max(5, Number(duration) || 10), 60);

  const device = await getToolDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.ssh_username || !device.ssh_password_encrypted) {
    return res.status(400).json({ error: 'SSH credentials required for packet capture. Add SSH username/password in device settings.' });
  }

  const fileName = `cap-${Date.now()}`;
  const client = makeToolClient(device);

  try {
    console.log(`[capture] connecting to device ${device.id} (${device.ip_address})`);
    await client.connect();
    // Stop any in-progress capture before reconfiguring
    await client.execute('/tool/sniffer/stop').catch(() => {});
    const setParams: Record<string, string> = { 'file-name': fileName, 'file-limit': '10240' };
    if (iface) setParams['filter-interface'] = iface;
    if (filter_ip) setParams['filter-ip-address'] = filter_ip;
    await client.execute('/tool/sniffer/set', setParams);
    console.log(`[capture] starting ${captureSec}s capture`);
    await client.execute('/tool/sniffer/start');
    await new Promise((r) => setTimeout(r, captureSec * 1000));
    await client.execute('/tool/sniffer/stop').catch(() => {});

    // Poll /file/print until the capture file appears (up to 10s)
    // RouterOS reports the exact SFTP-accessible path in the 'name' field
    let remotePath: string | null = null;
    for (let i = 0; i < 20 && !remotePath; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const files = await client.execute('/file/print');
      const hit = files.find((f) => (f['name'] ?? '').includes(fileName));
      if (hit) remotePath = hit['name'];
    }
    client.disconnect();

    if (!remotePath) {
      throw new Error(`Sniffer did not create file "${fileName}.pcap" — check device storage`);
    }
    // RouterOS SFTP root is the device filesystem root; 'name' from /file/print is the path
    const sftpPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
    console.log(`[capture] file found: ${remotePath}; downloading via SFTP`);

    // Download PCAP via SFTP then delete remote file
    const pcapBuffer = await new Promise<Buffer>((resolve, reject) => {
      const ssh = new SshClient();
      ssh.on('ready', () => {
        ssh.sftp((err, sftp) => {
          if (err) { ssh.end(); return reject(new Error(`SFTP init failed: ${err.message}`)); }
          const chunks: Buffer[] = [];
          const stream = sftp.createReadStream(sftpPath);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            sftp.unlink(sftpPath, () => { ssh.end(); });
            resolve(Buffer.concat(chunks));
          });
          stream.on('error', (e: Error) => {
            // Try without leading slash in case RouterOS SFTP is rooted differently
            if (sftpPath.startsWith('/') && e.message.includes('No such file')) {
              const altPath = sftpPath.slice(1);
              console.log(`[capture] retrying SFTP with path: ${altPath}`);
              const chunks2: Buffer[] = [];
              const stream2 = sftp.createReadStream(altPath);
              stream2.on('data', (c: Buffer) => chunks2.push(c));
              stream2.on('end', () => { sftp.unlink(altPath, () => { ssh.end(); }); resolve(Buffer.concat(chunks2)); });
              stream2.on('error', (e2: Error) => { ssh.end(); reject(new Error(`SFTP read failed (tried ${sftpPath} and ${altPath}): ${e2.message}`)); });
            } else {
              ssh.end();
              reject(new Error(`SFTP read failed (path=${sftpPath}): ${e.message}`));
            }
          });
        });
      });
      ssh.on('error', (e) => reject(new Error(`SSH connect failed: ${e.message}`)));
      ssh.connect({
        host: device.ip_address,
        port: device.ssh_port ?? 22,
        username: device.ssh_username!,
        password: decrypt(device.ssh_password_encrypted!),
        readyTimeout: 10_000,
      });
    });

    res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.pcap"`);
    return res.send(pcapBuffer);
  } catch (err) {
    client.disconnect();
    console.error('[capture]', (err as Error).message);
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/devices/:id/tools/btest — bandwidth test via RouterOS
// If target_device_id is provided: automatically enable/disable btest server on the target device.
// If only address is provided: manual mode — user must ensure the btest server is already running.
router.post('/:id/tools/btest', requireWrite, async (req: Request, res: Response) => {
  const { target_device_id, address, direction = 'both', duration = 5, protocol = 'tcp' } = req.body as {
    target_device_id?: number; address?: string; direction?: string; duration?: number; protocol?: string;
  };
  if (!target_device_id && !address) {
    return res.status(400).json({ error: 'target_device_id or address is required' });
  }
  const testSec = Math.min(Math.max(1, Number(duration) || 5), 30);

  const device = await getToolDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  // Resolve target: either a managed device (auto server management) or a manual IP
  let targetAddress = address ?? '';
  let targetUser: string | undefined;
  let targetPassword: string | undefined;
  let serverClient: RouterOSClient | null = null;

  if (target_device_id) {
    const target = await getToolDevice(String(target_device_id));
    if (!target) return res.status(404).json({ error: 'Target device not found' });
    targetAddress = target.ip_address;
    targetUser = target.api_username;
    targetPassword = decrypt(target.api_password_encrypted);
    serverClient = new RouterOSClient(
      target.ip_address, target.api_port, target.api_username, targetPassword, 15_000, 20_000
    );
  }

  const client = new RouterOSClient(
    device.ip_address, device.api_port, device.api_username,
    decrypt(device.api_password_encrypted),
    15_000,
    (testSec + 15) * 1000
  );

  try {
    // Enable bandwidth-test server on target device before running test
    if (serverClient) {
      await serverClient.connect();
      await serverClient.execute('/tool/bandwidth-server/set', { enabled: 'yes', authenticate: 'yes' });
      serverClient.disconnect();
    }

    await client.connect();
    const btestParams: Record<string, string> = {
      address: targetAddress,
      direction: ['receive', 'transmit', 'both'].includes(direction) ? direction : 'both',
      duration: String(testSec),
      protocol: ['tcp', 'udp'].includes(protocol) ? protocol : 'tcp',
    };
    // When testing against a managed device, authenticate with its RouterOS credentials
    if (targetUser) btestParams['user'] = targetUser;
    if (targetPassword) btestParams['password'] = targetPassword;

    const rows = await client.executeStreaming('/tool/bandwidth-test', btestParams, (testSec + 15) * 1000);
    client.disconnect();

    const lastRow = rows.filter((r) => r['tx-total-average'] !== undefined || r['rx-total-average'] !== undefined).at(-1);
    const toMbps = (v: string | undefined) => v ? Math.round(parseInt(v) / 1_000_000) : 0;

    return res.json({
      tx_mbps: toMbps(lastRow?.['tx-total-average']),
      rx_mbps: toMbps(lastRow?.['rx-total-average']),
      direction,
      protocol,
      duration: testSec,
      target_ip: targetAddress,
      raw: lastRow ?? rows.at(-1) ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    client.disconnect();
    // Always disable btest server on target when done (success or failure)
    if (serverClient) {
      try {
        await serverClient.connect();
        await serverClient.execute('/tool/bandwidth-server/set', { enabled: 'no' });
        serverClient.disconnect();
      } catch {
        // Best-effort — don't mask the original error
      }
    }
  }
});

export default router;
