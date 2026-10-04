jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../AlertService', () => ({ alertService: { getRule: jest.fn(), dispatch: jest.fn() } }));
import { stalePeers, peerLabel, humanAge, checkWireGuardStale, type PeerRow } from '../wireguardStale';
import { query } from '../../config/database';
import { alertService } from '../AlertService';
import { rosDurationSeconds } from '../../utils/rosDuration';

const row = (over: Partial<PeerRow>): PeerRow => ({
  device_id: 1, device_name: 'gw', peer_id: '*1', interface: 'wg0', name: null, public_key: 'ABCDEFGHIJ', endpoint: null,
  last_handshake_sec: 30, disabled: false, interface_disabled: false, polled_ago_sec: 0, ...over,
});

describe('stalePeers (#208)', () => {
  it('picks peers whose last handshake is older than the threshold, counting time since the poll', () => {
    const out = stalePeers([
      row({ peer_id: 'fresh', last_handshake_sec: 90 }),
      row({ peer_id: 'old', last_handshake_sec: 20 * 60 }),
      row({ peer_id: 'aged-since-poll', last_handshake_sec: 14 * 60, polled_ago_sec: 120 }),
    ], 15);
    expect(out.map((p) => p.peer_id)).toEqual(['old', 'aged-since-poll']);
    expect(out[0].age_sec).toBe(1200);
  });
  it('leaves out peers that never connected, are disabled, or sit on a disabled interface', () => {
    expect(stalePeers([
      row({ peer_id: 'never', last_handshake_sec: null }),
      row({ peer_id: 'off', disabled: true, last_handshake_sec: 99999 }),
      row({ peer_id: 'iface-off', interface_disabled: true, last_handshake_sec: 99999 }),
    ], 15)).toEqual([]);
  });
});

describe('labels', () => {
  it('names a peer by name, then endpoint, then key', () => {
    expect(peerLabel({ name: 'branch', endpoint: '1.2.3.4:13231', public_key: 'K' })).toBe('branch');
    expect(peerLabel({ name: null, endpoint: '1.2.3.4:13231', public_key: 'K' })).toBe('1.2.3.4:13231');
    expect(peerLabel({ name: null, endpoint: null, public_key: 'ABCDEFGHIJKL' })).toBe('ABCDEFGH…');
  });
  it('says how long ago', () => {
    expect(humanAge(1200)).toBe('20 min');
    expect(humanAge(7200)).toBe('2 h');
    expect(humanAge(4 * 86400)).toBe('4 days');
  });
});

describe('checkWireGuardStale', () => {
  const getRule = alertService.getRule as jest.Mock;
  const dispatch = alertService.dispatch as jest.Mock;
  beforeEach(() => { getRule.mockReset(); dispatch.mockReset(); (query as jest.Mock).mockReset(); });

  it('does nothing while the rule is off', async () => {
    getRule.mockResolvedValue({ enabled: false, threshold: 15 });
    await checkWireGuardStale();
    expect(query).not.toHaveBeenCalled();
  });
  it('alerts once per stale peer, with its own cooldown key', async () => {
    getRule.mockResolvedValue({ enabled: true, threshold: 10 });
    (query as jest.Mock).mockResolvedValue([row({ peer_id: '*7', name: 'branch', last_handshake_sec: 3600 }), row({ peer_id: '*8' })]);
    await checkWireGuardStale();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [type, msg, ctx] = dispatch.mock.calls[0];
    expect(type).toBe('wireguard_stale');
    expect(msg).toMatch(/"branch" on wg0.*in 1 h \(alert after 10 min\)/);
    expect(ctx).toMatchObject({ deviceId: 1, cooldownKey: 'wireguard_stale:1:*7' });
  });
});

describe('rosDurationSeconds (backend)', () => {
  it('reads RouterOS handshake ages', () => {
    expect(rosDurationSeconds('1m23s')).toBe(83);
    expect(rosDurationSeconds('2w1d')).toBe(1_296_000);
    expect(rosDurationSeconds('')).toBeNull();
    expect(rosDurationSeconds('00:01:05')).toBe(65);
  });
});
