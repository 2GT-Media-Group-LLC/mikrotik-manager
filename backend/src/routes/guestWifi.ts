import { Router, Request, Response } from 'express';
import { deviceWriteLock, deviceIdFromQuery } from '../services/changeGuard/deviceLock';
import { withGuardedChange } from '../services/changeGuard/guardedRoute';
import { randomBytes } from 'crypto';
import { queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { maskSecretsForReadOnly } from '../utils/redactSecrets';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';

const router = Router();
router.use(requireAuth);
// Viewers and read-only tokens never receive device secrets (Wi-Fi keys,
// WireGuard private keys, SNMP communities, hotspot passwords).
router.use(maskSecretsForReadOnly);
// One write at a time per device, so a Change Guard revert can't undo another write.
router.use(deviceWriteLock(deviceIdFromQuery));

async function getDevice(id: number): Promise<DeviceRow | null> {
  return queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
}

/** ?deviceId= or body.deviceId, as a number; 0 when missing. */
function requestDeviceId(req: Request): number {
  return parseInt(String(req.query.deviceId ?? (req.body as { deviceId?: number })?.deviceId ?? ''), 10) || 0;
}

// Run fn against a connected collector for ?deviceId= / body.deviceId
async function withDevice<T>(
  req: Request, res: Response,
  fn: (c: DeviceCollector) => Promise<T>
): Promise<T | undefined> {
  const deviceId = parseInt(String(req.query.deviceId ?? (req.body as { deviceId?: number })?.deviceId ?? ''), 10);
  if (!deviceId) { res.status(400).json({ error: 'deviceId is required' }); return undefined; }
  const device = await getDevice(deviceId);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return undefined; }
  const collector = new DeviceCollector(device);
  try {
    await collector.connect();
    return await fn(collector);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return undefined;
  } finally {
    collector.disconnect();
  }
}

// ─── Overview ────────────────────────────────────────────────────────────────

// GET /api/guest-wifi/overview?deviceId=
router.get('/overview', async (req: Request, res: Response) => {
  const result = await withDevice(req, res, async (c) => {
    const [servers, profiles, userProfiles, users, active, interfaces] = await Promise.all([
      c.getHotspotServers(), c.getHotspotProfiles(), c.getHotspotUserProfiles(),
      c.getHotspotUsers(), c.getHotspotActive(),
      c.getInterfacesLive().catch(() => [] as Record<string, string>[]),
    ]);
    return {
      servers, profiles, userProfiles,
      userCount: users.length,
      activeCount: active.length,
      interfaces: interfaces
        .filter(i => /^(bridge|vlan|wifi|wlan|ether)/i.test(i['name'] || '') && i['disabled'] !== 'true')
        .map(i => ({ name: i['name'], type: i['type'] || '' })),
    };
  });
  if (result !== undefined) res.json(result);
});

// ─── Guided setup ─────────────────────────────────────────────────────────────

// POST /api/guest-wifi/setup
router.post('/setup', requireWrite, async (req: Request, res: Response) => {
  const { name, interfaceName, gatewayCidr, poolRange, dnsName, rateLimit } = req.body as Record<string, string>;
  const { ssid, vlanId, masquerade } = req.body as {
    ssid?: { ssid?: string; passphrase?: string }; vlanId?: number; masquerade?: boolean;
  };
  if (!name || !/^[a-z0-9-]{2,24}$/i.test(name)) { res.status(400).json({ error: 'name (2-24 alphanumeric/dash) is required' }); return; }
  if (!ssid?.ssid && !interfaceName) { res.status(400).json({ error: 'Provide a guest SSID to create, or an existing interfaceName' }); return; }
  if (ssid?.ssid && (ssid.ssid.length < 1 || ssid.ssid.length > 32)) { res.status(400).json({ error: 'SSID must be 1-32 characters' }); return; }
  if (ssid?.passphrase && ssid.passphrase.length < 8) { res.status(400).json({ error: 'Passphrase must be at least 8 characters (or empty for an open network)' }); return; }
  if (vlanId !== undefined && (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094)) { res.status(400).json({ error: 'vlanId must be 1-4094' }); return; }
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(gatewayCidr || '')) { res.status(400).json({ error: 'gatewayCidr must look like 10.5.50.1/24' }); return; }
  if (!/^\d{1,3}(\.\d{1,3}){3}-\d{1,3}(\.\d{1,3}){3}$/.test(poolRange || '')) { res.status(400).json({ error: 'poolRange must look like 10.5.50.10-10.5.50.254' }); return; }
  if (rateLimit && !/^\d+[kMG]?\/\d+[kMG]?$/.test(rateLimit)) { res.status(400).json({ error: 'rateLimit must look like 10M/10M (rx/tx)' }); return; }

  const deviceId = requestDeviceId(req);
  if (!deviceId) { res.status(400).json({ error: 'deviceId is required' }); return; }
  // Guarded (outside review P2-8): a hotspot on the interface the manager
  // arrives on puts it behind the hotspot's own firewall rules. Setup is several
  // steps, so the device gets longer before it would restore itself.
  await withGuardedChange(deviceId, req, res,
    {
      kind: 'hotspot.setup',
      summary: `Set up guest network '${name}'`,
      timeoutSec: 300,
      change: interfaceName ? { kind: 'path-object.change', name: interfaceName, what: 'Putting a hotspot on it' } : undefined,
    },
    (c) => c.setupGuestNetwork({
      name: name.toLowerCase(), gatewayCidr, poolRange, dnsName, rateLimit,
      interfaceName: interfaceName || undefined,
      ssid: ssid?.ssid ? { ssid: ssid.ssid, passphrase: ssid.passphrase || undefined } : undefined,
      vlanId, masquerade: masquerade !== false,
    }));
});

// ─── Vouchers (hotspot users) ─────────────────────────────────────────────────

// Human-friendly voucher codes: no ambiguous chars (0/O, 1/I/L)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode(len = 8): string {
  const n = CODE_CHARS.length;
  // Rejection sampling: discard bytes at or above the largest multiple of n so
  // the modulo is uniform (avoids the slight bias of a raw byte % n).
  const limit = Math.floor(256 / n) * n;
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len)) {
      if (b < limit) {
        out += CODE_CHARS[b % n];
        if (out.length === len) break;
      }
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// GET /api/guest-wifi/users?deviceId=
router.get('/users', async (req: Request, res: Response) => {
  const result = await withDevice(req, res, (c) => c.getHotspotUsers());
  if (result !== undefined) res.json(result);
});

// POST /api/guest-wifi/vouchers — batch-create voucher users
router.post('/vouchers', requireWrite, async (req: Request, res: Response) => {
  const { count, durationHours, dataCapMB, userProfile } = req.body as {
    count?: number; durationHours?: number; dataCapMB?: number; userProfile?: string;
  };
  const n = Math.min(Math.max(parseInt(String(count ?? 1), 10) || 1, 1), 100);

  const result = await withDevice(req, res, async (c) => {
    const existing = new Set((await c.getHotspotUsers()).map(u => u['name']));
    const batch = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const codes: string[] = [];
    for (let i = 0; i < n; i++) {
      let code = generateCode();
      let guard = 0;
      while (existing.has(code) && guard++ < 20) code = generateCode();
      existing.add(code);
      const params: Record<string, string> = { name: code, comment: `voucher ${batch}` };
      if (userProfile) params['profile'] = userProfile;
      if (durationHours && durationHours > 0) params['limit-uptime'] = `${Math.floor(durationHours)}h`;
      if (dataCapMB && dataCapMB > 0) params['limit-bytes-total'] = String(Math.floor(dataCapMB) * 1024 * 1024);
      await c.addHotspotUser(params);
      codes.push(code);
    }
    return { created: codes.length, codes };
  });
  if (result !== undefined) res.status(201).json(result);
});

// DELETE /api/guest-wifi/users/:id?deviceId=
router.delete('/users/:id', requireWrite, async (req: Request, res: Response) => {
  const result = await withDevice(req, res, async (c) => {
    await c.removeHotspotUser(req.params.id);
    return { ok: true };
  });
  if (result !== undefined) res.json(result);
});

// ─── Active sessions ──────────────────────────────────────────────────────────

// GET /api/guest-wifi/active?deviceId=
router.get('/active', async (req: Request, res: Response) => {
  const result = await withDevice(req, res, (c) => c.getHotspotActive());
  if (result !== undefined) res.json(result);
});

// DELETE /api/guest-wifi/active/:id?deviceId= — kick a guest
router.delete('/active/:id', requireWrite, async (req: Request, res: Response) => {
  const result = await withDevice(req, res, async (c) => {
    await c.disconnectHotspotActive(req.params.id);
    return { ok: true };
  });
  if (result !== undefined) res.json(result);
});

// ─── Walled garden ────────────────────────────────────────────────────────────

router.get('/walled-garden', async (req: Request, res: Response) => {
  const result = await withDevice(req, res, (c) => c.getWalledGarden());
  if (result !== undefined) res.json(result);
});

router.post('/walled-garden', requireWrite, async (req: Request, res: Response) => {
  const { dstHost, comment } = req.body as { dstHost?: string; comment?: string };
  if (!dstHost || !dstHost.trim()) { res.status(400).json({ error: 'dstHost is required' }); return; }
  const result = await withDevice(req, res, async (c) => {
    await c.addWalledGardenEntry(dstHost.trim(), comment);
    return { ok: true };
  });
  if (result !== undefined) res.status(201).json(result);
});

router.delete('/walled-garden/:id', requireWrite, async (req: Request, res: Response) => {
  const result = await withDevice(req, res, async (c) => {
    await c.removeWalledGardenEntry(req.params.id);
    return { ok: true };
  });
  if (result !== undefined) res.json(result);
});

// ─── Server enable/disable/remove ─────────────────────────────────────────────

// Guarded: enabling a hotspot server changes how its interface filters traffic.
router.put('/servers/:id', requireWrite, async (req: Request, res: Response) => {
  const { disabled } = req.body as { disabled?: boolean };
  const deviceId = requestDeviceId(req);
  if (!deviceId) { res.status(400).json({ error: 'deviceId is required' }); return; }
  await withGuardedChange(deviceId, req, res,
    { kind: 'hotspot.server.toggle', summary: `${disabled ? 'Disable' : 'Enable'} hotspot server` },
    async (c) => { await c.setHotspotServerDisabled(req.params.id, !!disabled); return { ok: true }; });
});

router.delete('/servers/:id', requireWrite, async (req: Request, res: Response) => {
  const deviceId = requestDeviceId(req);
  if (!deviceId) { res.status(400).json({ error: 'deviceId is required' }); return; }
  await withGuardedChange(deviceId, req, res, { kind: 'hotspot.server.remove', summary: 'Remove hotspot server' },
    async (c) => { await c.removeHotspotServer(req.params.id); return { ok: true }; });
});

export default router;
