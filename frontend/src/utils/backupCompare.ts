/**
 * Ordering two selected backups for comparison (#134).
 *
 * A diff is directional: rendered the wrong way round, every addition reads as a
 * deletion and vice versa. Nothing about the output looks broken when this is
 * backwards, which is exactly why it is worth pinning down — selection order in
 * the table is whatever the user happened to click, and carries no meaning.
 */

export interface ComparableBackup {
  id: number;
  created_at: string;
}

/**
 * Returns [older, newer] so the diff reads forwards in time.
 *
 * Returns null unless exactly two are selected: comparing one thing, or three,
 * is not a diff, and the caller should disable the action rather than guess.
 */
export function orderForDiff(
  selectedIds: number[],
  backups: ComparableBackup[]
): [number, number] | null {
  if (selectedIds.length !== 2) return null;

  const at = (id: number): number => {
    const b = backups.find((x) => x.id === id);
    const t = b ? new Date(b.created_at).getTime() : NaN;
    return Number.isNaN(t) ? 0 : t;
  };

  const [a, b] = selectedIds;
  if (at(a) === at(b)) {
    // Same timestamp, or both unknown: fall back to id, which still increases
    // with time, so the direction stays meaningful rather than arbitrary.
    return a <= b ? [a, b] : [b, a];
  }
  return at(a) < at(b) ? [a, b] : [b, a];
}
