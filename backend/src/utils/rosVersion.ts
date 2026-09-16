/**
 * Comparing RouterOS versions, and deciding whether an update is really an update.
 *
 * Availability was decided in three separate places with the same test:
 *
 *     const available = !!latest && latest !== installed;
 *
 * That reads "different" as "newer". A device running 7.24.3 whose channel
 * reports 7.24.2 as its latest therefore shows "New version is available" and
 * offers to install an *older* release — which is what a user saw and reasonably
 * asked "how?" about (#144).
 *
 * It is not a contrived case. Any device whose update channel changes, or which
 * is running something newer than its channel carries, lands in it: long-term
 * trails stable by design, so a stable-upgraded device pointed at long-term will
 * always look like it has an update waiting.
 *
 * RouterOS versions look like `7.24.3`, `6.49.10`, `7.25beta3`, `7.16rc1`, and
 * sometimes carry a channel in parentheses. A pre-release sorts *before* the
 * release it leads to: 7.25beta3 is older than 7.25.
 */

const PRERELEASE_RANK: Record<string, number> = { alpha: 1, beta: 2, rc: 3 };

interface Parsed {
  parts: number[];
  /** 0 for a final release; lower ranks sort earlier. */
  preRank: number;
  preNum: number;
}

/** `7.25beta3 (stable)` -> { parts: [7,25], preRank: 2, preNum: 3 } */
export function parseRosVersion(raw: string | null | undefined): Parsed | null {
  const text = (raw || '').trim().replace(/\s*\(.*\)\s*$/, '');
  if (!text) return null;

  const m = /^(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|rc)\.?(\d+)?)?/i.exec(text);
  if (!m) return null;

  const parts = m[1].split('.').map((n) => parseInt(n, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;

  const pre = m[2] === undefined ? undefined : m[2].toLowerCase();
  return {
    parts,
    // Final releases outrank every pre-release of the same number, so they sort
    // last rather than first.
    preRank: pre ? PRERELEASE_RANK[pre] ?? 1 : Number.MAX_SAFE_INTEGER,
    preNum: m[3] ? parseInt(m[3], 10) : 0,
  };
}

/** -1 if a < b, 0 if equal, 1 if a > b. Unparseable versions compare as equal. */
export function compareRosVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseRosVersion(a);
  const pb = parseRosVersion(b);
  if (!pa || !pb) return 0;

  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    // 7.24 and 7.24.0 are the same release.
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  if (pa.preRank !== pb.preRank) return pa.preRank < pb.preRank ? -1 : 1;
  if (pa.preNum !== pb.preNum) return pa.preNum < pb.preNum ? -1 : 1;
  return 0;
}

/** True only when `candidate` is genuinely later than `current`. */
export function isNewerRosVersion(
  candidate: string | null | undefined,
  current: string | null | undefined
): boolean {
  return compareRosVersions(candidate, current) > 0;
}

/**
 * Whether a device has an update worth offering.
 *
 * The version comparison decides it whenever both versions are readable. The
 * device's own status word is only a fallback for when they are not — trusting
 * it over the numbers is what produced "7.24.3 -> 7.24.2, New version is
 * available".
 */
export function updateAvailable(opts: {
  installed: string | null | undefined;
  latest: string | null | undefined;
  status?: string | null;
}): boolean {
  const { installed, latest, status } = opts;
  if (parseRosVersion(installed) && parseRosVersion(latest)) {
    return isNewerRosVersion(latest, installed);
  }
  // Nothing comparable: fall back to what the device said, if anything.
  return /\bavailable\b/i.test((status || '').toLowerCase());
}
