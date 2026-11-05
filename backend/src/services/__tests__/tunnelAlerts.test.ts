jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../AlertService', () => ({ alertService: { getRule: jest.fn(), dispatch: jest.fn() } }));
import { checkTunnels, tunnelDescription } from '../tunnelAlerts';
import { query } from '../../config/database';
import { alertService } from '../AlertService';

const getRule = jest.mocked(alertService.getRule);
const dispatch = jest.mocked(alertService.dispatch);
const db = jest.mocked(query);

beforeEach(() => { getRule.mockReset(); dispatch.mockReset(); db.mockReset(); });

describe('tunnel down alert (#310)', () => {
  it('does nothing while the rule is off', async () => {
    getRule.mockResolvedValue({ enabled: false } as never);
    await checkTunnels();
    expect(db).not.toHaveBeenCalled();
  });

  it('asks only for tunnels that were up, are down past the threshold, of the kinds that go down', async () => {
    getRule.mockResolvedValue({ enabled: true, threshold: 10 } as never);
    db.mockResolvedValue([]);
    await checkTunnels();
    const [sql, params] = db.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`t.status = 'down'`);
    expect(sql).toContain('t.last_up_at IS NOT NULL');
    expect(params[0]).toBe('10');
    expect((params[1] as string[]).sort()).toEqual(['eoip', 'gre', 'ipip', 'ipsec', 'pppoe-client']);
  });

  it('alerts once per tunnel, with its own cooldown key', async () => {
    getRule.mockResolvedValue({ enabled: true, threshold: null } as never);
    db.mockResolvedValue([{ device_id: 3, device_name: 'core ', kind: 'eoip', tunnel_key: 'eoip:eoip-hq', name: 'eoip-hq', remote_address: '192.0.2.2', state: 'not running', down_sec: 600 }] as never);
    await checkTunnels();
    expect(db.mock.calls[0][1]![0]).toBe('5');
    expect(dispatch).toHaveBeenCalledWith('tunnel_down', 'EoIP tunnel "eoip-hq" (to 192.0.2.2) on core has been down for 10 min (not running).',
      { deviceId: 3, deviceName: 'core', cooldownKey: 'tunnel_down:3:eoip:eoip:eoip-hq' });
  });

  it('describes each kind plainly', () => {
    expect(tunnelDescription({ kind: 'ipsec', name: 'branch-a', remote_address: null })).toBe('IPsec peer "branch-a"');
    expect(tunnelDescription({ kind: 'pppoe-client', name: 'wan', remote_address: null })).toBe('PPPoE client "wan"');
  });
});
