/**
 * Bulk command execution across devices (#118).
 *
 * The dry run is not decoration. This endpoint family can misconfigure an entire
 * fleet in one call, and the difference between a tool and an accident is being
 * able to see what will happen first.
 */
import { Router } from 'express';
import { devicesDenied, type Role } from '../utils/siteAccess';
import type { Request, Response } from 'express';
import { requireAuth, requireWrite, isSiteScoped } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { query, queryOne } from '../config/database';
import { commandRunner } from '../services/CommandRunner';

const router = Router();
router.use(requireAuth);

import { assessCommand } from '../utils/commandRisk';
import { spreadsheetSafe } from '../utils/csvSafe';

/**
 * POST /api/commands/preview — what would happen, without doing it.
 *
 * Returns the devices, their wave assignment, and any reason the command looks
 * capable of severing management. Warnings only: the operator decides.
 */
/**
 * Site-scoped accounts (P1-7): every device named must be one the account can
 * act on at `min`. Answers as "not found" so other sites' ids stay hidden.
 */
async function refuseForeignDevices(req: Request, res: Response, ids: number[], min: Role): Promise<boolean> {
  if (!isSiteScoped(req.user)) return false;
  const denied = await devicesDenied(req.user!, ids, min);
  if (denied.length === 0) return false;
  res.status(404).json({ error: `${denied.length} of the selected devices were not found.` });
  return true;
}

/** A run is a site-scoped account's only if every device in it is. */
async function refuseForeignRun(req: Request, res: Response, runId: string | number, min: Role): Promise<boolean> {
  if (!isSiteScoped(req.user)) return false;
  const rows = await query<{ device_id: number }>(`SELECT device_id FROM command_run_devices WHERE run_id = $1`, [runId]);
  if (rows.length > 0 && (await devicesDenied(req.user!, rows.map((r) => r.device_id), min)).length === 0) return false;
  res.status(404).json({ error: 'Run not found' });
  return true;
}

router.post('/preview', async (req: Request, res: Response) => {
  const { command, device_ids, wave_size } = req.body as
    { command?: string; device_ids?: number[]; wave_size?: number };

  if (!command?.trim()) return res.status(400).json({ error: 'command is required' });
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ error: 'device_ids array is required' });
  }
  if (await refuseForeignDevices(req, res, device_ids, 'viewer')) return;

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
    name, command, device_ids, wave_size, halt_on_failure, use_change_guard, start, acknowledge_risk,
  } = req.body as {
    name?: string; command?: string; device_ids?: number[]; wave_size?: number;
    halt_on_failure?: boolean; use_change_guard?: boolean; start?: boolean; acknowledge_risk?: boolean;
  };

  if (!command?.trim()) return res.status(400).json({ error: 'command is required' });
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ error: 'device_ids array is required' });
  }
  if (await refuseForeignDevices(req, res, device_ids, 'operator')) return;

  // Change Guard off on a command that can cut management needs an explicit
  // acknowledgement, enforced here (outside review U3). It used to be checked
  // only in the page, and skipped while the preview was still loading.
  const risk = assessCommand(command);
  if (use_change_guard === false && risk.risky && acknowledge_risk !== true) {
    return res.status(400).json({
      code: 'risk_not_acknowledged',
      error: `This command ${risk.reasons.join('; ')}. With Change Guard off nothing would undo it, so confirm the risk to run it.`,
      reasons: risk.reasons,
    });
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
router.get('/runs', async (req: Request, res: Response) => {
  // A run is shown when it touched at least one device in the active site.
  const memberFilter = siteScopeByDevice(activeSite(req), 'crd.device_id');
  // A site-scoped account sees only runs entirely within its own sites (P1-7):
  // a run that also touched another site's devices would show them.
  const ownSites = isSiteScoped(req.user) ? siteScopeByDevice(Object.keys(req.user!.siteRoles!).map(Number), 'x.device_id') : null;
  const conditions = [
    memberFilter ? `EXISTS (SELECT 1 FROM command_run_devices crd WHERE crd.run_id = r.id AND ${memberFilter})` : null,
    ownSites ? `NOT EXISTS (SELECT 1 FROM command_run_devices x WHERE x.run_id = r.id AND NOT (${ownSites}))` : null,
  ].filter(Boolean);
  const runs = await query(
    `SELECT r.*,
            COUNT(d.*)::int AS total,
            COUNT(*) FILTER (WHERE d.status = 'success')::int AS succeeded,
            COUNT(*) FILTER (WHERE d.status IN ('failed','reverted'))::int AS failed
       FROM command_runs r
       LEFT JOIN command_run_devices d ON d.run_id = r.id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      GROUP BY r.id ORDER BY r.id DESC LIMIT 25`
  );
  res.json(runs);
});

// GET /api/commands/runs/:id — one run with per-device output
router.get('/runs/:id', async (req: Request, res: Response) => {
  if (await refuseForeignRun(req, res, req.params.id, 'viewer')) return;
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

/**
 * GET /api/commands/runs/:id/export — the run as a downloadable record.
 *
 * Asked for on #118 for archiving and audit. CSV rather than JSON because the
 * audience is a spreadsheet or a ticket attachment, and output is quoted so a
 * multi-line device response survives the round trip intact.
 */
router.get('/runs/:id/export', async (req: Request, res: Response) => {
  if (await refuseForeignRun(req, res, req.params.id, 'viewer')) return;
  const run = await queryOne<{ id: number; name: string; command: string; status: string; created_at: string }>(
    `SELECT id, name, command, status, created_at FROM command_runs WHERE id = $1`, [req.params.id]
  );
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const rows = await query<{
    device_name: string; ip_address: string; wave: number; status: string;
    output: string | null; error: string | null; guarded: boolean;
    started_at: string | null; finished_at: string | null;
  }>(
    `SELECT d.name AS device_name, d.ip_address, rd.wave, rd.status, rd.output, rd.error,
            rd.guarded, rd.started_at, rd.finished_at
       FROM command_run_devices rd JOIN devices d ON d.id = rd.device_id
      WHERE rd.run_id = $1 ORDER BY rd.wave, d.name`,
    [req.params.id]
  );

  // Timestamps arrive from the driver as Date objects, whose default string form
  // ("Thu Sep 03 2026 15:45:29 GMT+0000 (Coordinated Universal Time)") no
  // spreadsheet will parse. ISO is both sortable and machine-readable.
  const esc = (v: unknown) => {
    // Text is made formula-safe; numbers and dates are left as they are (U9).
    const t = v == null ? '' : v instanceof Date ? v.toISOString()
      : typeof v === 'string' ? spreadsheetSafe(v) : String(v);
    // Always quote: output routinely contains commas, quotes and newlines, and
    // a record that cannot be reopened is not an archive.
    return `"${t.replace(/"/g, '""')}"`;
  };

  const lines = [
    ['run_id', 'run_name', 'command', 'run_status', 'device', 'ip_address', 'wave',
     'status', 'guarded', 'started_at', 'finished_at', 'output', 'error'].join(','),
    ...rows.map((r) => [
      run.id, run.name, run.command, run.status, r.device_name.trim(), r.ip_address, r.wave,
      r.status, r.guarded, r.started_at ?? '', r.finished_at ?? '', r.output ?? '', r.error ?? '',
    ].map(esc).join(',')),
  ];

  const stamp = new Date(run.created_at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="command-run-${run.id}-${stamp}.csv"`);
  res.send(lines.join('\n'));
});

// POST /api/commands/runs/:id/start
router.post('/runs/:id/start', requireWrite, async (req: Request, res: Response) => {
  if (await refuseForeignRun(req, res, req.params.id, 'operator')) return;
  try {
    await commandRunner.start(Number(req.params.id));
    res.json({ message: 'Run started' });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// POST /api/commands/runs/:id/cancel — stop before the next wave
router.post('/runs/:id/cancel', requireWrite, async (req: Request, res: Response) => {
  if (await refuseForeignRun(req, res, req.params.id, 'operator')) return;
  commandRunner.cancel(Number(req.params.id));
  // Devices already running finish; cancellation prevents the next wave, which
  // is the only point at which stopping is safe.
  res.json({ message: 'Cancellation requested. Waves already running will finish.' });
});

export default router;
