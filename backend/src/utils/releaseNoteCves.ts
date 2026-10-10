import { parseRosVersion, compareRosVersions } from './rosVersion';

/**
 * CVEs named in MikroTik's own release notes (discussion #85).
 *
 * NVD takes days or weeks to analyse a new CVE, and until it does there are no
 * affected versions to match, so a device one release behind a security fix
 * looked clean. MikroTik's notes say it plainly ("system - improve stability
 * (includes CVE-2026-84411)"), so a CVE a release fixes counts against every
 * earlier version of the same major release.
 */

export interface NoteCve {
  id: string;
  /** The release-note line that names it, without the "*) " bullet. */
  line: string;
}

export interface ReleaseNote {
  version: string;
  cves: NoteCve[];
}

const CVE_ID = /CVE-\d{4}-\d{4,7}/gi;

/** The CVE ids a release's notes name, each with the first line that does. */
export function parseReleaseNoteCves(text: string): NoteCve[] {
  const seen = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const ids = raw.match(CVE_ID);
    if (!ids) continue;
    const line = raw.replace(/^\s*\*\)\s*/, '').replace(/[;\s]+$/, '').trim().slice(0, 300);
    for (const id of ids) {
      const key = id.toUpperCase();
      if (!seen.has(key)) seen.set(key, line);
    }
  }
  return [...seen.entries()].map(([id, line]) => ({ id, line }));
}

/** "7.25", not "7.25.0": how MikroTik names a .0 release. */
export function releaseName(major: number, minor: number, patch: number): string {
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

/**
 * Releases to read between `current` and `latest`, as runs of patch numbers.
 * `toPatch` null means "until one doesn't exist": patch releases are numbered
 * in order, so the first missing one ends that line. Final releases only.
 */
export interface ProbeRun { major: number; minor: number; fromPatch: number; toPatch: number | null }

const MAX_MINORS = 15;

export function releasePlan(current: string, latest: string): ProbeRun[] {
  const c = parseRosVersion(current);
  const l = parseRosVersion(latest);
  if (!c || !l || compareRosVersions(latest, current) <= 0) return [];
  const [cMaj, cMin = 0, cPatch = 0] = c.parts;
  const [lMaj, lMin = 0, lPatch = 0] = l.parts;
  if (cMaj !== lMaj) return [];
  // A pre-release (7.25rc2) leads to its final release, so its own line starts at .0.
  const fromCurrent = c.preRank === Number.MAX_SAFE_INTEGER ? cPatch + 1 : cPatch;
  if (cMin === lMin) return [{ major: cMaj, minor: cMin, fromPatch: fromCurrent, toPatch: lPatch }];
  const runs: ProbeRun[] = [{ major: cMaj, minor: cMin, fromPatch: fromCurrent, toPatch: null }];
  for (let m = Math.max(cMin + 1, lMin - MAX_MINORS); m < lMin; m++) {
    runs.push({ major: cMaj, minor: m, fromPatch: 0, toPatch: null });
  }
  runs.push({ major: cMaj, minor: lMin, fromPatch: 0, toPatch: lPatch });
  return runs;
}

/**
 * The CVEs a later release of the same major version fixes, for `version`.
 * Fixed in the earliest release that names it, so a fix in 7.24.6 and 7.25
 * counts as fixed from 7.24.6 on.
 */
export function releaseNoteFixes(version: string, notes: ReleaseNote[]): Map<string, { fixedIn: string; line: string }> {
  const out = new Map<string, { fixedIn: string; line: string }>();
  const major = parseRosVersion(version)?.parts[0];
  if (major === undefined) return out;
  const earliest = new Map<string, { fixedIn: string; line: string }>();
  for (const n of notes) {
    if (parseRosVersion(n.version)?.parts[0] !== major) continue;
    for (const c of n.cves) {
      const prev = earliest.get(c.id);
      if (!prev || compareRosVersions(n.version, prev.fixedIn) < 0) earliest.set(c.id, { fixedIn: n.version, line: c.line });
    }
  }
  for (const [id, fix] of earliest) {
    if (compareRosVersions(version, fix.fixedIn) < 0) out.set(id, fix);
  }
  return out;
}
