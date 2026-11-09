import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { deviceSiteAccess, deviceIdQuery, strictId } from '../utils/siteAccess';
import { deviceWriteLock, deviceIdFromQuery } from '../services/changeGuard/deviceLock';
import { withGuardedChange } from '../services/changeGuard/guardedRoute';
import { DeviceCollector, type DeviceRow } from '../services/mikrotik/DeviceCollector';

const router = Router();
router.use(requireAuth);
router.use(deviceSiteAccess(deviceIdQuery));
router.use(deviceWriteLock(deviceIdFromQuery));

const KINDS = ['ipsec', 'pppoe-server', 'ppp-session', 'pppoe-client', 'eoip', 'gre', 'ipip'];

/**
 * GET /api/tunnels — IPsec peers, PPPoE servers and clients, active PPP
 * sessions and EoIP/GRE/IPIP tunnels the slow polls found (#310), across the
 * fleet or the selected site, down ones first. `?deviceId=` and `?kind=`
 * narrow it. Read-only.
 */
router.get('/', async (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = siteScopeByDevice(activeSite(req), 't.device_id');
  if (scope) where.push(scope);
  if (req.query.deviceId !== undefined) {
    const deviceId = Number(req.query.deviceId);
    if (!Number.isInteger(deviceId)) return res.status(400).json({ error: 'deviceId must be a number' });
    params.push(deviceId);
    where.push(`t.device_id = $${params.length}`);
  }
  if (req.query.kind !== undefined) {
    if (!KINDS.includes(String(req.query.kind))) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    params.push(String(req.query.kind));
    where.push(`t.kind = $${params.length}`);
  }
  const rows = await query(
    `SELECT t.device_id, d.name AS device_name, d.status AS device_status, t.kind, t.tunnel_key, t.name,
            t.local_address, t.remote_address, t.detail, t.status, t.state, t.uptime,
            t.last_up_at, t.last_change_at, t.updated_at
       FROM device_tunnels t JOIN devices d ON d.id = t.device_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE t.status WHEN 'down' THEN 0 WHEN 'idle' THEN 1 WHEN 'up' THEN 2 ELSE 3 END,
               d.name, t.kind, t.name`,
    params
  );
  return res.json(rows);
});

// ─── PPP users, servers and sessions (Hector, Discussion #85) ───────────────
//
// Read live for one router; changing a user or a PPPoE server runs under
// Change Guard and can be reviewed first. Disconnecting a session changes no
// configuration, so it doesn't. Passwords are never read.

type Ppp = Awaited<ReturnType<DeviceCollector['getPpp']>>;
const yes = (v: string | undefined) => v === 'true' || v === 'yes';

function deviceIdParam(req: Request, res: Response): number | null {
  const id = strictId(req.query.deviceId);
  if (!id) { res.status(400).json({ error: 'deviceId query param is required' }); return null; }
  return id;
}

async function readPpp(id: number): Promise<{ device: DeviceRow; ppp: Ppp } | { status: number; error: string }> {
  const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return { status: 404, error: 'Device not found' };
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    return { device, ppp: await c.getPpp() };
  } catch (err) {
    return { status: 502, error: `Couldn't read the device: ${(err as Error).message}` };
  } finally {
    c.disconnect();
  }
}

/** After a change, the fleet list catches up without waiting for the slow poll. */
const refreshTunnels = async (c: DeviceCollector) => { await c.collectTunnels(); };

// GET /api/tunnels/ppp?deviceId= — users, PPPoE servers and sessions, live.
router.get('/ppp', async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readPpp(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const online = new Map<string, number>();
  for (const s of r.ppp.sessions) online.set(s['name'] ?? '', (online.get(s['name'] ?? '') ?? 0) + 1);
  return res.json({
    users: r.ppp.secrets.map((u) => ({
      id: u['.id'], name: u['name'] ?? '', service: u['service'] || 'any', profile: u['profile'] || null,
      remote_address: u['remote-address'] || null, disabled: yes(u['disabled']), comment: u['comment'] || null,
      last_logged_out: u['last-logged-out'] || null, last_caller_id: u['last-caller-id'] || null,
      last_disconnect_reason: u['last-disconnect-reason'] || null, sessions: online.get(u['name'] ?? '') ?? 0,
    })),
    servers: r.ppp.servers.map((v) => ({
      id: v['.id'], service_name: v['service-name'] || 'pppoe', interface: v['interface'] || null, disabled: yes(v['disabled']),
    })),
    sessions: r.ppp.sessions.map((s) => ({
      id: s['.id'], name: s['name'] ?? '', service: s['service'] || 'ppp', caller_id: s['caller-id'] || null,
      address: s['address'] && s['address'] !== '0.0.0.0' ? s['address'] : null, uptime: s['uptime'] || null,
    })),
  });
});

// PUT /api/tunnels/ppp/user?deviceId= { id, disabled } — turn a PPP user on or off.
// Turning one off doesn't end a session it already has: disconnect that too.
router.put('/ppp/user', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const { id: userId, disabled } = req.body ?? {};
  if (typeof userId !== 'string' || !userId) return res.status(400).json({ error: 'id is required' });
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be true or false' });
  const r = await readPpp(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const user = r.ppp.secrets.find((u) => u['.id'] === userId);
  if (!user) return res.status(404).json({ error: 'That PPP user is no longer on the device. Refresh and try again.' });
  if (yes(user['disabled']) === disabled) return res.json({ message: `${user['name']} is already ${disabled ? 'off' : 'on'}` });
  await withGuardedChange(id, req, res,
    { kind: 'ppp.user', summary: `${disabled ? 'Disable' : 'Enable'} PPP user ${user['name']}` },
    async (c) => { await c.setPppSecretDisabled(userId, disabled); return { message: `${user['name']} is ${disabled ? 'off' : 'on'}` }; });
});

// PUT /api/tunnels/ppp/server?deviceId= { id, disabled } — a PPPoE server on or
// off. Off ends every session on it.
router.put('/ppp/server', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const { id: serverId, disabled } = req.body ?? {};
  if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'id is required' });
  if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be true or false' });
  const r = await readPpp(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const server = r.ppp.servers.find((v) => v['.id'] === serverId);
  if (!server) return res.status(404).json({ error: 'That PPPoE server is no longer on the device. Refresh and try again.' });
  const label = `PPPoE server ${server['service-name'] || 'pppoe'} on ${server['interface'] ?? '?'}`;
  if (yes(server['disabled']) === disabled) return res.json({ message: `The ${label} is already ${disabled ? 'off' : 'on'}` });
  await withGuardedChange(id, req, res,
    { kind: 'ppp.server', summary: `${disabled ? 'Disable' : 'Enable'} ${label}` },
    async (c) => { await c.setPppoeServerDisabled(serverId, disabled); return { message: `The ${label} is ${disabled ? 'off' : 'on'}` }; },
    refreshTunnels);
});

// POST /api/tunnels/ppp/disconnect?deviceId= { id, name, confirm_managed? } —
// end one session. The name must still match, as session ids are reused. A
// session whose address is a managed device's needs confirm_managed: ending it
// can cut the manager off from that device until it dials back.
router.post('/ppp/disconnect', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const { id: sessionId, name } = req.body ?? {};
  if (typeof sessionId !== 'string' || !sessionId || typeof name !== 'string') {
    return res.status(400).json({ error: 'id and name are required' });
  }
  const r = await readPpp(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const session = r.ppp.sessions.find((s) => s['.id'] === sessionId && (s['name'] ?? '') === name);
  if (!session) return res.json({ message: `${name || 'That session'} has already disconnected` });
  const address = session['address'];
  if (address && req.body?.confirm_managed !== true) {
    const managed = await queryOne<{ name: string }>(`SELECT name FROM devices WHERE ip_address = $1 LIMIT 1`, [address]);
    if (managed) {
      return res.status(409).json({
        managed_device: managed.name,
        error: `This session is ${managed.name}, a managed device (${address}). Disconnecting it drops the manager's connection to it until it dials back in.`,
      });
    }
  }
  const c = new DeviceCollector(r.device);
  try {
    await c.connect();
    await c.removePppActive(sessionId);
    await c.collectTunnels().catch(() => undefined);
  } catch (err) {
    return res.status(502).json({ error: `Couldn't disconnect ${name}: ${(err as Error).message}` });
  } finally {
    c.disconnect();
  }
  return res.json({ message: `Disconnected ${name}${address ? ` (${address})` : ''}` });
});

export default router;
