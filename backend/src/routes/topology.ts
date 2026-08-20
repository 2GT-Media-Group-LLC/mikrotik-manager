import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { PollerService } from '../services/PollerService';
import {
  buildTopology,
  type LinkRow,
  type ManualLinkRow,
  type TopoDevice,
} from '../services/topology/buildTopology';

const router = Router();
router.use(requireAuth);

let pollerService: PollerService | null = null;
export function setPollerService(p: PollerService): void {
  pollerService = p;
}


// GET /api/topology
router.get('/', async (_req: Request, res: Response) => {
  const [devices, allLinks, manualLinks, deviceMacs] = await Promise.all([
    query<TopoDevice>(
      `SELECT id, name, ip_address, model, device_type, status, ros_version, ip_addresses_jsonb
       FROM devices ORDER BY name ASC`
    ),
    query<LinkRow>(
      `SELECT tl.*,
              fd.name AS from_device_name,
              td.name AS to_device_name
       FROM topology_links tl
       LEFT JOIN devices fd ON fd.id = tl.from_device_id
       LEFT JOIN devices td ON td.id = tl.to_device_id
       ORDER BY tl.discovered_at DESC`
    ),
    query<ManualLinkRow>(
      `SELECT ml.*, fd.name AS from_name, td.name AS to_name
       FROM manual_topology_links ml
       JOIN devices fd ON fd.id = ml.from_device_id
       JOIN devices td ON td.id = ml.to_device_id`
    ),
    // Every interface MAC in the fleet, so a neighbour seen only by MAC — an LLDP
    // sighting across a trunk port carries no address — still resolves to its device.
    query<{ device_id: number; mac_address: string }>(
      `SELECT device_id, mac_address FROM interfaces WHERE mac_address IS NOT NULL
       UNION
       SELECT device_id, mac_address FROM wireless_interfaces WHERE mac_address IS NOT NULL`
    ),
  ]);

  const graph = buildTopology(devices, allLinks, manualLinks, deviceMacs);

  res.json({
    devices,
    links: graph.links,
    externalNodes: graph.externalNodes,
    segConns: graph.segConns,
    ambiguous: graph.ambiguous,
    manualLinkIds: manualLinks.map((ml) => ({
      id: ml.id,
      from_device_id: ml.from_device_id,
      to_device_id: ml.to_device_id,
    })),
  });
});

// POST /api/topology/discover
router.post('/discover', requireWrite, async (_req: Request, res: Response) => {
  const devices = await query<{ id: number }>(`SELECT id FROM devices WHERE status='online'`);
  if (pollerService) {
    for (const d of devices) {
      await pollerService.scheduleDeviceSync(d.id, 'slow');
    }
  }
  res.json({ message: `Discovery triggered for ${devices.length} device(s)` });
});

// POST /api/topology/manual-links — create a user-drawn connection
router.post('/manual-links', requireWrite, async (req: Request, res: Response) => {
  const { from_device_id, to_device_id, label } = req.body as {
    from_device_id?: number; to_device_id?: number; label?: string;
  };
  if (!from_device_id || !to_device_id) {
    res.status(400).json({ error: 'from_device_id and to_device_id are required' });
    return;
  }
  if (from_device_id === to_device_id) {
    res.status(400).json({ error: 'Cannot connect a device to itself' });
    return;
  }

  // Ensure both devices exist
  const [devA, devB] = await Promise.all([
    queryOne<{ id: number }>(`SELECT id FROM devices WHERE id = $1`, [from_device_id]),
    queryOne<{ id: number }>(`SELECT id FROM devices WHERE id = $1`, [to_device_id]),
  ]);
  if (!devA || !devB) { res.status(404).json({ error: 'Device not found' }); return; }

  const rows = await query<{ id: number; from_device_id: number; to_device_id: number; label: string | null }>(
    `INSERT INTO manual_topology_links (from_device_id, to_device_id, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_device_id, to_device_id) DO UPDATE SET label = EXCLUDED.label
     RETURNING *`,
    [from_device_id, to_device_id, label ?? null]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/topology/manual-links/:id
router.delete('/manual-links/:id', requireWrite, async (req: Request, res: Response) => {
  await query(`DELETE FROM manual_topology_links WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

export default router;
