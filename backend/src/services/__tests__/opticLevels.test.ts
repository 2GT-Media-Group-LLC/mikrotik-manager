const queryMock = jest.fn();
jest.mock('../../config/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
const dispatch = jest.fn();
const getRule = jest.fn();
jest.mock('../AlertService', () => ({ alertService: { dispatch: (...a: unknown[]) => dispatch(...a), getRule: (t: string) => getRule(t) } }));

import { recordOptics, checkOptics } from '../opticLevels';

beforeEach(() => { queryMock.mockReset(); dispatch.mockReset(); getRule.mockReset(); });

it('stores only modules that report diagnostics', async () => {
  await recordOptics(3, new Map<string, Record<string, string>>([
    ['sfp28-1', { 'sfp-module-present': 'true', 'sfp-rx-power': '-5.2', 'sfp-tx-power': '-2.1', 'sfp-temperature': '41' }],
    ['sfp28-2', { 'sfp-module-present': 'true', 'sfp-connector-type': 'copper-pigtail' }],
    ['qsfp28-1-1', { 'sfp-module-present': 'true', 'sfp-rx-power': '-1,-2,-3,-4' }],
  ]));
  expect(queryMock).toHaveBeenCalledTimes(2);
  expect(queryMock.mock.calls[0][1]).toEqual([3, 'sfp28-1', -5.2, -2.1, 41, null, null, null]);
  expect(queryMock.mock.calls[1][1]).toEqual([3, 'qsfp28-1-1', -4, null, null, null, null, '-1,-2,-3,-4']);
});

it('alerts per port with the reading and the usual level', async () => {
  getRule.mockResolvedValue({ enabled: true, threshold: 3 });
  queryMock.mockImplementation(async (sql: string) => sql.includes('optic_readings')
    ? [
      { device_id: 5, interface: 'sfp28-3', rx_dbm: -9.1, tx_dbm: -2.2, temp_c: 45, bias_ma: 7, voltage: 3.3, rx_lanes: null, usual_rx: -5.0, usual_tx: -2.2, readings: 300 },
      { device_id: 5, interface: 'sfp28-4', rx_dbm: -5.2, tx_dbm: -2.2, temp_c: 45, bias_ma: 7, voltage: 3.3, rx_lanes: null, usual_rx: -5.0, usual_tx: -2.2, readings: 300 },
    ]
    : [{ id: 5, name: 'Edge' }]);
  await checkOptics();
  expect(dispatch).toHaveBeenCalledTimes(1);
  const [type, msg, ctx] = dispatch.mock.calls[0];
  expect(type).toBe('optic_degraded');
  expect(msg).toMatch(/sfp28-3 on Edge: receive light 4\.1 dB below its usual level\. Now receive -9\.1 dBm \(usually -5\)/);
  expect(msg).toMatch(/Clean the connectors, check the fibre and the far end, or replace the optic\.$/);
  expect(ctx.cooldownKey).toBe('optic_degraded:5:sfp28-3');
});

it('gives cooling advice for a hot module', async () => {
  getRule.mockResolvedValue({ enabled: true, threshold: 3 });
  queryMock.mockImplementation(async (sql: string) => sql.includes('optic_readings')
    ? [{ device_id: 5, interface: 'sfp28-5', rx_dbm: -5, tx_dbm: -2, temp_c: 74, bias_ma: 7, voltage: 3.3, rx_lanes: null, usual_rx: -5, usual_tx: -2, readings: 300 }]
    : [{ id: 5, name: 'Edge' }]);
  await checkOptics();
  expect(dispatch.mock.calls[0][1]).toMatch(/module at 74 °C\..*Check the airflow around the switch, or replace the optic\.$/);
});

it('does nothing while the rule is off', async () => {
  getRule.mockResolvedValue({ enabled: false, threshold: 3 });
  await checkOptics();
  expect(queryMock).not.toHaveBeenCalled();
});
