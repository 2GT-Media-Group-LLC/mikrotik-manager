import { compareRosVersions } from './rosVersion';

/**
 * Matching RouterOS versions against published vulnerabilities (#175).
 *
 * The source is NIST's National Vulnerability Database (NVD). Each CVE lists
 * the RouterOS versions it affects as CPE matches: either one exact version
 * (`cpe:2.3:o:mikrotik:routeros:6.42:rc11:…`) or a range
 * (`versionStartIncluding` 7.0, `versionEndExcluding` 7.23.4). One CVE often
 * carries several ranges, one per release line, and each is checked on its own.
 *
 * A match says the version is listed as affected. It does not say the device is
 * exploitable: many need a particular service (SSH, btest, winbox) reachable.
 */

export interface VersionRange {
  exact?: string;
  startIncluding?: string;
  startExcluding?: string;
  endIncluding?: string;
  endExcluding?: string;
}

export interface ParsedCve {
  id: string;
  published: string;
  lastModified: string;
  summary: string;
  score: number | null;
  severity: string | null;
  cvssVersion: string | null;
  ranges: VersionRange[];
  /** Listed for RouterOS with no version or range at all; can't be matched to a version. */
  unranged: boolean;
  /** Listed only in combination with specific hardware (an AND configuration). */
  hardwareSpecific: boolean;
}

const METRIC_ORDER: [string, string][] = [
  ['cvssMetricV40', '4.0'], ['cvssMetricV31', '3.1'], ['cvssMetricV30', '3.0'], ['cvssMetricV2', '2.0'],
];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The RouterOS range a CPE match describes, or null when it lists every version. */
export function rangeFromCpeMatch(m: Json): VersionRange | null | undefined {
  const criteria = str(m['criteria']) ?? '';
  const parts = criteria.split(':');
  // cpe:2.3:o:mikrotik:routeros:<version>:<update>:...
  if (parts[3] !== 'mikrotik' || parts[4] !== 'routeros' || m['vulnerable'] === false) return undefined;
  const version = parts[5] ?? '*';
  const update = parts[6] ?? '*';
  const range: VersionRange = {};
  for (const k of ['startIncluding', 'startExcluding', 'endIncluding', 'endExcluding'] as const) {
    const v = str(m[`version${k[0].toUpperCase()}${k.slice(1)}`]);
    if (v) range[k] = v;
  }
  if (version !== '*' && version !== '-') {
    // "6.42" with update "rc11" is the pre-release 6.42rc11.
    range.exact = update !== '*' && update !== '-' ? `${version}${update}` : version;
  }
  // NVD data is not always clean: CVE-2021-3014 gives its upper bound as the
  // date "2021-01-04", which would read as RouterOS 2021 and match every
  // version ever released. A bound that isn't a RouterOS version makes the
  // range unusable, so the CVE counts as unranged instead of as a false alarm.
  if (Object.values(range).some((v) => !isRosVersion(v))) return null;
  return Object.keys(range).length ? range : null;
}

/** "7.24.4", "6.42rc11", "7.25beta3": a RouterOS version, not a date or a word. */
function isRosVersion(v: string): boolean {
  return /^\d{1,2}(\.\d+){0,3}((alpha|beta|rc)\d*)?$/i.test(v.trim());
}

export function versionInRange(version: string, r: VersionRange): boolean {
  const cmp = (other: string) => compareRosVersions(version, other);
  if (r.exact) return cmp(r.exact) === 0;
  if (r.startIncluding && cmp(r.startIncluding) < 0) return false;
  if (r.startExcluding && cmp(r.startExcluding) <= 0) return false;
  if (r.endIncluding && cmp(r.endIncluding) > 0) return false;
  if (r.endExcluding && cmp(r.endExcluding) >= 0) return false;
  return true;
}

export function affects(cve: Pick<ParsedCve, 'ranges'>, version: string): boolean {
  return cve.ranges.some((r) => versionInRange(version, r));
}

/**
 * Corrections to NVD, for entries whose ranges are known to be wrong. NVD often
 * lists a CVE as "before 7.x" with no starting version, which takes in every
 * RouterOS 6 release even when the flaw is in something v6 never had. Each
 * entry says which major versions it does not apply to, and why.
 */
export const CVE_CORRECTIONS = new Map<string, { notMajors: number[]; reason: string }>([
  ['CVE-2025-6443', { notMajors: [6], reason: 'the flaw is in VXLAN, which RouterOS 6 does not have' }],
]);

function majorOf(version: string): number | null {
  const m = /^(\d+)/.exec(version.trim());
  return m ? parseInt(m[1], 10) : null;
}

/** Whether a correction says this CVE doesn't apply to this version. */
export function correctedAway(cveId: string, version: string): string | null {
  const c = CVE_CORRECTIONS.get(cveId);
  const major = majorOf(version);
  return c && major !== null && c.notMajors.includes(major) ? c.reason : null;
}

/**
 * How sure a match is. "Listed" when the range was written for this release
 * line. "Uncertain" when the only matching range is open-ended ("before 7.5",
 * no start) and ends in a later major version than the device runs: NVD then
 * takes in all of v6 by default, and often the flaw was only ever in v7.
 */
export function matchUncertainty(cve: Pick<ParsedCve, 'ranges'>, version: string): string | null {
  const hits = cve.ranges.filter((r) => versionInRange(version, r));
  if (!hits.length) return null;
  const major = majorOf(version);
  const openEnded = (r: VersionRange) => !r.exact && !r.startIncluding && !r.startExcluding;
  const endMajor = (r: VersionRange) => majorOf(r.endExcluding ?? r.endIncluding ?? '');
  const allVague = hits.every((r) => {
    const em = endMajor(r);
    return openEnded(r) && major !== null && em !== null && em > major;
  });
  if (!allVague) return null;
  const end = hits[0].endExcluding ?? hits[0].endIncluding;
  return `listed only as "before ${end}", which NVD applies to every earlier release; it may only affect v${endMajor(hits[0])}`;
}

/** The first release no longer affected, when the matching range says ("7.24.2"). */
export function fixedIn(cve: Pick<ParsedCve, 'ranges'>, version: string): string | null {
  const hit = cve.ranges.find((r) => versionInRange(version, r));
  return hit?.endExcluding ?? null;
}

/** The NVD 2.0 API response, reduced to what matching needs. */
export function parseNvdResponse(body: unknown): ParsedCve[] {
  const out: ParsedCve[] = [];
  for (const item of arr(obj(body)['vulnerabilities'])) {
    const c = obj(obj(item)['cve']);
    const id = str(c['id']);
    if (!id) continue;

    const ranges: VersionRange[] = [];
    let unranged = false;
    let hardwareSpecific = false;
    for (const conf of arr(c['configurations'])) {
      if (str(obj(conf)['operator']) === 'AND') hardwareSpecific = true;
      for (const node of arr(obj(conf)['nodes'])) {
        for (const m of arr(obj(node)['cpeMatch'])) {
          const r = rangeFromCpeMatch(obj(m));
          if (r === null) unranged = true;
          else if (r) ranges.push(r);
        }
      }
    }
    if (!ranges.length && !unranged) continue;

    let score: number | null = null;
    let severity: string | null = null;
    let cvssVersion: string | null = null;
    const metrics = obj(c['metrics']);
    for (const [key, ver] of METRIC_ORDER) {
      const first = obj(arr(metrics[key])[0]);
      const data = obj(first['cvssData']);
      if (typeof data['baseScore'] === 'number') {
        score = data['baseScore'] as number;
        severity = str(data['baseSeverity']) ?? str(first['baseSeverity']) ?? null;
        cvssVersion = ver;
        break;
      }
    }

    const summary = str(obj(arr(c['descriptions']).find((d) => obj(d)['lang'] === 'en'))['value']) ?? '';
    out.push({
      id,
      published: str(c['published']) ?? '',
      lastModified: str(c['lastModified']) ?? '',
      summary: summary.trim(),
      score, severity: severity?.toUpperCase() ?? null, cvssVersion,
      ranges, unranged: unranged && !ranges.length, hardwareSpecific,
    });
  }
  return out;
}

/** CVE ids in CISA's Known Exploited Vulnerabilities catalogue for MikroTik. */
export function parseKevResponse(body: unknown): Set<string> {
  const ids = new Set<string>();
  for (const v of arr(obj(body)['vulnerabilities'])) {
    const o = obj(v);
    if ((str(o['vendorProject']) ?? '').toLowerCase().includes('mikrotik')) {
      const id = str(o['cveID']);
      if (id) ids.add(id);
    }
  }
  return ids;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
export function severityRank(s: string | null | undefined): number {
  return (s && SEVERITY_RANK[s.toUpperCase()]) || 0;
}
