import { Router } from 'express';
import type { Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { requireAuth, requireWrite } from '../middleware/auth';
import { query } from '../config/database';
import type { PollerService } from '../services/PollerService';

const router = Router();
router.use(requireAuth);

// Injected from index.ts, matching how the devices routes receive it.
let pollerService: PollerService | null = null;
export function setPollerService(p: PollerService): void {
  pollerService = p;
}

// The container runs `node dist/index.js` (not via npm), so npm_package_version
// is unset there — read the bundled package.json instead, falling back to it.
// Without this, current stays "0.0.0" and every release looks like an update.
function resolveCurrentVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const CURRENT_VERSION = resolveCurrentVersion();
const RAW_URL = 'https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/main/frontend/package.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Normalise "0.11.7-beta" or "v0.11.7 Beta" → [0, 11, 7]
function parseVersion(v: string): number[] {
  return v
    .toLowerCase()
    .replace(/[^0-9.]/g, ' ')
    .trim()
    .split(/[\s.]+/)
    .slice(0, 3)
    .map(Number);
}

function isNewer(latest: number[], current: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((latest[i] ?? 0) > (current[i] ?? 0)) return true;
    if ((latest[i] ?? 0) < (current[i] ?? 0)) return false;
  }
  return false;
}

// GET /api/system/version-check
// Returns { current, latest, update_available } — cached 24 h in app_settings.
/**
 * GET /api/system/poller — is the poller keeping up?
 *
 * A fleet that outruns its workers looks, from the outside, exactly like a fleet
 * of misbehaving devices: data goes stale and nothing says why. `headroom` below
 * 1.0 means the backlog grows every cycle and some devices will stop reporting
 * altogether (#114).
 */
router.get('/poller', async (_req: Request, res: Response) => {
  try {
    if (!pollerService) return res.status(503).json({ error: 'Poller not started' });
    const health = await pollerService.getPollerHealth();

    // Devices the poller has not managed to reach lately, worst first. This is
    // the list that answers "which ones is it actually missing?".
    // Stale-device listing is a nicety; never let it take the whole payload down.
    let stale: unknown[] = [];
    try {
      stale = await query(
      `SELECT d.id, d.name, d.status, s.kind,
              s.last_attempt_at, s.last_success_at, s.last_duration_ms, s.last_error,
              s.attempts, s.failures,
              EXTRACT(EPOCH FROM (NOW() - s.last_success_at))::int AS seconds_since_success
         FROM devices d
         JOIN device_poll_stats s ON s.device_id = d.id AND s.kind = 'fast'
        WHERE d.status != 'disabled'
          AND (s.last_success_at IS NULL OR s.last_success_at < NOW() - INTERVAL '3 minutes')
        ORDER BY s.last_success_at ASC NULLS FIRST
        LIMIT 50`
      );
    } catch (e) {
      console.error('Poller health: stale-device query failed:', (e as Error).message);
    }

    res.json({ ...health, stale_devices: stale });
  } catch (error) {
    console.error('Error building poller health:', error);
    res.status(500).json({ error: 'Failed to read poller health' });
  }
});

/**
 * POST /api/system/poller/drain — clear every queued poll now.
 *
 * The automatic sweep only discards jobs past their cadence, which still leaves
 * a large backlog draining for hours. Nothing is lost: the scheduler re-enqueues
 * whatever is still due on its next tick, so the cost is at most one interval of
 * freshness.
 */
router.post('/poller/drain', requireWrite, async (_req: Request, res: Response) => {
  try {
    if (!pollerService) return res.status(503).json({ error: 'Poller not started' });
    const drained = await pollerService.drainQueues();
    const total = Object.values(drained).reduce((a, b) => a + b, 0);
    res.json({ drained, total, message: `Cleared ${total} queued job(s). Polling resumes on the next cycle.` });
  } catch (error) {
    console.error('Error draining poller queues:', error);
    res.status(500).json({ error: 'Failed to drain queues' });
  }
});

router.get('/version-check', async (_req: Request, res: Response) => {
  try {
    // Check cache
    const cached = await query<{ value: { version: string; checked_at: string } }>(
      `SELECT value FROM app_settings WHERE key = 'version_check_cache'`
    );
    const row = cached[0]?.value;
    if (row && Date.now() - new Date(row.checked_at).getTime() < CACHE_TTL_MS) {
      const latestParsed = parseVersion(row.version);
      const currentParsed = parseVersion(CURRENT_VERSION);
      return res.json({
        current: CURRENT_VERSION,
        latest: row.version,
        update_available: isNewer(latestParsed, currentParsed),
      });
    }

    // Fetch latest version from GitHub
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let latestVersion = CURRENT_VERSION;
    try {
      const resp = await fetch(RAW_URL, { signal: controller.signal });
      if (resp.ok) {
        const pkg = await resp.json() as { version?: string };
        if (pkg.version) latestVersion = pkg.version;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Cache result
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('version_check_cache', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({ version: latestVersion, checked_at: new Date().toISOString() })]
    );

    return res.json({
      current: CURRENT_VERSION,
      latest: latestVersion,
      update_available: isNewer(parseVersion(latestVersion), parseVersion(CURRENT_VERSION)),
    });
  } catch {
    // Fail silently — air-gapped or unreachable GitHub
    return res.json({ current: CURRENT_VERSION, latest: null, update_available: false });
  }
});

export default router;
