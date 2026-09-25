/**
 * Turning /system/health into "ok" or "degraded" (#168).
 *
 * A device with a failed power supply stayed green because it was still
 * reachable. Health was only read when someone opened the Hardware tab.
 *
 * RouterOS reports health two ways. v7 returns one row per reading:
 *   { name: 'psu1-state', value: 'ok', type: '' }
 *   { name: 'switch-temperature', value: '58', type: 'C' }
 * v6 returns a single row with a key per reading:
 *   { 'psu1-state': 'ok', temperature: '41', 'fan1-speed': '3000' }
 * Both are normalised first.
 *
 * What counts as degraded, deliberately narrow:
 *   - a power supply state that is not "ok"
 *   - a fan state that is not "ok" (RouterOS's own verdict; a fan speed of 0
 *     is not a failure on its own, since some models stop fans when cool)
 *   - a temperature at or above the configured limit
 * Voltages are not judged: normal ranges differ by model and power source.
 *
 * Readings can be ignored per device. A dual-supply switch fed from one supply
 * on purpose reports the other as failed forever, and would otherwise sit
 * amber with nothing to fix.
 */

export interface HealthReading {
  name: string;
  value: string;
  unit: string;
}

export interface HealthIssue {
  item: string;
  value: string;
  message: string;
}

export interface HealthVerdict {
  status: 'ok' | 'degraded' | 'unknown';
  issues: HealthIssue[];
  /** Problems found but ignored on this device, still shown so they aren't forgotten. */
  ignored: HealthIssue[];
}

export const DEFAULT_TEMP_LIMIT_C = 85;

export function normalizeHealth(rows: Record<string, string>[]): HealthReading[] {
  const out: HealthReading[] = [];
  for (const row of rows) {
    if (typeof row.name === 'string' && row.value !== undefined) {
      out.push({ name: row.name, value: String(row.value), unit: row.type ?? '' });
      continue;
    }
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('.') || v === undefined) continue;
      out.push({ name: k, value: String(v), unit: /temperature/.test(k) ? 'C' : '' });
    }
  }
  return out;
}

const isState = (name: string, kind: 'psu' | 'fan') =>
  kind === 'psu' ? /^(psu\d*|power-supply\d*)-state$/.test(name) : /^fan\d*-state$/.test(name);

function describe(r: HealthReading, tempLimit: number): string | null {
  const v = r.value.trim().toLowerCase();
  if (isState(r.name, 'psu')) {
    if (v === 'ok') return null;
    const n = r.name.match(/\d+/)?.[0];
    return `Power supply${n ? ` ${n}` : ''} reports "${r.value}".`;
  }
  if (isState(r.name, 'fan')) {
    if (v === 'ok') return null;
    const n = r.name.match(/\d+/)?.[0];
    return `Fan${n ? ` ${n}` : 's'} report${n ? 's' : ''} "${r.value}".`;
  }
  if (/temperature/.test(r.name) && (r.unit === 'C' || r.unit === '')) {
    const t = Number(r.value);
    if (Number.isFinite(t) && t >= tempLimit) return `${r.name} is ${t}°C (limit ${tempLimit}°C).`;
  }
  return null;
}

export function evaluateHealth(
  readings: HealthReading[],
  opts: { tempLimitC?: number; ignored?: string[] } = {}
): HealthVerdict {
  const tempLimit = opts.tempLimitC && opts.tempLimitC > 0 ? opts.tempLimitC : DEFAULT_TEMP_LIMIT_C;
  const ignored = new Set(opts.ignored ?? []);
  const verdict: HealthVerdict = { status: readings.length ? 'ok' : 'unknown', issues: [], ignored: [] };
  for (const r of readings) {
    const message = describe(r, tempLimit);
    if (!message) continue;
    const issue = { item: r.name, value: r.value, message };
    (ignored.has(r.name) ? verdict.ignored : verdict.issues).push(issue);
  }
  if (verdict.issues.length) verdict.status = 'degraded';
  return verdict;
}

/** A short line for alerts and tooltips. */
export function summarizeIssues(issues: HealthIssue[]): string {
  return issues.map((i) => i.message).join(' ');
}
