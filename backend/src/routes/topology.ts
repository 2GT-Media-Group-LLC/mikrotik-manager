import { loadBondMembers } from '../services/topology/bondMembers';
import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeDevices, siteScopeByDevice } from '../utils/siteScope';
import { resolveStpUpstreams } from '../utils/stpUpstream';
import { activeSite, writableScope, targetSite } from '../middleware/site';
import { roleInSite, roleAtLeast, roleOnDevice } from '../utils/siteAccess';
import { clientAttachments, type ClientSighting } from '../utils/topologyClients';
import { PollerService } from '../services/PollerService';
import {
  buildTopology,
  type LinkRow,
  type TopoDevice,
} from '../services/topology/buildTopology';

const router = Router();
router.use(requireAuth);
// Hand-drawn links and nodes check the caller's role in their site in each handler (P1-7).

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
  const ifFilter = siteScopeByDevice(siteId, 'device_id');
  const brFilter = siteScopeByDevice(siteId, 'device_id');
  const [devices, allLinks, deviceMacs, bridges] = await Promise.all([
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

  const graph = buildTopology(devices, allLinks, [], deviceMacs);

  // Your own nodes and their links (#147), in the sites in view.
  const nodeFilter = siteScopeDevices(siteId);
  const nodes = await query<TopoNodeRow>(
    `SELECT id, site_id, name, kind, address, notes FROM topology_nodes ${nodeFilter ? `WHERE ${nodeFilter}` : ''} ORDER BY name`
  );
  const handRows = await query<HandLinkRow>(
    `SELECT * FROM topology_hand_links ${nodeFilter ? `WHERE ${nodeFilter}` : ''} ORDER BY id`
  );
  const handLinks = handRows.map(toHandLink);

  // How the map has been arranged by hand, if it has (#147).
  const [posRows, anchorRows] = await Promise.all([
    query<{ node_key: string; x: number; y: number }>(`SELECT node_key, x, y FROM topology_positions`),
    query<{ edge_key: string; source_handle: string | null; target_handle: string | null }>(
      `SELECT edge_key, source_handle, target_handle FROM topology_edge_anchors`),
  ]);
  const layout = {
    positions: Object.fromEntries(posRows.map((r) => [r.node_key, { x: Number(r.x), y: Number(r.y) }])),
    anchors: Object.fromEntries(anchorRows.map((r) => [r.edge_key, { sourceHandle: r.source_handle, targetHandle: r.target_handle }])),
  };

  // Client devices, attached where they really connect (#147). Only when asked:
  // a large site has thousands.
  const clients = req.query.clients === '1' ? await topologyClients(siteId) : undefined;

  // Spanning tree gives a directed, loop-free view that neighbour discovery
  // cannot: which neighbour on an ambiguous port is actually upstream, how deep
  // each device sits, and which trees are separate. Resolved server-side so the
  // rollout warning and the diagram agree on one answer (#131 follow-on).
  const upstreams = resolveStpUpstreams(bridges, allLinks, await loadBondMembers());

  res.json({
    devices,
    bridges,
    upstreams,
    links: graph.links,
    externalNodes: graph.externalNodes,
    segConns: graph.segConns,
    ambiguous: graph.ambiguous,
    nodes,
    handLinks,
    layout,
    ...(clients ? { clients } : {}),
  });
});

interface TopoNodeRow { id: number; site_id: number | null; name: string; kind: string; address: string | null; notes: string | null }

const NODE_KINDS = ['modem', 'router', 'firewall', 'switch', 'ap', 'server', 'nas', 'printer', 'camera', 'phone', 'computer', 'cloud', 'other'];

async function topologyClients(siteId: ReturnType<typeof activeSite>) {
  const scope = siteScopeByDevice(siteId, 'c.device_id');
  const [sightings, uplinkRows, ports] = await Promise.all([
    query<ClientSighting>(
      `SELECT c.mac_address, c.device_id, c.interface_name, c.client_type, c.last_seen,
              c.hostname, c.custom_name, c.ip_address, c.vendor
         FROM clients c WHERE c.active ${scope ? `AND ${scope}` : ''}`
    ),
    // Ports with a neighbour: facing another managed device (the client is
    // further along) or an unmanaged one (the client is behind it).
    query<{ from_device_id: number; from_interface: string; managed: boolean }>(
      `SELECT from_device_id, from_interface, (to_device_id IS NOT NULL) AS managed FROM topology_links
        WHERE from_interface IS NOT NULL`
    ),
    query<{ device_id: number; name: string; type: string | null }>(`SELECT device_id, name, type FROM interfaces`),
  ]);
  const portKey = (r: { from_device_id: number; from_interface: string }) => `${r.from_device_id}:${r.from_interface.toLowerCase()}`;
  const uplinks = new Set(uplinkRows.filter((r) => r.managed).map(portKey));
  const neighbourPorts = new Set(uplinkRows.filter((r) => !r.managed).map(portKey));
  const types = new Map(ports.filter((p) => p.type).map((p) => [`${p.device_id}:${p.name.toLowerCase()}`, p.type!]));
  return clientAttachments(sightings, uplinks, types, neighbourPorts);
}

/** Write access to a node: operator or better in its site. */
function canWriteNode(req: Request, node: { site_id: number | null }): boolean {
  return !!req.user && roleAtLeast(roleInSite(req.user, node.site_id), 'operator');
}

function nodeFields(body: Record<string, unknown>): { name?: string; kind?: string; address?: string | null; notes?: string | null; error?: string } {
  const out: { name?: string; kind?: string; address?: string | null; notes?: string | null; error?: string } = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'A name is required' };
    out.name = name.slice(0, 100);
  }
  if (body.kind !== undefined) {
    const kind = String(body.kind);
    if (!NODE_KINDS.includes(kind)) return { error: `kind must be one of ${NODE_KINDS.join(', ')}` };
    out.kind = kind;
  }
  if (body.address !== undefined) out.address = body.address ? String(body.address).trim().slice(0, 255) : null;
  if (body.notes !== undefined) out.notes = body.notes ? String(body.notes).slice(0, 2000) : null;
  return out;
}

// POST /api/topology/nodes — add a node the manager doesn't manage (#147)
router.post('/nodes', requireWrite, async (req: Request, res: Response) => {
  const target = targetSite(req);
  if (!target.ok) return res.status(target.status).json({ error: target.error });
  const f = nodeFields({ kind: 'other', ...req.body, name: req.body?.name ?? '' });
  if (f.error) return res.status(400).json({ error: f.error });
  const row = await queryOne<TopoNodeRow>(
    `INSERT INTO topology_nodes (site_id, name, kind, address, notes)
     VALUES (COALESCE($1::int, (SELECT id FROM sites ORDER BY is_default DESC, id LIMIT 1)), $2, $3, $4, $5)
     RETURNING id, site_id, name, kind, address, notes`,
    [target.siteId, f.name, f.kind, f.address ?? null, f.notes ?? null]
  );
  return res.status(201).json(row);
});

// PUT /api/topology/nodes/:id
router.put('/nodes/:id', requireWrite, async (req: Request, res: Response) => {
  const node = await queryOne<TopoNodeRow>(`SELECT * FROM topology_nodes WHERE id = $1`, [req.params.id]);
  if (!node || !canWriteNode(req, node)) return res.status(404).json({ error: 'Node not found' });
  const f = nodeFields(req.body ?? {});
  if (f.error) return res.status(400).json({ error: f.error });
  const row = await queryOne<TopoNodeRow>(
    `UPDATE topology_nodes SET name = COALESCE($2, name), kind = COALESCE($3, kind),
            address = CASE WHEN $6 THEN $4 ELSE address END, notes = CASE WHEN $7 THEN $5 ELSE notes END
      WHERE id = $1 RETURNING id, site_id, name, kind, address, notes`,
    [node.id, f.name ?? null, f.kind ?? null, f.address ?? null, f.notes ?? null, 'address' in f, 'notes' in f]
  );
  return res.json(row);
});

// DELETE /api/topology/nodes/:id — its links go with it
router.delete('/nodes/:id', requireWrite, async (req: Request, res: Response) => {
  const node = await queryOne<TopoNodeRow>(`SELECT * FROM topology_nodes WHERE id = $1`, [req.params.id]);
  if (!node || !canWriteNode(req, node)) return res.status(404).json({ error: 'Node not found' });
  await query(`DELETE FROM topology_nodes WHERE id = $1`, [node.id]);
  return res.json({ ok: true });
});

// ─── Links drawn by hand (#147) ─────────────────────────────────────────────
// Either end can be a managed device, one of your nodes, or a neighbour
// discovery saw but the manager doesn't manage.

type EndKind = 'device' | 'node' | 'external';
interface End { kind: EndKind; ref: string | number; name?: string | null }

interface HandLinkRow {
  id: number; site_id: number | null; label: string | null;
  a_device_id: number | null; a_node_id: number | null; a_external: string | null; a_external_name: string | null;
  b_device_id: number | null; b_node_id: number | null; b_external: string | null; b_external_name: string | null;
}

function endOf(r: HandLinkRow, side: 'a' | 'b'): End {
  const dev = r[`${side}_device_id`];
  const node = r[`${side}_node_id`];
  if (dev != null) return { kind: 'device', ref: dev };
  if (node != null) return { kind: 'node', ref: node };
  return { kind: 'external', ref: r[`${side}_external`] ?? '', name: r[`${side}_external_name`] };
}
const toHandLink = (r: HandLinkRow) => ({ id: r.id, label: r.label, a: endOf(r, 'a'), b: endOf(r, 'b') });

const EXTERNAL_REF = /^ext-[a-z0-9]{1,150}$/i;

/**
 * Check one end of a link and return the site it implies (null for a neighbour,
 * which belongs to no site), or an error.
 */
async function checkEnd(req: Request, raw: unknown): Promise<{ end: End; site: number | null } | { error: string; status: number }> {
  const e = raw as Partial<End> | undefined;
  if (!e || !['device', 'node', 'external'].includes(String(e.kind))) return { error: 'Each end needs a kind: device, node or external', status: 400 };
  if (e.kind === 'device') {
    const id = Number(e.ref);
    if (!Number.isInteger(id) || !req.user || !roleAtLeast(await roleOnDevice(req.user, id), 'operator')) return { error: 'Device not found', status: 404 };
    const d = await queryOne<{ site_id: number | null }>(`SELECT site_id FROM devices WHERE id = $1`, [id]);
    return { end: { kind: 'device', ref: id }, site: d?.site_id ?? null };
  }
  if (e.kind === 'node') {
    const node = await queryOne<TopoNodeRow>(`SELECT * FROM topology_nodes WHERE id = $1`, [Number(e.ref)]);
    if (!node || !canWriteNode(req, node)) return { error: 'Node not found', status: 404 };
    return { end: { kind: 'node', ref: node.id }, site: node.site_id };
  }
  const ref = String(e.ref ?? '');
  if (!EXTERNAL_REF.test(ref)) return { error: 'Not a neighbour on the map', status: 400 };
  return { end: { kind: 'external', ref, name: e.name ? String(e.name).slice(0, 255) : null }, site: null };
}

/** Write access to a link: operator or better in its site. */
function canWriteLink(req: Request, link: { site_id: number | null }): boolean {
  return !!req.user && roleAtLeast(roleInSite(req.user, link.site_id), 'operator');
}

async function createHandLink(req: Request, res: Response, rawA: unknown, rawB: unknown, label: unknown) {
  const a = await checkEnd(req, rawA);
  if ('error' in a) return res.status(a.status).json({ error: a.error });
  const b = await checkEnd(req, rawB);
  if ('error' in b) return res.status(b.status).json({ error: b.error });
  if (a.end.kind === b.end.kind && String(a.end.ref) === String(b.end.ref)) {
    return res.status(400).json({ error: 'A link needs two different ends' });
  }
  // The site of a managed end; a link between two neighbours joins the site in view.
  let site = a.site ?? b.site;
  if (site == null) {
    const t = targetSite(req);
    if (!t.ok) return res.status(t.status).json({ error: t.error });
    site = t.siteId;
  }
  const col = (e: End) => [
    e.kind === 'device' ? e.ref : null, e.kind === 'node' ? e.ref : null,
    e.kind === 'external' ? e.ref : null, e.kind === 'external' ? e.name ?? null : null,
  ];
  try {
    const row = await queryOne<HandLinkRow>(
      `INSERT INTO topology_hand_links
         (site_id, a_device_id, a_node_id, a_external, a_external_name, b_device_id, b_node_id, b_external, b_external_name, label)
       VALUES (COALESCE($1::int, (SELECT id FROM sites ORDER BY is_default DESC, id LIMIT 1)), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [site, ...col(a.end), ...col(b.end), label ? String(label).slice(0, 100) : null]
    );
    return res.status(201).json(toHandLink(row!));
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return res.status(409).json({ error: 'Those two are already linked' });
    throw err;
  }
}

// POST /api/topology/hand-links { a: { kind, ref, name? }, b: { kind, ref, name? }, label? }
router.post('/hand-links', requireWrite, async (req: Request, res: Response) => {
  await createHandLink(req, res, req.body?.a, req.body?.b, req.body?.label);
});

// DELETE /api/topology/hand-links/:id
router.delete('/hand-links/:id', requireWrite, async (req: Request, res: Response) => {
  const row = await queryOne<HandLinkRow>(`SELECT * FROM topology_hand_links WHERE id = $1`, [req.params.id]);
  if (!row || !canWriteLink(req, row)) return res.status(404).json({ error: 'Link not found' });
  await query(`DELETE FROM topology_hand_links WHERE id = $1`, [row.id]);
  return res.json({ ok: true });
});

// POST /api/topology/discover
router.post('/discover', requireWrite, async (req: Request, res: Response) => {
  // Only the devices in view: a site-scoped account can't trigger polls of other sites (P1-7).
  const scope = siteScopeDevices(writableScope(req));
  const devices = await query<{ id: number }>(`SELECT id FROM devices WHERE status='online' AND NOT ssh_only ${scope ? `AND ${scope}` : ''}`);
  if (pollerService) {
    for (const d of devices) {
      await pollerService.scheduleDeviceSync(d.id, 'slow');
    }
  }
  res.json({ message: `Discovery triggered for ${devices.length} device(s)` });
});

// ─── The arrangement of the map (#147) ──────────────────────────────────────

const LAYOUT_KEY = /^[A-Za-z0-9:_.|@-]{1,400}$/;
const HANDLES = new Set(['t', 'b', 'l', 'r']);
const MAX_LAYOUT_ENTRIES = 20_000;

// PUT /api/topology/layout { positions?: { key: {x, y} }, anchors?: { key: {sourceHandle, targetHandle} | null } }
// Merged into what is saved: keys not sent are left alone.
router.put('/layout', requireWrite, async (req: Request, res: Response) => {
  const positions = (req.body?.positions ?? {}) as Record<string, { x?: unknown; y?: unknown }>;
  const anchors = (req.body?.anchors ?? {}) as Record<string, { sourceHandle?: unknown; targetHandle?: unknown } | null>;
  const pos = Object.entries(positions);
  const anc = Object.entries(anchors);
  if (pos.length + anc.length > MAX_LAYOUT_ENTRIES) return res.status(400).json({ error: 'Too many entries' });
  const keys: string[] = []; const xs: number[] = []; const ys: number[] = [];
  for (const [k, v] of pos) {
    const x = Number(v?.x); const y = Number(v?.y);
    if (!LAYOUT_KEY.test(k) || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) {
      return res.status(400).json({ error: `Bad position for ${k.slice(0, 60)}` });
    }
    keys.push(k); xs.push(x); ys.push(y);
  }
  const setKeys: string[] = []; const srcs: (string | null)[] = []; const tgts: (string | null)[] = []; const clear: string[] = [];
  for (const [k, v] of anc) {
    if (!LAYOUT_KEY.test(k)) return res.status(400).json({ error: `Bad link id ${k.slice(0, 60)}` });
    if (v === null) { clear.push(k); continue; }
    const s = v.sourceHandle == null ? null : String(v.sourceHandle);
    const t = v.targetHandle == null ? null : String(v.targetHandle);
    if ((s && !HANDLES.has(s)) || (t && !HANDLES.has(t))) return res.status(400).json({ error: 'A handle is t, b, l or r' });
    setKeys.push(k); srcs.push(s); tgts.push(t);
  }
  if (keys.length) {
    await query(
      `INSERT INTO topology_positions (node_key, x, y, updated_at)
       SELECT * , NOW() FROM unnest($1::text[], $2::float8[], $3::float8[])
       ON CONFLICT (node_key) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = NOW()`,
      [keys, xs, ys]);
  }
  if (setKeys.length) {
    await query(
      `INSERT INTO topology_edge_anchors (edge_key, source_handle, target_handle, updated_at)
       SELECT *, NOW() FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (edge_key) DO UPDATE SET source_handle = EXCLUDED.source_handle, target_handle = EXCLUDED.target_handle, updated_at = NOW()`,
      [setKeys, srcs, tgts]);
  }
  if (clear.length) await query(`DELETE FROM topology_edge_anchors WHERE edge_key = ANY($1::text[])`, [clear]);
  return res.json({ ok: true, positions: keys.length, anchors: setKeys.length + clear.length });
});

// POST /api/topology/layout/reset { keys: [...], edges: [...] } — forget the
// arrangement of what's in view, so it is laid out automatically again.
router.post('/layout/reset', requireWrite, async (req: Request, res: Response) => {
  const keys = Array.isArray(req.body?.keys) ? (req.body.keys as unknown[]).map(String).filter((k) => LAYOUT_KEY.test(k)) : [];
  const edges = Array.isArray(req.body?.edges) ? (req.body.edges as unknown[]).map(String).filter((k) => LAYOUT_KEY.test(k)) : [];
  if (keys.length) await query(`DELETE FROM topology_positions WHERE node_key = ANY($1::text[])`, [keys.slice(0, MAX_LAYOUT_ENTRIES)]);
  if (edges.length) await query(`DELETE FROM topology_edge_anchors WHERE edge_key = ANY($1::text[])`, [edges.slice(0, MAX_LAYOUT_ENTRIES)]);
  return res.json({ ok: true });
});

// POST /api/topology/manual-links { from_device_id, to_device_id, label? } — the
// older form, for scripts: a hand-drawn link between two managed devices.
router.post('/manual-links', requireWrite, async (req: Request, res: Response) => {
  const { from_device_id, to_device_id, label } = req.body as { from_device_id?: number; to_device_id?: number; label?: string };
  if (!from_device_id || !to_device_id) return res.status(400).json({ error: 'from_device_id and to_device_id are required' });
  await createHandLink(req, res, { kind: 'device', ref: from_device_id }, { kind: 'device', ref: to_device_id }, label);
});

// DELETE /api/topology/manual-links/:id — the same as DELETE /hand-links/:id
router.delete('/manual-links/:id', requireWrite, async (req: Request, res: Response) => {
  const row = await queryOne<HandLinkRow>(`SELECT * FROM topology_hand_links WHERE id = $1`, [req.params.id]);
  if (!row || !canWriteLink(req, row)) return res.status(404).json({ error: 'Link not found' });
  await query(`DELETE FROM topology_hand_links WHERE id = $1`, [row.id]);
  return res.json({ ok: true });
});

export default router;
