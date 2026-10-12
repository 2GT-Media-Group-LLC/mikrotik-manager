/**
 * Settings a site or a device can override (#261): global, then site, then
 * device, the most specific winning. A slow or metered link wants a gentler
 * poll than the LAN; a sensitive site wants backups without secrets.
 */

export type OverrideKey =
  | 'polling_fast_interval' | 'polling_slow_interval' | 'polling_logs_interval'
  | 'mac_scan_enabled' | 'mac_scan_interval'
  | 'config_snapshot_enabled' | 'config_snapshot_interval_min'
  | 'backup_include_secrets';

interface Def {
  type: 'seconds' | 'minutes' | 'boolean';
  /** When the global setting has never been saved. */
  fallback: number | boolean;
  min?: number;
  max?: number;
}

export const OVERRIDABLE: Record<OverrideKey, Def> = {
  polling_fast_interval:        { type: 'seconds', fallback: 30,  min: 10,  max: 3600 },
  polling_slow_interval:        { type: 'seconds', fallback: 300, min: 60,  max: 86400 },
  polling_logs_interval:        { type: 'seconds', fallback: 60,  min: 10,  max: 86400 },
  mac_scan_enabled:             { type: 'boolean', fallback: true },
  mac_scan_interval:            { type: 'seconds', fallback: 300, min: 60,  max: 86400 },
  config_snapshot_enabled:      { type: 'boolean', fallback: true },
  config_snapshot_interval_min: { type: 'minutes', fallback: 60,  min: 5,   max: 10080 },
  backup_include_secrets:       { type: 'boolean', fallback: false },
};

export const OVERRIDE_KEYS = Object.keys(OVERRIDABLE) as OverrideKey[];

export type Overrides = Partial<Record<OverrideKey, number | boolean>>;
export type Source = 'device' | 'site' | 'global';
export type Effective = Record<OverrideKey, { value: number | boolean; source: Source }>;

/** A value as the setting would hold it, or undefined when it isn't one. */
function coerce(key: OverrideKey, v: unknown): number | boolean | undefined {
  const def = OVERRIDABLE[key];
  if (def.type === 'boolean') return typeof v === 'boolean' ? v : undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return Math.min(def.max ?? n, Math.max(def.min ?? n, n));
}

/** Clean overrides read from the database: unknown keys and bad values dropped. */
export function cleanOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of OVERRIDE_KEYS) {
    const v = coerce(key, (raw as Record<string, unknown>)[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Check overrides from a request: each key known and its value in range; null
 * removes an override. Returns the full set to store.
 */
export function validateOverrides(current: Overrides, body: unknown): { ok: true; value: Overrides } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send an object of settings.' };
  const next: Overrides = { ...current };
  for (const [key, v] of Object.entries(body as Record<string, unknown>)) {
    if (!(key in OVERRIDABLE)) return { ok: false, error: `${key} can't be overridden.` };
    const k = key as OverrideKey;
    if (v === null) { delete next[k]; continue; }
    const def = OVERRIDABLE[k];
    if (def.type === 'boolean') {
      if (typeof v !== 'boolean') return { ok: false, error: `${key} must be true or false.` };
      next[k] = v;
      continue;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < (def.min ?? -Infinity) || n > (def.max ?? Infinity)) {
      return { ok: false, error: `${key} must be a whole number from ${def.min} to ${def.max}.` };
    }
    next[k] = n;
  }
  return { ok: true, value: next };
}

/** The value in force for each setting, and where it comes from. */
export function resolveEffective(global: Record<string, unknown>, site: Overrides | null, device: Overrides | null): Effective {
  const out = {} as Effective;
  for (const key of OVERRIDE_KEYS) {
    if (device && device[key] !== undefined) out[key] = { value: device[key]!, source: 'device' };
    else if (site && site[key] !== undefined) out[key] = { value: site[key]!, source: 'site' };
    else out[key] = { value: coerce(key, global[key]) ?? OVERRIDABLE[key].fallback, source: 'global' };
  }
  return out;
}

/** Just the values, for the poller. */
export function effectiveValues(global: Record<string, unknown>, site: Overrides | null, device: Overrides | null) {
  const e = resolveEffective(global, site, device);
  return {
    fastSec: e.polling_fast_interval.value as number,
    slowSec: e.polling_slow_interval.value as number,
    logsSec: e.polling_logs_interval.value as number,
    macScanEnabled: e.mac_scan_enabled.value as boolean,
    macScanSec: e.mac_scan_interval.value as number,
    configSnapEnabled: e.config_snapshot_enabled.value as boolean,
    configSnapMin: e.config_snapshot_interval_min.value as number,
    backupIncludeSecrets: e.backup_include_secrets.value as boolean,
  };
}
