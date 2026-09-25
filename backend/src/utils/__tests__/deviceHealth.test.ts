import { normalizeHealth, evaluateHealth } from '../deviceHealth';

// Captured from the reference fleet's CRS510 (dual PSU), then altered.
const crs510 = [
  { name: 'switch-temperature', value: '58', type: 'C' },
  { name: 'fan-state', value: 'ok', type: '' },
  { name: 'fan1-speed', value: '2790', type: 'RPM' },
  { name: 'psu1-state', value: 'ok', type: '' },
  { name: 'psu2-state', value: 'ok', type: '' },
  { name: '2pin-voltage', value: '0', type: 'V' },
];

describe('evaluateHealth (#168)', () => {
  it('is ok on a healthy dual-PSU switch, and ignores 0 V on unused inputs', () => {
    expect(evaluateHealth(normalizeHealth(crs510))).toEqual({ status: 'ok', issues: [], ignored: [] });
  });

  it('is degraded when one power supply fails, the reported case', () => {
    const rows = crs510.map((r) => (r.name === 'psu1-state' ? { ...r, value: 'fail' } : r));
    const v = evaluateHealth(normalizeHealth(rows));
    expect(v.status).toBe('degraded');
    expect(v.issues).toEqual([{ item: 'psu1-state', value: 'fail', message: 'Power supply 1 reports "fail".' }]);
  });

  it('flags a failed fan state but not a stopped fan', () => {
    expect(evaluateHealth(normalizeHealth([{ name: 'fan-state', value: 'fail', type: '' }])).status).toBe('degraded');
    expect(evaluateHealth(normalizeHealth([{ name: 'fan1-speed', value: '0', type: 'RPM' }])).status).toBe('ok');
  });

  it('flags a temperature at or over the limit', () => {
    const v = evaluateHealth(normalizeHealth([{ name: 'cpu-temperature', value: '91', type: 'C' }]), { tempLimitC: 90 });
    expect(v.issues[0].message).toBe('cpu-temperature is 91°C (limit 90°C).');
    expect(evaluateHealth(normalizeHealth([{ name: 'cpu-temperature', value: '89', type: 'C' }]), { tempLimitC: 90 }).status).toBe('ok');
  });

  it('moves ignored readings aside instead of dropping them', () => {
    const rows = [{ name: 'psu2-state', value: 'fail', type: '' }];
    const v = evaluateHealth(normalizeHealth(rows), { ignored: ['psu2-state'] });
    expect(v.status).toBe('ok');
    expect(v.ignored).toHaveLength(1);
  });

  it('reads the RouterOS v6 single-row format', () => {
    const v = evaluateHealth(normalizeHealth([{ '.id': '*0', 'psu1-state': 'ok', 'psu2-state': 'fail', temperature: '40' }]));
    expect(v.issues.map((i) => i.item)).toEqual(['psu2-state']);
  });

  it('is unknown, not ok, when a device reports nothing', () => {
    expect(evaluateHealth([]).status).toBe('unknown');
  });
});
