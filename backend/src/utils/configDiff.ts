/**
 * A unified diff of two configuration snapshots (#406), for the Configuration
 * Changed alert: what changed, the way Oxidized shows it, rather than only a
 * line count. Line-based; the common start and end are trimmed first, so the
 * (quadratic) comparison only runs on what actually changed, which in a
 * config change is a handful of lines.
 */

/** Past this many changed lines on a side the comparison isn't attempted. */
const MAX_MIDDLE = 2000;

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number };

/** The edit script for two line arrays: an LCS walk. */
function editScript(a: string[], b: string[]): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length > MAX_MIDDLE || mb.length > MAX_MIDDLE) return null;

  // LCS lengths, from the end.
  const n = ma.length;
  const m = mb.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: ' ', text: a[i], a: i, b: i });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ma[i] === mb[j]) { ops.push({ kind: ' ', text: ma[i], a: start + i, b: start + j }); i++; j++; }
    // Removals before additions, as diffs are read.
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push({ kind: '-', text: ma[i], a: start + i, b: start + j }); i++; }
    else { ops.push({ kind: '+', text: mb[j], a: start + i, b: start + j }); j++; }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ kind: ' ', text: a[endA + k], a: endA + k, b: endB + k });
  return ops;
}

export interface DiffOptions { context?: number; maxLines?: number; fromLabel?: string; toLabel?: string }

/**
 * The diff as text, hunks with `context` lines around each change, cut to
 * `maxLines` with a note of how much more there is. Null when the change is
 * too large to compare, or there's no change.
 */
export function unifiedDiff(oldText: string, newText: string, opts: DiffOptions = {}): string | null {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 80;
  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  const ops = editScript(a, b);
  if (!ops || !ops.some((o) => o.kind !== ' ')) return null;

  // Group changes into hunks: changed lines plus `context` either side, merged when they touch.
  const changed = ops.map((o, idx) => (o.kind !== ' ' ? idx : -1)).filter((x) => x >= 0);
  const hunks: [number, number][] = [];
  for (const idx of changed) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(ops.length - 1, idx + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi); else hunks.push([lo, hi]);
  }
  const out: string[] = [`--- ${opts.fromLabel ?? 'previous'}`, `+++ ${opts.toLabel ?? 'current'}`];
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const aStart = slice.find((o) => o.kind !== '+')?.a ?? slice[0].a;
    const bStart = slice.find((o) => o.kind !== '-')?.b ?? slice[0].b;
    const aLen = slice.filter((o) => o.kind !== '+').length;
    const bLen = slice.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    for (const o of slice) out.push(`${o.kind}${o.text}`);
  }
  if (out.length > maxLines + 2) {
    const more = out.length - (maxLines + 2);
    return [...out.slice(0, maxLines + 2), `… ${more} more line${more === 1 ? '' : 's'}: see Config History`].join('\n');
  }
  return out.join('\n');
}

/**
 * Cut text to about `max` characters at a line break, for channels with a
 * message limit (ntfy and Discord, around 4 KB and 2 KB).
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  const kept = text.slice(0, cut > 0 ? cut : max);
  return `${kept}\n… more: see Config History`;
}
