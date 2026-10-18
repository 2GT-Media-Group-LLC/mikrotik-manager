/**
 * One device's view of the map (#305): it and everything within a few hops,
 * through neighbours discovery found and nodes added by hand as well as
 * managed devices, since an unmanaged switch between two of yours is still
 * the path between them. Clients hang off what they connect to and never
 * count as a hop.
 */
export interface FocusEdge { source: string; target: string; kind?: string }

export function nodesWithinHops(focus: string, edges: FocusEdge[], hops: number): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); };
  for (const e of edges) {
    if (e.kind === 'client') continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const seen = new Set([focus]);
  let ring = [focus];
  for (let h = 0; h < hops && ring.length; h++) {
    const next: string[] = [];
    for (const n of ring) for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); next.push(m); }
    ring = next;
  }
  // Clients (and client groups) of what's in view come along.
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (e.kind !== 'client') continue;
      if (seen.has(e.source) && !seen.has(e.target)) { seen.add(e.target); grew = true; }
    }
  }
  return seen;
}
