import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeDevices } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';

const router = Router();
router.use(requireAuth);

// GET /api/routers/lldp — LLDP enabled/disabled status per online router
router.get('/lldp', async (req: Request, res: Response) => {
  const siteFilter = siteScopeDevices(activeSite(req));
  const routers = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'router' AND status = 'online'
       ${siteFilter ? `AND ${siteFilter}` : ''}`
  );

  const results = await Promise.allSettled(
    routers.map(async (r: DeviceRow) => {
      const collector = new DeviceCollector(r);
      try {
        await collector.connect();
        const lldp = await collector.getLldpEnabled();
        return { id: r.id, name: r.name, ip_address: r.ip_address, ...lldp };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      id: routers[i].id,
      name: routers[i].name,
      ip_address: routers[i].ip_address,
      enabled: null as boolean | null,
      protocol: null as string | null,
      error: (r.reason as Error).message,
    };
  });

  res.json(statuses);
});

// PUT /api/routers/lldp — enable or disable LLDP on all online routers
router.put('/lldp', requireWrite, async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '"enabled" (boolean) is required' });
  }

  const routers = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'router' AND status = 'online'`
  );

  const results = await Promise.allSettled(
    routers.map(async (r: DeviceRow) => {
      const collector = new DeviceCollector(r);
      try {
        await collector.connect();
        await collector.setLldpEnabled(enabled);
        return { id: r.id, name: r.name, success: true };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      id: routers[i].id,
      name: routers[i].name,
      success: false,
      error: (r.reason as Error).message,
    };
  });

  return res.json({
    applied: statuses.filter(s => s.success).length,
    total: routers.length,
    results: statuses,
  });
});

// GET /api/routers/snmp — SNMP config/status per online router
router.get('/snmp', async (req: Request, res: Response) => {
  const siteFilter = siteScopeDevices(activeSite(req));
  const routers = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'router' AND status = 'online'
       ${siteFilter ? `AND ${siteFilter}` : ''}`
  );

  const results = await Promise.allSettled(
    routers.map(async (r: DeviceRow) => {
      const collector = new DeviceCollector(r);
      try {
        await collector.connect();
        const snmp = await collector.getSnmpConfig();
        return { id: r.id, name: r.name, ip_address: r.ip_address, ...snmp };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      id: routers[i].id, name: routers[i].name, ip_address: routers[i].ip_address,
      enabled: null as boolean | null, error: (r.reason as Error).message,
    };
  });
  res.json(statuses);
});

// PUT /api/routers/snmp — apply SNMP config to all online routers
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

  const routers = await query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type = 'router' AND status = 'online'`
  );

  const results = await Promise.allSettled(
    routers.map(async (r: DeviceRow) => {
      const collector = new DeviceCollector(r);
      try {
        await collector.connect();
        await collector.setSnmpConfig(config);
        return { id: r.id, name: r.name, success: true };
      } finally {
        collector.disconnect();
      }
    })
  );

  const statuses = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { id: routers[i].id, name: routers[i].name, success: false, error: (r.reason as Error).message };
  });

  return res.json({ applied: statuses.filter(s => s.success).length, total: routers.length, results: statuses });
});

export default router;
