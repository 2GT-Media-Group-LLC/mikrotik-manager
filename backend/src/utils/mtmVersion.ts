/**
 * MikroTik Manager's own version numbers, in every form they appear:
 * "0.77.1-beta" and "1.0.0-rc.1" (package.json), "v0.77.1 Beta" and
 * "v1.0.0 RC 1" (the app's label), "1.0.0" (stable).
 *
 * Comparing only the three numbers was enough while every release was a beta
 * with a new number, but from 1.0 a release candidate shares its numbers with
 * the release it leads to: 1.0.0-rc.1 -> rc.2 -> 1.0.0 all read as 1.0.0, so
 * nobody on an RC was told about the next one or the release.
 *
 * Order: numbers first; with equal numbers alpha < beta < rc < the release,
 * and within a pre-release kind by its own number (a missing one counts as 0).
 */
const PRE_RANK: Record<string, number> = { alpha: 1, beta: 2, rc: 3 };
const RELEASE_RANK = 4;

export interface MtmVersion {
  nums: [number, number, number];
  /** alpha/beta/rc rank, or RELEASE_RANK for a release. */
  rank: number;
  preNum: number;
}

export function parseMtmVersion(text: string): MtmVersion | null {
  const t = (text || '').toLowerCase();
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(t);
  if (!m) return null;
  const rest = t.slice(m.index + m[0].length);
  const pre = /^[\s.\-_]*(alpha|beta|rc)(?:[\s.\-_]*(\d+))?/.exec(rest);
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    rank: pre ? PRE_RANK[pre[1]] : RELEASE_RANK,
    preNum: pre?.[2] ? Number(pre[2]) : 0,
  };
}

/** -1, 0 or 1. Something unparseable sorts lowest, so it never looks newer. */
export function compareMtmVersions(a: string, b: string): number {
  const x = parseMtmVersion(a);
  const y = parseMtmVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (x.rank !== y.rank) return x.rank < y.rank ? -1 : 1;
  if (x.preNum !== y.preNum) return x.preNum < y.preNum ? -1 : 1;
  return 0;
}

/**
 * Which branch an install should compare its version against. From 1.0, main
 * is the stable line and new features come as betas from the dev branch: a
 * stable or RC install hears about stable releases, a 1.x beta about the next
 * beta. The 0.x betas all came from main.
 */
export function releaseBranch(version: string): 'main' | 'dev' {
  const v = parseMtmVersion(version);
  return v && v.nums[0] >= 1 && v.rank <= PRE_RANK.beta ? 'dev' : 'main';
}
