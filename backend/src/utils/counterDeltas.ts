/**
 * Non-negative deltas of per-device cumulative counters, summed per time. A
 * negative step (counter reset, reconnect) is skipped.
 */
export function counterDeltas(points: { time: string; device: string; value: number }[]): Map<string, number> {
  const byDevice = new Map<string, { time: string; value: number }[]>();
  for (const p of points) {
    const list = byDevice.get(p.device) ?? [];
    list.push(p);
    byDevice.set(p.device, list);
  }
  const out = new Map<string, number>();
  for (const series of byDevice.values()) {
    series.sort((a, b) => a.time.localeCompare(b.time));
    for (let i = 1; i < series.length; i++) {
      const cur = series.at(i)!;
      const diff = cur.value - series.at(i - 1)!.value;
      if (diff >= 0) out.set(cur.time, (out.get(cur.time) ?? 0) + diff);
    }
  }
  return out;
}
