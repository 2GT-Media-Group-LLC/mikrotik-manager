import { Router, Request, Response } from 'express';
import { resourceSiteAccess } from '../utils/siteAccess';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeDevices, siteScopeByDevice } from '../utils/siteScope';
import { resolveStpUpstreams } from '../utils/stpUpstream';
import { activeSite, writableScope } from '../middleware/site';
import { PollerService } from '../services/PollerService';
import {
  buildTopology,
  type LinkRow,
  type ManualLinkRow,
  type TopoDevice,
} from '../services/topology/buildTopology';

const router = Router();
router.use(requireAuth);
// Manual links join two devices; a site-scoped account needs both to be its own (P1-7).
router.use(resourceSiteAccess(async (req) => {
  if (req.method === 'POST' && req.path === '/manual-links') {
    const b = req.body as { from_device_id?: number; to_device_id?: number };
    return b?.from_device_id && b?.to_device_id ? [Number(b.from_device_id), Number(b.to_device_id)] : null;
  }
  const del = req.method === 'DELETE' ? /^\/manual-links\/(\d+)\/?$/.exec(req.path) : null;
  if (del) {
    const rows = await query<{ from_device_id: number; to_device_id: number }>(
      `SELECT from_device_id, to_device_id FROM manual_topology_links WHERE id = $1`, [del[1]]);
    return rows.length ? [rows[0].from_device_id, rows[0].to_device_id] : [];
  }
  return null;
}, 'Link not found'));

let pollerService: PollerService | null = null;
export function setPollerService(p: PollerService): void {
  pollerService = p;
}


interface BridgeRow {
  device_id: number;
  bridge_name: string;
  /** This bridge's own id, "priority.MAC" — how a root is matched to a device. */
  bridge_id: string | null;
  root_bridge: boolean | null;
  root_bridge_id: string | null;
  root_port: string | null;
  root_path_cost: number | null;
  protocol_mode: string | null;
}

// GET /api/topology
router.get('/', async (req: Request, res: Response) => {
  // Scope the graph to the active site. Links are filtered on their *from*
  // device: a link out of the site still shows, and resolves to an external
  // node, which is the honest picture of an uplink to somewhere else (#130).
  const siteId = activeSite(req);
  const devFilter = siteScopeDevices(siteId);
  const fromFilter = siteScopeByDevice(siteId, 'tl.from_device_id');
  const mlFilter = siteScopeByDevice(siteId, 'ml.from_device_id');
  const ifFilter = siteScopeByDevice(siteId, 'device_id');
  const brFilter = siteScopeByDevice(siteId, 'device_id');
  const [devices, allLinks, manualLinks, deviceMacs, bridges] = await Promise.all([
    query<TopoDevice>(
      `SELECT id, name, ip_address, model, device_type, status, ros_version, ip_addresses_jsonb
       FROM devices ${devFilter ? `WHERE ${devFilter}` : ''} ORDER BY name ASC`
    ),
    query<LinkRow>(
      `SELECT tl.*,
              fd.name AS from_device_name,
              td.name AS to_device_name
       FROM topology_links tl
       LEFT JOIN devices fd ON fd.id = tl.from_device_id
       LEFT JOIN devices td ON td.id = tl.to_device_id
       ${fromFilter ? `WHERE ${fromFilter}` : ''}
       ORDER BY tl.discovered_at DESC`
    ),
    query<ManualLinkRow>(
      `SELECT ml.*, fd.name AS from_name, td.name AS to_name
       FROM manual_topology_links ml
       JOIN devices fd ON fd.id = ml.from_device_id
       JOIN devices td ON td.id = ml.to_device_id
       ${mlFilter ? `WHERE ${mlFilter}` : ''}`
    ),
    // Every interface MAC in the fleet, so a neighbour seen only by MAC — an LLDP
    // sighting across a trunk port carries no address — still resolves to its device.
    query<{ device_id: number; mac_address: string }>(
      `SELECT device_id, mac_address FROM interfaces WHERE mac_address IS NOT NULL
         ${ifFilter ? `AND ${ifFilter}` : ''}
       UNION
       SELECT device_id, mac_address FROM wireless_interfaces WHERE mac_address IS NOT NULL
         ${ifFilter ? `AND ${ifFilter}` : ''}`
    ),
    // What each bridge reports about the spanning tree. Authoritative, and the
    // reason the root is no longer guessed from port roles (#131).
    query<BridgeRow>(
      `SELECT device_id, bridge_name, bridge_id, root_bridge, root_bridge_id,
              root_port, root_path_cost, protocol_mode
         FROM device_bridges ${brFilter ? `WHERE ${brFilter}` : ''}`
    ),
  ]);

  const graph = buildTopology(devices, allLinks, manualLinks, deviceMacs);

  // Spanning tree gives a directed, loop-free view that neighbour discovery
  // cannot: which neighbour on an ambiguous port is actually upstream, how deep
  // each device sits, and which trees are separate. Resolved server-side so the
  // rollout warning and the diagram agree on one answer (#131 follow-on).
  const upstreams = resolveStpUpstreams(bridges, allLinks);

  res.json({
    devices,
    bridges,
    upstreams,
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
router.post('/discover', requireWrite, async (req: Request, res: Response) => {
  // Only the devices in view: a site-scoped account can't trigger polls of other sites (P1-7).
  const scope = siteScopeDevices(writableScope(req));
  const devices = await query<{ id: number }>(`SELECT id FROM devices WHERE status='online' ${scope ? `AND ${scope}` : ''}`);
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
