import { describe, it, expect } from 'vitest';
import { resolveStpRoot, bridgePriority, type BridgeInfo } from './stpRoot';

const RB4011 = '0x1000.2C:C8:1B:05:2B:B1';   // priority 4096
const AP_A   = '0x2000.AA:AA:AA:AA:AA:AA';   // priority 8192
const AP_B   = '0x2000.BB:BB:BB:BB:BB:BB';
const FOREIGN = '0x2000.70:A7:41:EF:8F:FB';  // real root, not in the fleet

const b = (
  device_id: number, bridge_id: string, root_bridge: boolean, root_bridge_id: string | null,
): BridgeInfo => ({
  device_id, bridge_name: 'bridge', bridge_id, root_bridge, root_bridge_id,
  root_port: null, root_path_cost: null, protocol_mode: 'rstp',
});

describe('resolveStpRoot — the reported case', () => {
  // RB4011 at priority 4096 is root; two APs at 8192 both point at it. The old
  // logic crowned an AP because it matched port role 'root' instead of
  // 'root-port', so nothing matched and the first device in the list won.
  const fleet = [
    b(1, RB4011, true, RB4011),
    b(2, AP_A, false, RB4011),
    b(3, AP_B, false, RB4011),
  ];

  it('names the device that says it is root', () => {
    const v = resolveStpRoot(['1', '2', '3'], fleet);
    expect(v.deviceId).toBe('1');
    expect(v.confidence).toBe('reported');
  });

  it('does not depend on the order devices arrive in', () => {
    // The precise failure being fixed: the answer used to be whichever sorted
    // first, so it must now be stable under any ordering.
    for (const order of [['1','2','3'], ['2','3','1'], ['3','2','1'], ['2','1','3']]) {
      expect(resolveStpRoot(order, fleet).deviceId).toBe('1');
    }
  });

  it('is unmoved by shuffling the bridge rows themselves', () => {
    const shuffled = [fleet[2], fleet[0], fleet[1]];
    expect(resolveStpRoot(['1', '2', '3'], shuffled).deviceId).toBe('1');
  });
});

describe('resolveStpRoot — a root we do not manage', () => {
  // Observed on a real switch: it points at priority 8192 on a MAC belonging to
  // no device in the inventory.
  const fleet = [
    b(8, AP_A, false, FOREIGN),
    b(9, AP_B, false, FOREIGN),
  ];

  it('declines to nominate one of ours', () => {
    const v = resolveStpRoot(['8', '9'], fleet);
    expect(v.deviceId).toBeNull();
    expect(v.confidence).toBe('external');
  });

  it('reports the bridge id so the operator can identify it', () => {
    expect(resolveStpRoot(['8', '9'], fleet).rootBridgeId).toBe(FOREIGN);
  });
});

describe('resolveStpRoot — separate spanning trees', () => {
  it('gives each component its own root', () => {
    // Two of four devices legitimately report root at once on a mixed fleet;
    // "the root" is per tree, not per fleet.
    const fleet = [
      b(1, RB4011, true, RB4011),
      b(2, AP_A, false, RB4011),
      b(7, AP_B, true, AP_B),
    ];
    expect(resolveStpRoot(['1', '2'], fleet).deviceId).toBe('1');
    expect(resolveStpRoot(['7'], fleet).deviceId).toBe('7');
  });

  it('prefers the claimant others actually point at', () => {
    const fleet = [
      b(1, RB4011, true, RB4011),
      b(2, AP_A, true, AP_A),
      b(3, AP_B, false, RB4011),
    ];
    expect(resolveStpRoot(['1', '2', '3'], fleet).deviceId).toBe('1');
  });
});

describe('resolveStpRoot — degraded input', () => {
  it('matches on bridge id when nobody claims the crown', () => {
    const fleet = [
      b(1, RB4011, false, RB4011),
      b(2, AP_A, false, RB4011),
    ];
    const v = resolveStpRoot(['1', '2'], fleet);
    expect(v.deviceId).toBe('1');
    expect(v.confidence).toBe('matched');
  });

  it('compares bridge ids without caring about MAC case', () => {
    const fleet = [
      b(1, RB4011.toUpperCase(), false, RB4011.toLowerCase()),
      b(2, AP_A, false, RB4011.toLowerCase()),
    ];
    expect(resolveStpRoot(['1', '2'], fleet).deviceId).toBe('1');
  });

  it('admits it does not know when there is no STP data', () => {
    // Better than guessing: the caller falls back to a connectivity heuristic
    // and can say so, rather than presenting a guess as fact.
    expect(resolveStpRoot(['1', '2'], [])).toEqual({
      deviceId: null, confidence: 'unknown', rootBridgeId: null,
    });
  });

  it('ignores bridges belonging to devices outside the component', () => {
    const fleet = [b(99, RB4011, true, RB4011)];
    expect(resolveStpRoot(['1', '2'], fleet).confidence).toBe('unknown');
  });
});

describe('bridgePriority', () => {
  it('reads the priority out of a bridge id', () => {
    expect(bridgePriority(RB4011)).toBe(4096);
    expect(bridgePriority(AP_A)).toBe(8192);
    expect(bridgePriority('0x8000.F4:1E:57:51:74:1E')).toBe(32768);
  });
  it('copes with nothing usable', () => {
    expect(bridgePriority(null)).toBeNull();
    expect(bridgePriority('garbage')).toBeNull();
  });
});
