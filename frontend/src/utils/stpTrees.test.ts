import { describe, it, expect } from 'vitest';
import { stpOverview, bridgePriority } from './stpTrees';

const devices = [
  { id: 1, name: '100G', device_type: 'switch' },
  { id: 7, name: 'BigSwitch', device_type: 'switch' },
  { id: 2, name: 'AP4', device_type: 'wireless_ap' },
  { id: 26, name: 'MiniRack', device_type: 'switch' },
  { id: 9, name: 'Lab', device_type: 'router' },
];
const br = (device_id: number, bridge_id: string, root_bridge_id: string, root_port: string, cost: number, mode = 'rstp') => ({
  device_id, bridge_name: 'bridge', bridge_id, root_bridge: bridge_id === root_bridge_id, root_bridge_id, root_port,
  root_path_cost: cost, protocol_mode: mode,
});

describe('spanning-tree overview', () => {
  it('reads a bridge priority from its id', () => {
    expect(bridgePriority('0x8000.F4:1E:57:51:74:1E')).toBe('0x8000');
    expect(bridgePriority('0x1000.aa:bb:cc:dd:ee:ff')).toBe('0x1000');
    expect(bridgePriority(null)).toBeNull();
  });

  it('groups bridges by the root they see and flags what is wrong', () => {
    const o = stpOverview(devices, [
      br(1, '0x8000.F4:1E:57:51:74:1E', '0x8000.F4:1E:57:51:74:1E', 'none', 0),
      br(7, '0x8000.F4:1E:57:BD:F0:2A', '0x8000.F4:1E:57:51:74:1E', 'sfp28-2', 800),
      br(2, '0x8000.D0:EA:11:0A:DE:77', '0x8000.D0:EA:11:0A:DE:77', 'none', 0),
      br(26, '0x8000.38:32:7A:34:E5:1B', '0x2000.70:A7:41:EF:8F:FB', 'sfp-sfpplus1', 43010),
      br(9, '0x8000.00:00:00:00:00:09', '', 'none', 0, 'none'),
    ], [{ rootBridgeId: '0x2000.70:A7:41:EF:8F:FB', ownerDeviceId: null, guessedName: 'USW-Core', defaultPriority: false, memberDeviceIds: [26] }]);

    expect(o.trees.map((t) => [t.rootName, t.rows.map((r) => r.deviceName)])).toEqual([
      ['100G', ['100G', 'BigSwitch']],
      ['AP4', ['AP4']],
      ['USW-Core', ['MiniRack']],
    ]);
    expect(o.trees[0].rows[1]).toMatchObject({ rootPort: 'sfp28-2', cost: 800, priority: '0x8000', isRoot: false });
    expect(o.off.map((r) => r.deviceName)).toEqual(['Lab']);
    expect(o.warnings.map((w) => w.text)).toEqual([
      expect.stringMatching(/3 separate spanning trees/),
      expect.stringMatching(/^100G is root only because it has the lowest MAC/),
      expect.stringMatching(/^AP4 is root .*it's an access point/),
      expect.stringMatching(/^USW-Core is root of a tree but isn't managed here \(priority 0x2000\)/),
    ]);
  });

  it('has nothing to say about one tree rooted on purpose', () => {
    const o = stpOverview(devices, [
      br(1, '0x1000.F4:1E:57:51:74:1E', '0x1000.F4:1E:57:51:74:1E', 'none', 0),
      br(7, '0x8000.F4:1E:57:BD:F0:2A', '0x1000.F4:1E:57:51:74:1E', 'sfp28-2', 800),
    ], []);
    expect(o.trees).toHaveLength(1);
    expect(o.warnings).toEqual([]);
  });
});
