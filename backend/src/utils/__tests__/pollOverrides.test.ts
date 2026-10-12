import { resolveEffective, validateOverrides, cleanOverrides, effectiveValues } from '../pollOverrides';

const global = { polling_fast_interval: 30, polling_slow_interval: 300, polling_logs_interval: 60, backup_include_secrets: false };

describe('resolveEffective (#261)', () => {
  it('takes the device over the site over global, and says where each came from', () => {
    const e = resolveEffective(global, { polling_fast_interval: 120, backup_include_secrets: true }, { polling_fast_interval: 600 });
    expect(e.polling_fast_interval).toEqual({ value: 600, source: 'device' });
    expect(e.backup_include_secrets).toEqual({ value: true, source: 'site' });
    expect(e.polling_slow_interval).toEqual({ value: 300, source: 'global' });
  });
  it('falls back to the defaults when the global setting was never saved', () => {
    const v = effectiveValues({}, null, null);
    expect(v).toMatchObject({ fastSec: 30, slowSec: 300, logsSec: 60, macScanEnabled: true, configSnapEnabled: true, backupIncludeSecrets: false });
  });
});

describe('validateOverrides', () => {
  it('sets and clears overrides', () => {
    const r = validateOverrides({ polling_fast_interval: 60 }, { polling_fast_interval: null, mac_scan_enabled: false, polling_slow_interval: '900' });
    expect(r).toEqual({ ok: true, value: { mac_scan_enabled: false, polling_slow_interval: 900 } });
  });
  it('refuses unknown keys, values out of range and wrong types', () => {
    expect(validateOverrides({}, { login_rate_limit_max: 5 }).ok).toBe(false);
    expect(validateOverrides({}, { polling_fast_interval: 5 }).ok).toBe(false);
    expect(validateOverrides({}, { polling_fast_interval: 12.5 }).ok).toBe(false);
    expect(validateOverrides({}, { mac_scan_enabled: 'yes' }).ok).toBe(false);
    expect(validateOverrides({}, [1]).ok).toBe(false);
  });
});

describe('cleanOverrides', () => {
  it('drops unknown keys and bad values read from the database', () => {
    expect(cleanOverrides({ polling_fast_interval: 45, bogus: 1, mac_scan_enabled: 'x' })).toEqual({ polling_fast_interval: 45 });
    expect(cleanOverrides(null)).toEqual({});
  });
});
