import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeDevices } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';

const router = Router();
router.use(requireAuth);

// GET /api/switches — all switch devices with port statistics
router.get('/', async (req: Request, res: Response) => {
  const siteFilter = siteScopeDevices(activeSite(req), 'd');
  const switches = await query(`
    SELECT d.id, d.name, d.ip_address, d.model, d.device_type, d.status, d.last_seen,
           d.ros_version, d.firmware_version, d.serial_number, d.rack_name, d.rack_slot,
           COUNT(i.id) FILTER (WHERE i.running = true  AND i.disabled = false) AS ports_up,
           COUNT(i.id) FILTER (WHERE i.running = false AND i.disabled = false) AS ports_down,
           COUNT(i.id) FILTER (WHERE i.disabled = true)                        AS ports_disabled,
           COUNT(i.id)                                                          AS ports_total
    FROM devices d
    LEFT JOIN interfaces i ON i.device_id = d.id
      AND (i.type ILIKE 'ether%' OR i.type ILIKE 'sfp%'
           OR i.name ILIKE 'ether%' OR i.name ILIKE 'sfp%')
    WHERE d.device_type = 'switch' ${siteFilter ? `AND ${siteFilter}` : ''}
    GROUP BY d.id
    ORDER BY d.name ASC
  `);
  res.json(switches);
});

// GET /api/switches/lldp — LLDP enabled/disabled status per online switch
router.get('/lldp', async (req: Request, res: Response) => {
  const siteFilter = siteScopeDevices(activeSite(req));
  const switches = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'switch' AND status = 'online'
       ${siteFilter ? `AND ${siteFilter}` : ''}`
  );

  const results = await Promise.allSettled(
    switches.map(async (sw: DeviceRow) => {
      const collector = new DeviceCollector(sw);
      try {
        await collector.connect();
        const lldp = await collector.getLldpEnabled();
        return { id: sw.id, name: sw.name, ip_address: sw.ip_address, ...lldp };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      id: switches[i].id,
      name: switches[i].name,
      ip_address: switches[i].ip_address,
      enabled: null as boolean | null,
      protocol: null as string | null,
      error: (r.reason as Error).message,
    };
  });

  res.json(statuses);
});

// PUT /api/switches/lldp — enable or disable LLDP on all online switches
router.put('/lldp', requireWrite, async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '"enabled" (boolean) is required' });
  }

  const switches = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'switch' AND status = 'online'`
  );

  const results = await Promise.allSettled(
    switches.map(async (sw: DeviceRow) => {
      const collector = new DeviceCollector(sw);
      try {
        await collector.connect();
        await collector.setLldpEnabled(enabled);
        return { id: sw.id, name: sw.name, success: true };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      id: switches[i].id,
      name: switches[i].name,
      success: false,
      error: (r.reason as Error).message,
    };
  });

  return res.json({
    applied: statuses.filter(s => s.success).length,
    total: switches.length,
    results: statuses,
  });
});

// GET /api/switches/snmp — SNMP config/status for all managed switches
// Includes offline/unknown devices so the list never disappears during a poll cycle.
// Unreachable devices fall through to the Promise.allSettled error path and render with an error note.
router.get('/snmp', async (req: Request, res: Response) => {
  const siteFilter = siteScopeDevices(activeSite(req));
  const switches = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'switch'
       ${siteFilter ? `AND ${siteFilter}` : ''} ORDER BY name`
  );

  const results = await Promise.allSettled(
    switches.map(async (sw: DeviceRow) => {
      const collector = new DeviceCollector(sw);
      try {
        await collector.connect();
        const snmp = await collector.getSnmpConfig();
        return { id: sw.id, name: sw.name, ip_address: sw.ip_address, ...snmp };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      id: switches[i].id, name: switches[i].name, ip_address: switches[i].ip_address,
      enabled: null as boolean | null, error: (r.reason as Error).message,
    };
  });
  res.json(statuses);
});

// PUT /api/switches/snmp — apply SNMP config to all online switches
router.put('/snmp', requireWrite, async (req: Request, res: Response) => {
  const config = req.body as {
    enabled: boolean; community_name: string; version: 'v1' | 'v2c' | 'v3';
    contact?: string; location?: string; trap_target?: string;
    auth_protocol?: string; auth_password?: string;
    priv_protocol?: string; priv_password?: string;
  };
  if (!config.community_name || !config.version) {
    return res.status(400).json({ error: 'community_name and version are required' });
  }

  const switches = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'switch' AND status = 'online'`
  );

  const results = await Promise.allSettled(
    switches.map(async (sw: DeviceRow) => {
      const collector = new DeviceCollector(sw);
      try {
        await collector.connect();
        await collector.setSnmpConfig(config);
        return { id: sw.id, name: sw.name, success: true };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { id: switches[i].id, name: switches[i].name, success: false, error: (r.reason as Error).message };
  });

  return res.json({ applied: statuses.filter(s => s.success).length, total: switches.length, results: statuses });
});

export default router;
