import { Router, Request, Response } from 'express';
import { requireAuth, requireWrite } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { DeviceAdoptionService } from '../services/DeviceAdoptionService';
import type { AddressPlan } from '../utils/adoption';
import type { PollerService } from '../services/PollerService';
import { query } from '../config/database';

/**
 * Adoption of factory-default devices (see utils/adoption.ts for the why).
 */
const router = Router();
router.use(requireAuth);

let service = new DeviceAdoptionService(null);

/** Injected at startup so a newly adopted device begins polling immediately. */
export function setPollerService(p: PollerService): void {
  service = new DeviceAdoptionService(p);
}

/**
 * GET /api/adoption/candidates — MikroTik devices we can see but do not manage.
 *
 * Each candidate carries the managed devices that can see it, since one of them
 * has to be borrowed to reach it. Their names are resolved here so the UI can
 * offer a jump host without a second round trip.
 */
router.get('/candidates', async (_req: Request, res: Response) => {
  const candidates = await service.listCandidates();

  const ids = [...new Set(candidates.flatMap((c) => c.seenBy))];
  const names = ids.length
    ? await query<{ id: number; name: string; ip_address: string }>(
        `SELECT id, name, ip_address FROM devices WHERE id = ANY($1::int[])`, [ids]
      )
    : [];
  const byId = new Map(names.map((n) => [n.id, n]));

  res.json({
    candidates: candidates.map((c) => ({
      ...c,
      seenBy: c.seenBy.map((id) => byId.get(id) ?? { id, name: `device ${id}`, ip_address: '' }),
    })),
  });
});

/**
 * POST /api/adoption/adopt
 *
 * Write-scoped: this changes configuration on two devices — the one being
 * adopted, and briefly the managed neighbour used to reach it.
 */
router.post('/adopt', requireWrite, async (req: Request, res: Response) => {
  const { mac, jumpHostId, plan, password, username, identity, name,
          removeFactoryAddress, force } = req.body as Record<string, unknown>;

  if (typeof mac !== 'string' || !mac.trim()) return res.status(400).json({ error: 'mac is required' });
  if (typeof jumpHostId !== 'number') return res.status(400).json({ error: 'jumpHostId is required' });
  // The addressing is a structured choice — DHCP or static, optionally on a
  // management VLAN — because inferring a prefix, a gateway and an untagged
  // bridge is three guesses about somebody else's network.
  if (!plan || typeof plan !== 'object') {
    return res.status(400).json({ error: 'plan is required (mode: "dhcp" | "static")' });
  }
  const mode = (plan as { mode?: unknown }).mode;
  if (mode !== 'dhcp' && mode !== 'static') {
    return res.status(400).json({ error: 'plan.mode must be "dhcp" or "static"' });
  }
  // No default. Every modern unit ships with its own password printed on it, so
  // there is nothing sensible to fall back to and guessing wastes a round trip
  // against a device that will simply answer 401.
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'password is required — it is printed on the device' });
  }

  const result = await service.adopt({
    mac, jumpHostId, plan: plan as AddressPlan, password,
    username: typeof username === 'string' ? username : undefined,
    identity: typeof identity === 'string' ? identity : undefined,
    name: typeof name === 'string' ? name : undefined,
    removeFactoryAddress: removeFactoryAddress !== false,
    // Opt-in only. Defaulting this to true would defeat the guard that stops
    // adoption rewriting a switch that is already in service.
    force: force === true,
    siteId: activeSite(req),
  });

  return res.status(result.ok ? 201 : 400).json(result);
});

/**
 * POST /api/adoption/check-address — is this address free?
 *
 * Exposed separately so the form can say so before anything is written, rather
 * than the operator discovering a clash only when adoption refuses.
 */
router.post('/check-address', async (req: Request, res: Response) => {
  const { address, jumpHostId } = req.body as { address?: unknown; jumpHostId?: unknown };
  if (typeof address !== 'string' || typeof jumpHostId !== 'number') {
    return res.status(400).json({ error: 'address and jumpHostId are required' });
  }
  return res.json(await service.checkAddress(jumpHostId, address));
});

/** POST /api/adoption/cleanup — drop temporary addresses a failed run left behind. */
router.post('/cleanup', requireWrite, async (_req: Request, res: Response) => {
  const removed = await service.cleanupOrphans();
  res.json({ removed });
});

export default router;
