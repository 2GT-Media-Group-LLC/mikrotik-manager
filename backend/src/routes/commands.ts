/**
 * Bulk command execution across devices (#118).
 *
 * The dry run is not decoration. This endpoint family can misconfigure an entire
 * fleet in one call, and the difference between a tool and an accident is being
 * able to see what will happen first.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, requireWrite } from '../middleware/auth';
import { query, queryOne } from '../config/database';
import { commandRunner } from '../services/CommandRunner';

const router = Router();
router.use(requireAuth);

/** Commands that change how a device is reached, and so deserve a warning. */
const RISKY_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\/ip\/?\s*address\s+(remove|set)/i, why: 'changes IP addressing, which can remove the management address' },
  { pattern: /\/ip\/?\s*route\s+(remove|set)/i, why: 'changes routing, which can cut the path back to this server' },
  { pattern: /\/ip\/?\s*firewall/i, why: 'edits firewall rules, which can block management access' },
  { pattern: /\/interface\/?\s*\w*\s*(disable|remove)/i, why: 'disables or removes an interface, possibly the one in use' },
  { pattern: /\/system\/?\s*(reboot|shutdown|reset-configuration)/i, why: 'reboots, shuts down or resets the device' },
  { pattern: /\/user\s+(remove|set|disable)/i, why: 'changes user accounts, which can revoke this server’s access' },
  { pattern: /\/ip\/?\s*service\s+(disable|set|remove)/i, why: 'changes management services such as the API or SSH' },
];

function assessCommand(command: string): { risky: boolean; reasons: string[] } {
  const reasons = RISKY_PATTERNS.filter((r) => r.pattern.test(command)).map((r) => r.why);
  return { risky: reasons.length > 0, reasons };
}

/**
 * POST /api/commands/preview — what would happen, without doing it.
 *
 * Returns the devices, their wave assignment, and any reason the command looks
 * capable of severing management. Warnings only: the operator decides.
 */
router.post('/preview', async (req: Request, res: Response) => {
  const { command, device_ids, wave_size } = req.body as
    { command?: string; device_ids?: number[]; wave_size?: number };

  if (!command?.trim()) return res.status(400).json({ error: 'command is required' });
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ error: 'device_ids array is required' });
  }

  const size = Math.max(1, Math.min(50, Number(wave_size) || 1));
  const devices = await query<{ id: number; name: string; ip_address: string; status: string }>(
    `SELECT id, name, ip_address, status FROM devices WHERE id = ANY($1::int[]) ORDER BY name`,
    [device_ids]
  );

  // Devices without any SSH credential cannot be reached at all; saying so now
  // is better than a wave of identical authentication failures.
  const unreachable = await query<{ id: number; name: string }>(
    `SELECT d.id, d.name FROM devices d
      WHERE d.id = ANY($1::int[])
        AND d.ssh_username IS NULL AND d.api_username IS NULL`,
    [device_ids]
  );

  res.json({
    command,
    ...assessCommand(command),
    wave_size: size,
    devices: devices.map((d, i) => ({ ...d, wave: Math.floor(i / size) + 1 })),
    waves: Math.ceil(devices.length / size),
    unreachable,
  });
});

// POST /api/commands/runs — create a run, optionally starting it immediately
router.post('/runs', requireWrite, async (req: Request, res: Response) => {
  const {
    name, command, device_ids, wave_size, halt_on_failure, use_change_guard, start,
  } = req.body as {
    name?: string; command?: string; device_ids?: number[]; wave_size?: number;
    halt_on_failure?: boolean; use_change_guard?: boolean; start?: boolean;
  };

  if (!command?.trim()) return res.status(400).json({ error: 'command is required' });
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ error: 'device_ids array is required' });
  }

  const size = Math.max(1, Math.min(50, Number(wave_size) || 1));
  const run = await queryOne<{ id: number }>(
    `INSERT INTO command_runs
       (name, command, wave_size, halt_on_failure, use_change_guard, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      (name?.trim() || command.trim()).slice(0, 120),
      command.trim(),
      size,
      halt_on_failure !== false,
      // Guards are opt-out, never opt-in. Someone who has not thought about it
      // gets the protected behaviour.
      use_change_guard !== false,
      (req as unknown as { user?: { username?: string } }).user?.username ?? null,
    ]
  );

  const ordered = await query<{ id: number }>(
    `SELECT id FROM devices WHERE id = ANY($1::int[]) ORDER BY name`, [device_ids]
  );
  for (const [i, d] of ordered.entries()) {
    await query(
      `INSERT INTO command_run_devices (run_id, device_id, wave) VALUES ($1,$2,$3)`,
      [run!.id, d.id, Math.floor(i / size) + 1]
    );
  }

  if (start) {
    try {
      await commandRunner.start(run!.id);
    } catch (e) {
      return res.status(409).json({ error: (e as Error).message, id: run!.id });
    }
  }
  res.status(201).json({ id: run!.id });
});

// GET /api/commands/runs — recent runs with progress
router.get('/runs', async (_req: Request, res: Response) => {
  const runs = await query(
    `SELECT r.*,
            COUNT(d.*)::int AS total,
            COUNT(*) FILTER (WHERE d.status = 'success')::int AS succeeded,
            COUNT(*) FILTER (WHERE d.status IN ('failed','reverted'))::int AS failed
       FROM command_runs r
       LEFT JOIN command_run_devices d ON d.run_id = r.id
      GROUP BY r.id ORDER BY r.id DESC LIMIT 25`
  );
  res.json(runs);
});

// GET /api/commands/runs/:id — one run with per-device output
router.get('/runs/:id', async (req: Request, res: Response) => {
  const run = await queryOne(`SELECT * FROM command_runs WHERE id = $1`, [req.params.id]);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const devices = await query(
    `SELECT rd.*, d.name AS device_name, d.ip_address
       FROM command_run_devices rd
       JOIN devices d ON d.id = rd.device_id
      WHERE rd.run_id = $1 ORDER BY rd.wave, d.name`,
    [req.params.id]
  );
  res.json({ ...run, devices });
});

// POST /api/commands/runs/:id/start
router.post('/runs/:id/start', requireWrite, async (req: Request, res: Response) => {
  try {
    await commandRunner.start(Number(req.params.id));
    res.json({ message: 'Run started' });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// POST /api/commands/runs/:id/cancel — stop before the next wave
router.post('/runs/:id/cancel', requireWrite, async (req: Request, res: Response) => {
  commandRunner.cancel(Number(req.params.id));
  // Devices already running finish; cancellation prevents the next wave, which
  // is the only point at which stopping is safe.
  res.json({ message: 'Cancellation requested. Waves already running will finish.' });
});

export default router;
