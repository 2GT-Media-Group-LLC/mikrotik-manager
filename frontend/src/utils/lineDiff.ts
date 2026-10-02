// Minimal, dependency-free unified line diff.
//
// Bounded so it can't freeze the tab (outside review U11): the plain LCS table
// for two 20,000-line configurations is 400 million cells on the UI thread.
//  1. Lines both sides share at the start and end are taken as they are. Two
//     snapshots of one device usually differ in a few places, so what's left
//     is small.
//  2. If what's left fits the cell budget, it gets the exact LCS diff.
//  3. Otherwise a linear walk that resynchronises within a look-ahead window.
//     Its result can be slightly longer than the minimal diff, never wrong.

export type DiffRowType = 'add' | 'del' | 'ctx';
export interface DiffRow {
  type: DiffRowType;
  text: string;
}

/** Above this many table cells, the exact diff isn't attempted. */
const CELL_BUDGET = 4_000_000;
/** How far ahead the fallback looks for the next matching line. */
const WINDOW = 400;

export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const rows: DiffRow[] = a.slice(0, start).map((text) => ({ type: 'ctx' as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  rows.push(...((midA.length + 1) * (midB.length + 1) <= CELL_BUDGET ? exactDiff(midA, midB) : windowedDiff(midA, midB)));
  for (const text of a.slice(endA)) rows.push({ type: 'ctx', text });
  return rows;
}

/** Exact LCS diff, in one flat typed array. */
function exactDiff(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // dp[i*w + j] = length of LCS of a[i..] and b[j..]
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { rows.push({ type: 'del', text: a[i] }); i++; }
    else { rows.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

/** Linear-time diff for large inputs: resync on the nearest match within WINDOW lines. */
function windowedDiff(a: string[], b: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push({ type: 'ctx', text: a[i] }); i++; j++; continue; }
    let inB = -1;
    for (let k = j + 1; k < Math.min(b.length, j + WINDOW); k++) if (b[k] === a[i]) { inB = k; break; }
    let inA = -1;
    for (let k = i + 1; k < Math.min(a.length, i + WINDOW); k++) if (a[k] === b[j]) { inA = k; break; }
    if (inB !== -1 && (inA === -1 || inB - j <= inA - i)) {
      while (j < inB) rows.push({ type: 'add', text: b[j++] }); // lines inserted before a[i]
    } else if (inA !== -1) {
      while (i < inA) rows.push({ type: 'del', text: a[i++] }); // lines removed before b[j]
    } else {
      rows.push({ type: 'del', text: a[i++] });
      rows.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < a.length) rows.push({ type: 'del', text: a[i++] });
  while (j < b.length) rows.push({ type: 'add', text: b[j++] });
  return rows;
}
