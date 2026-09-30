import { query, pool } from '../config/database';
import { internetAllowed } from '../utils/darkSite';
import { siteScopeDevices, type SiteScope } from '../utils/siteScope';
import {
  parseNvdResponse, parseKevResponse, affects, fixedIn, severityRank, correctedAway, matchUncertainty,
  type ParsedCve, type VersionRange,
} from '../utils/cveMatch';

/**
 * Known RouterOS vulnerabilities for the versions in the fleet (#175).
 *
 * The list comes from NIST's NVD (every CVE filed against RouterOS, with the
 * versions affected) and CISA's Known Exploited Vulnerabilities catalogue
 * (which of them attackers are using). It is fetched at most daily, by the
 * manager, and can be turned off in Dark Site Mode.
 */

const NVD_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=cpe:2.3:o:mikrotik:routeros&resultsPerPage=2000';
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const FETCHED_KEY = 'cve_feed_fetched_at';
const ERROR_KEY = 'cve_feed_last_error';

async function getJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { 'User-Agent': 'mikrotik-manager (+https://github.com/2GT-Media-Group-LLC/mikrotik-manager)' };
  // An NVD API key raises the rate limit; optional, one request a day doesn't need it.
  // Compared on the parsed host, not a string prefix, so the key can only ever
  // go to NVD itself.
  if (new URL(url).hostname === 'services.nvd.nist.gov' && process.env.NVD_API_KEY) headers['apiKey'] = process.env.NVD_API_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${res.status}`);
  return res.json();
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function feedEnabled(): Promise<boolean> {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings WHERE key = 'cve_feed_enabled'`
  ).catch(() => []);
  return internetAllowed(Object.fromEntries(rows.map((r) => [r.key, r.value])), 'cve_feed_enabled');
}

/** Fetch both lists and replace the stored copy. Throws on failure, and records it. */
export async function refreshCveFeed(): Promise<{ count: number; exploited: number }> {
  if (!(await feedEnabled())) throw new Error('The vulnerability list is turned off in Dark Site Mode');
  try {
    const cves = parseNvdResponse(await getJson(NVD_URL));
    // A failed KEV fetch shouldn't cost the whole list; the flags just stay off.
    const kev = await getJson(KEV_URL).then(parseKevResponse).catch(() => new Set<string>());
    if (!cves.length) throw new Error('NVD returned no RouterOS entries');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM ros_cves');
      for (const c of cves) {
        await client.query(
          `INSERT INTO ros_cves (cve_id, published, last_modified, summary, score, severity, cvss_version,
                                 ranges, unranged, hardware_specific, known_exploited)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [c.id, c.published || null, c.lastModified || null, c.summary, c.score, c.severity, c.cvssVersion,
           JSON.stringify(c.ranges), c.unranged, c.hardwareSpecific, kev.has(c.id)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await setSetting(FETCHED_KEY, new Date().toISOString());
    await setSetting(ERROR_KEY, null);
    return { count: cves.length, exploited: cves.filter((c) => kev.has(c.id)).length };
  } catch (err) {
    await setSetting(ERROR_KEY, (err as Error).message).catch(() => {});
    throw err;
  }
}

interface StoredCve {
  cve_id: string; published: string | null; summary: string; score: string | null; severity: string | null;
  cvss_version: string | null; ranges: VersionRange[]; unranged: boolean; hardware_specific: boolean; known_exploited: boolean;
}

export interface FleetCveReport {
  enabled: boolean;
  fetched_at: string | null;
  last_error: string | null;
  total_cves: number;
  unranged: number;
  versions: {
    version: string;
    devices: { id: number; name: string }[];
    cves: {
      id: string; severity: string | null; score: number | null; known_exploited: boolean;
      published: string | null; summary: string; fixed_in: string | null; hardware_specific: boolean;
      /** Why this match may not really apply (see matchUncertainty); null when it's listed for this line. */
      uncertain: string | null;
    }[];
    /** Matches a known correction removed, with the reason. */
    corrected: { id: string; reason: string }[];
  }[];
}

/** Every RouterOS version in the site, with the stored CVEs that list it. */
export async function fleetCveReport(siteId: SiteScope | undefined): Promise<FleetCveReport> {
  const siteFilter = siteScopeDevices(siteId ?? null);
  const [devices, stored, settings, enabled] = await Promise.all([
    query<{ id: number; name: string; ros_version: string | null }>(
      `SELECT id, name, ros_version FROM devices WHERE ros_version IS NOT NULL AND ros_version <> ''
         ${siteFilter ? `AND ${siteFilter}` : ''} ORDER BY name`
    ),
    query<StoredCve>(`SELECT * FROM ros_cves`),
    query<{ key: string; value: unknown }>(
      `SELECT key, value FROM app_settings WHERE key IN ($1, $2)`, [FETCHED_KEY, ERROR_KEY]
    ),
    feedEnabled(),
  ]);
  const setting = (k: string) => settings.find((r) => r.key === k)?.value;

  const byVersion = new Map<string, { id: number; name: string }[]>();
  for (const d of devices) {
    const v = (d.ros_version ?? '').trim().replace(/\s*\(.*\)$/, '');
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v)!.push({ id: d.id, name: d.name });
  }

  const cves: (ParsedCve & { known_exploited: boolean })[] = stored.map((r) => ({
    id: r.cve_id, published: r.published ?? '', lastModified: '', summary: r.summary,
    score: r.score === null ? null : Number(r.score), severity: r.severity, cvssVersion: r.cvss_version,
    ranges: r.ranges ?? [], unranged: r.unranged, hardwareSpecific: r.hardware_specific,
    known_exploited: r.known_exploited,
  }));

  const versions = [...byVersion.entries()].map(([version, devs]) => {
    const matched = cves.filter((c) => affects(c, version));
    return {
      version,
      devices: devs,
      cves: matched
        .filter((c) => !correctedAway(c.id, version))
        .map((c) => ({
          id: c.id, severity: c.severity, score: c.score, known_exploited: c.known_exploited,
          published: c.published || null, summary: c.summary, fixed_in: fixedIn(c, version),
          hardware_specific: c.hardwareSpecific,
          // An exploited CVE is never played down, however vague its range.
          uncertain: c.known_exploited ? null : matchUncertainty(c, version),
        }))
        .sort((a, b) =>
          Number(!!a.uncertain) - Number(!!b.uncertain)
          || Number(b.known_exploited) - Number(a.known_exploited)
          || severityRank(b.severity) - severityRank(a.severity)
          || (b.score ?? 0) - (a.score ?? 0)),
      corrected: matched
        .map((c) => ({ id: c.id, reason: correctedAway(c.id, version) }))
        .filter((c): c is { id: string; reason: string } => !!c.reason),
    };
  });
  // Worst first: exploited, then the highest severity, then the most CVEs.
  // Uncertain matches don't count toward it.
  const worst = (v: (typeof versions)[number]) => {
    const sure = v.cves.filter((c) => !c.uncertain);
    return (sure.some((c) => c.known_exploited) ? 100 : 0) + Math.max(0, ...sure.map((c) => severityRank(c.severity))) * 10 + Math.min(sure.length, 9);
  };
  versions.sort((a, b) => worst(b) - worst(a) || a.version.localeCompare(b.version));

  const fetched = setting(FETCHED_KEY);
  const lastError = setting(ERROR_KEY);
  return {
    enabled,
    fetched_at: typeof fetched === 'string' ? fetched : null,
    last_error: typeof lastError === 'string' ? lastError : null,
    total_cves: cves.length,
    unranged: cves.filter((c) => c.unranged).length,
    versions,
  };
}
