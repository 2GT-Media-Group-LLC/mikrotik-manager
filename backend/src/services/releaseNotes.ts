/**
 * MikroTik's release notes as a source of RouterOS CVEs (discussion #85).
 *
 * Run with the daily vulnerability refresh. Reads the notes of each release
 * between a version the fleet runs and the newest one known for that major
 * version, and stores the CVEs they name. For a CVE NVD doesn't list against
 * RouterOS yet, NVD's entry is looked up by id for a description and score.
 */
import { query } from '../config/database';
import { logSafe } from '../utils/logSafe';
import { compareRosVersions, parseRosVersion } from '../utils/rosVersion';
import { parseReleaseNoteCves, releasePlan, releaseName, type NoteCve, type ReleaseNote } from '../utils/releaseNoteCves';
import { parseNvdCveDetail } from '../utils/cveMatch';

const NOTES_URL = (version: string) => `https://download.mikrotik.com/routeros/${version}/CHANGELOG`;
const NVD_CVE_URL = (id: string) => `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(id)}`;
/** Per refresh: release notes are tiny, but a long gap shouldn't mean hundreds of requests. */
const MAX_NOTE_FETCHES = 100;
/** Per refresh: NVD allows 5 requests in 30 seconds without an API key. */
const MAX_DETAIL_LOOKUPS = 4;
const USER_AGENT = 'mikrotik-manager (+https://github.com/2GT-Media-Group-LLC/mikrotik-manager)';

/** The stable form of a version as devices report it: "6.49.22 (long-term)" -> "6.49.22". */
const plain = (v: string | null | undefined) => (v ?? '').trim().replace(/\s*\(.*\)\s*$/, '');

/** Is reading release notes allowed? Dark Site Mode turns it off with the changelog switch. */
async function notesAllowed(): Promise<boolean> {
  const row = await query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = 'firmware_changelog_enabled'`
  ).catch(() => []);
  return row[0]?.value !== false;
}

/** Read the release notes the fleet's versions need. Returns how many were fetched. */
export async function refreshReleaseNotes(): Promise<{ fetched: number; withCves: number }> {
  if (!(await notesAllowed())) return { fetched: 0, withCves: 0 };

  const devices = await query<{ ros_version: string | null; latest_ros_version: string | null }>(
    `SELECT ros_version, latest_ros_version FROM devices WHERE ros_version IS NOT NULL AND ros_version <> ''`
  );
  // The newest release known per major version, from the update checks.
  const latest = new Map<number, string>();
  for (const v of devices.flatMap((d) => [plain(d.ros_version), plain(d.latest_ros_version)])) {
    const p = parseRosVersion(v);
    if (!p || p.preRank !== Number.MAX_SAFE_INTEGER) continue;
    const cur = latest.get(p.parts[0]);
    if (!cur || compareRosVersions(v, cur) > 0) latest.set(p.parts[0], v);
  }

  const known = new Map((await query<{ version: string; found: boolean; stale: boolean }>(
    `SELECT version, found, fetched_at < NOW() - INTERVAL '20 hours' AS stale FROM ros_release_notes`
  )).map((r) => [r.version, r]));
  const seen = new Map<string, 'found' | 'missing'>();
  let fetched = 0;

  /** 'found' / 'missing', or null when MikroTik couldn't be reached (stop this run). */
  const read = async (version: string): Promise<'found' | 'missing' | null> => {
    const cached = seen.get(version);
    if (cached) return cached;
    const row = known.get(version);
    if (row?.found) { seen.set(version, 'found'); return 'found'; }
    if (row && !row.stale) { seen.set(version, 'missing'); return 'missing'; }
    if (fetched >= MAX_NOTE_FETCHES) return null;
    fetched++;
    try {
      const res = await fetch(NOTES_URL(version), { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) {
        await upsertNote(version, false, []);
        seen.set(version, 'missing');
        return 'missing';
      }
      if (!res.ok) return null;
      await upsertNote(version, true, parseReleaseNoteCves(await res.text()));
      seen.set(version, 'found');
      return 'found';
    } catch {
      return null;
    }
  };

  const fleetVersions = [...new Set(devices.map((d) => plain(d.ros_version)))];
  for (const v of fleetVersions) {
    const major = parseRosVersion(v)?.parts[0];
    const newest = major !== undefined ? latest.get(major) : undefined;
    if (!newest) continue;
    for (const run of releasePlan(v, newest)) {
      const last = run.toPatch ?? run.fromPatch + 60;
      for (let patch = run.fromPatch; patch <= last; patch++) {
        const r = await read(releaseName(run.major, run.minor, patch));
        if (r === null) return { fetched, withCves: await countWithCves() };
        // Patch releases are numbered in order: the first missing one ends an open run.
        if (r === 'missing' && run.toPatch === null) break;
      }
    }
  }
  return { fetched, withCves: await countWithCves() };
}

async function upsertNote(version: string, found: boolean, cves: NoteCve[]): Promise<void> {
  await query(
    `INSERT INTO ros_release_notes (version, found, cves, fetched_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (version) DO UPDATE SET found = EXCLUDED.found, cves = EXCLUDED.cves, fetched_at = NOW()`,
    [version, found, JSON.stringify(cves)]
  );
}

async function countWithCves(): Promise<number> {
  const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ros_release_notes WHERE found AND cves <> '[]'::jsonb`);
  return r[0]?.n ?? 0;
}

/** Release notes that name at least one CVE. */
export async function storedReleaseNotes(): Promise<ReleaseNote[]> {
  const rows = await query<{ version: string; cves: NoteCve[] }>(
    `SELECT version, cves FROM ros_release_notes WHERE found AND cves <> '[]'::jsonb`
  );
  return rows.map((r) => ({ version: r.version, cves: Array.isArray(r.cves) ? r.cves : [] }));
}

/**
 * For CVEs the notes name that NVD's RouterOS list doesn't have (it lists a CVE
 * only once it has affected versions), fetch NVD's entry by id. Retried daily
 * until it has a score; a few per refresh, within NVD's rate limit.
 */
export async function refreshCveDetails(): Promise<number> {
  const due = await query<{ id: string }>(
    `SELECT DISTINCT c->>'id' AS id
       FROM ros_release_notes n, jsonb_array_elements(n.cves) c
      WHERE n.found
        AND NOT EXISTS (SELECT 1 FROM ros_cves r WHERE r.cve_id = c->>'id')
        AND NOT EXISTS (SELECT 1 FROM ros_cve_details d WHERE d.cve_id = c->>'id'
                         AND (d.score IS NOT NULL OR d.fetched_at > NOW() - INTERVAL '20 hours'))
      LIMIT $1`,
    [MAX_DETAIL_LOOKUPS]
  );
  let done = 0;
  for (const [i, { id }] of due.entries()) {
    // Without an API key NVD allows 5 requests in 30 seconds.
    if (i > 0 && !process.env.NVD_API_KEY) await new Promise((r) => setTimeout(r, 6_500));
    try {
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
      if (process.env.NVD_API_KEY) headers['apiKey'] = process.env.NVD_API_KEY;
      const res = await fetch(NVD_CVE_URL(id), { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const d = parseNvdCveDetail(await res.json());
      await query(
        `INSERT INTO ros_cve_details (cve_id, found, summary, score, severity, published, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (cve_id) DO UPDATE SET found = EXCLUDED.found, summary = EXCLUDED.summary, score = EXCLUDED.score,
           severity = EXCLUDED.severity, published = EXCLUDED.published, fetched_at = NOW()`,
        [id, !!d, d?.summary || null, d?.score ?? null, d?.severity ?? null, d?.published ?? null]
      );
      done++;
    } catch (e) {
      console.warn(`[releaseNotes] NVD lookup of ${logSafe(id)} failed: ${logSafe((e as Error).message)}`);
    }
  }
  return done;
}

export interface CveDetail { summary: string | null; score: number | null; severity: string | null; published: string | null }

export async function storedCveDetails(): Promise<Map<string, CveDetail>> {
  const rows = await query<{ cve_id: string; summary: string | null; score: string | null; severity: string | null; published: string | null }>(
    `SELECT cve_id, summary, score, severity, published FROM ros_cve_details WHERE found`
  );
  return new Map(rows.map((r) => [r.cve_id, {
    summary: r.summary, score: r.score === null ? null : Number(r.score), severity: r.severity, published: r.published,
  }]));
}
