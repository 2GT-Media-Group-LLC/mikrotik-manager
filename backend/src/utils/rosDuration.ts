/**
 * RouterOS durations ("25s", "1m30s", "1d2h", or "00:00:25" on RouterOS 6) as
 * whole seconds. Null when empty or unreadable.
 */
export function rosDurationSeconds(v: string | undefined | null): number | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const clock = /^(?:(\d+)d\s*)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(t);
  if (clock) return Number(clock[1] ?? 0) * 86400 + Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]);
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let rest = t;
  for (const m of t.matchAll(/(\d+)(ms|w|d|h|m|s)/g)) {
    if (m[2] !== 'ms') total += Number(m[1]) * units[m[2]];
    rest = rest.replace(m[0], '');
  }
  return rest.trim() === '' ? total : null;
}
