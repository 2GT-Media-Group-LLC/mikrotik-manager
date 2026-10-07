const queryMock = jest.fn();
jest.mock('../../config/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
const dispatch = jest.fn();
const getRule = jest.fn();
jest.mock('../AlertService', () => ({ alertService: { dispatch: (...a: unknown[]) => dispatch(...a), getRule: (t: string) => getRule(t) } }));

import { recordInterfaceCounters, checkInterfaceErrors, forgetBaseline } from '../interfaceErrors';

const row = (name: string, fcs: string) => ({ name, 'rx-fcs-error': fcs, 'rx-align-error': '0' });

beforeEach(() => { queryMock.mockReset(); dispatch.mockReset(); getRule.mockReset(); forgetBaseline(); });

describe('recordInterfaceCounters', () => {
  it('only sets a baseline on the first poll, then stores intervals that grew', async () => {
    const downs = new Map([['sfp28-1', '2'], ['sfp28-2', '0']]);
    await recordInterfaceCounters(1, [row('sfp28-1', '100'), row('sfp28-2', '0')], downs, 0);
    expect(queryMock).not.toHaveBeenCalled();
    await recordInterfaceCounters(1, [row('sfp28-1', '130'), row('sfp28-2', '0')], new Map([['sfp28-1', '3'], ['sfp28-2', '0']]), 30);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][1]).toEqual([1, 'sfp28-1', 30, 30, 0, 0, 0, 1]);
  });

  it('stores nothing after a reboot reset the counters', async () => {
    await recordInterfaceCounters(1, [row('sfp28-1', '900')], new Map(), 0);
    await recordInterfaceCounters(1, [row('sfp28-1', '4')], new Map(), 30);
    await recordInterfaceCounters(1, [row('sfp28-1', '4')], new Map(), 30);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('checkInterfaceErrors', () => {
  it('does nothing while both rules are off', async () => {
    getRule.mockResolvedValue({ enabled: false, threshold: 10 });
    await checkInterfaceErrors();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('alerts per port, for the error rate and for flapping', async () => {
    getRule.mockImplementation(async (t: string) => t === 'interface_errors'
      ? { enabled: true, threshold: 10 } : { enabled: true, threshold: 3 });
    queryMock.mockImplementation(async (sql: string) => sql.includes('FROM interface_error_events')
      ? [
        { device_id: 4, interface: 'qsfp28-1-1', ago_sec: 60, fcs: 80, align: 0, overflow: 0, other: 0, link_downs: 0 },
        { device_id: 4, interface: 'ether7', ago_sec: 60, fcs: 0, align: 0, overflow: 0, other: 0, link_downs: 3 },
        { device_id: 4, interface: 'ether8', ago_sec: 60, fcs: 2, align: 0, overflow: 0, other: 0, link_downs: 0 },
      ]
      : [{ id: 4, name: 'Core ' }]);
    await checkInterfaceErrors();
    expect(dispatch).toHaveBeenCalledTimes(2);
    const byType = (t: string) => dispatch.mock.calls.find((c) => c[0] === t)!;
    const [errType, errMsg, errCtx] = byType('interface_errors');
    expect(errType).toBe('interface_errors');
    expect(errMsg).toMatch(/qsfp28-1-1 on Core is receiving 16 bad frames a minute.*FCS 80.*link stayed up/);
    expect(errCtx).toMatchObject({ deviceId: 4, cooldownKey: 'interface_errors:4:qsfp28-1-1' });
    const [flapType, flapMsg, flapCtx] = byType('interface_flapping');
    expect(flapType).toBe('interface_flapping');
    expect(flapMsg).toMatch(/ether7 on Core went down 3 times/);
    expect(flapCtx.cooldownKey).toBe('interface_flapping:4:ether7');
  });
});
