jest.mock('../../config/database');
jest.mock('../mikrotik/DeviceCollector');

import { validateSnmpInput, applySnmpConfig, SnmpInputError } from '../snmpApply';
import { query } from '../../config/database';

describe('validateSnmpInput (fleet SNMP changes)', () => {
  it('accepts a single chosen change, such as only a trap destination', () => {
    expect(() => validateSnmpInput({ trap_target: '10.0.0.5' })).not.toThrow();
    expect(() => validateSnmpInput({ enabled: false })).not.toThrow();
  });

  it('refuses a request that changes nothing', () => {
    expect(() => validateSnmpInput({ contact: '  ', location: '' })).toThrow(SnmpInputError);
  });

  it('needs a user name to set up SNMPv3', () => {
    expect(() => validateSnmpInput({ version: 'v3' })).toThrow(/user name/);
    expect(() => validateSnmpInput({ version: 'v3', community_name: 'nms' })).not.toThrow();
  });
});

describe('applySnmpConfig targets', () => {
  it('refuses an empty device selection before touching anything', async () => {
    await expect(applySnmpConfig({ deviceIds: [] }, { trap_target: '10.0.0.5' }, null)).rejects.toThrow(/at least one device/);
    expect(query).not.toHaveBeenCalled();
  });

  it('lists chosen devices it could not reach as skipped', async () => {
    jest.mocked(query).mockResolvedValueOnce([] as never);   // e.g. offline or in another site
    const r = await applySnmpConfig({ deviceIds: [7, 9] }, { trap_target: '10.0.0.5' }, null);
    expect(r).toMatchObject({ applied: 0, total: 0, skipped: [7, 9] });
    const [sql, params] = jest.mocked(query).mock.calls[0];
    expect(String(sql)).toContain('d.id = ANY($1::int[])');
    expect(params).toEqual([[7, 9]]);
  });
});
