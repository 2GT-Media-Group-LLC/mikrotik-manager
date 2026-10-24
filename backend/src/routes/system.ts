import { compareMtmVersions, releaseBranch } from '../utils/mtmVersion';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { requireAuth, requireWrite, fleetOnly } from '../middleware/auth';
import { query } from '../config/database';
import { DARK_SITE_FEATURES, DARK_SITE_KEYS, internetAllowed } from '../utils/darkSite';
import type { PollerService } from '../services/PollerService';
import { globalSettings } from '../services/pollSettings';
import { cleanOverrides, effectiveValues } from '../utils/pollOverrides';

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
const RAW_URL = `https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/${releaseBranch(CURRENT_VERSION)}/frontend/package.json`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// "0.77.1-beta", "1.0.0-rc.1", "v1.0.0 RC 1", "1.0.0": a release candidate
// sorts before its release, which three numbers alone couldn't tell apart.
function isNewer(latest: string, current: string): boolean {
  return compareMtmVersions(latest, current) > 0;
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
router.get('/poller', fleetOnly, async (_req: Request, res: Response) => {
  try {
    if (!pollerService) return res.status(503).json({ error: 'Poller not started' });
    const health = await pollerService.getPollerHealth();

    // Devices the poller has not managed to reach lately, worst first. This is
    // the list that answers "which ones is it actually missing?".
    // Stale-device listing is a nicety; never let it take the whole payload down.
    let stale: unknown[] = [];
    try {
      // Stale means three missed fast polls at the device's own interval (at
      // least 3 minutes): a device polled every 10 minutes isn't stale at 4 (#261).
      const global = await globalSettings();
      const rows = await query<Record<string, unknown> & { seconds_since_success: number | null; dev_ov: unknown; site_ov: unknown }>(
      `SELECT d.id, d.name, d.status, s.kind,
              s.last_attempt_at, s.last_success_at, s.last_duration_ms, s.last_error,
              s.attempts, s.failures,
              EXTRACT(EPOCH FROM (NOW() - s.last_success_at))::int AS seconds_since_success,
              d.poll_overrides AS dev_ov, si.poll_overrides AS site_ov
         FROM devices d
         JOIN device_poll_stats s ON s.device_id = d.id AND s.kind = 'fast'
         LEFT JOIN sites si ON si.id = d.site_id
        WHERE d.status != 'disabled'
          AND (s.last_success_at IS NULL OR s.last_success_at < NOW() - INTERVAL '3 minutes')
        ORDER BY s.last_success_at ASC NULLS FIRST
        LIMIT 500`
      );
      stale = rows
        .filter((r) => r.seconds_since_success == null
          || r.seconds_since_success > Math.max(180, 3 * effectiveValues(global, cleanOverrides(r.site_ov), cleanOverrides(r.dev_ov)).fastSec))
        .slice(0, 50)
        .map(({ dev_ov: _d, site_ov: _s, ...rest }) => rest);
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
router.post('/poller/drain', requireWrite, fleetOnly, async (_req: Request, res: Response) => {
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

/**
 * GET /api/system/dark-site — the internet-dependent features and their state.
 *
 * Served from the backend so the settings screen and the gates read one list;
 * a second copy in the frontend would be the next thing to fall out of date.
 */
router.get('/dark-site', async (_req: Request, res: Response) => {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [DARK_SITE_KEYS]
  ).catch(() => []);
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  res.json({
    features: DARK_SITE_FEATURES.map((f) => ({ ...f, enabled: internetAllowed(map, f.key) })),
  });
});

router.get('/version-check', async (_req: Request, res: Response) => {
  try {
    // Dark Site Mode. Answered without contacting GitHub, and flagged so the
    // dashboard can say "check disabled" rather than "you are up to date",
    // which would be a claim it has no basis for.
    const flag = await query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'update_check_enabled'`
    ).catch(() => []);
    if (flag[0]?.value === false) {
      return res.json({ current: CURRENT_VERSION, latest: null, update_available: false, disabled: true });
    }

    // Check cache
    const cached = await query<{ value: { version: string; checked_at: string } }>(
      `SELECT value FROM app_settings WHERE key = 'version_check_cache'`
    );
    const row = cached[0]?.value;
    if (row && Date.now() - new Date(row.checked_at).getTime() < CACHE_TTL_MS) {

      return res.json({
        current: CURRENT_VERSION,
        latest: row.version,
        update_available: isNewer(row.version, CURRENT_VERSION),
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
      update_available: isNewer(latestVersion, CURRENT_VERSION),
    });
  } catch {
    // Fail silently — air-gapped or unreachable GitHub
    return res.json({ current: CURRENT_VERSION, latest: null, update_available: false });
  }
});

export default router;
