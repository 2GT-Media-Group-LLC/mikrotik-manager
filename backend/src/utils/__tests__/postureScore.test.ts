import { updateChecks, markAndScore, withCurrentUpdates, type MarkedCheck } from '../postureScore';

const telnet: MarkedCheck = { id: 'svc-telnet', severity: 'high', title: 'Telnet is enabled', detail: '' };
const outdated: MarkedCheck = { id: 'firmware-outdated', severity: 'medium', title: 'RouterOS update available', detail: 'runs 7.19 but 7.20 is available' };

describe('posture update findings (#371)', () => {
  it('builds the update findings from the device row', () => {
    expect(updateChecks({ firmware_update_available: true, latest_ros_version: '7.20', ros_version: '7.19' }).map((c) => c.id))
      .toEqual(['firmware-outdated']);
    expect(updateChecks({ routerboard_upgrade_available: true }).map((c) => c.id)).toEqual(['routerboot-outdated']);
    expect(updateChecks({ firmware_update_available: false, latest_ros_version: '7.20' })).toEqual([]);
    // No version to name, no finding: the same rule as before.
    expect(updateChecks({ firmware_update_available: true, latest_ros_version: null })).toEqual([]);
  });

  it('drops a cached update finding once the device is upgraded, and re-scores', () => {
    const before = markAndScore([telnet, outdated], 1, []);
    expect(before.score).toBe(100 - 15 - 7);
    const after = withCurrentUpdates(before.checks, { id: 1, firmware_update_available: false, latest_ros_version: '7.20' }, []);
    expect(after.checks.map((c) => c.id)).toEqual(['svc-telnet']);
    expect(after.score).toBe(85);
  });

  it('adds an update finding the cached copy did not have', () => {
    const cached = markAndScore([telnet], 1, []).checks;
    const now = withCurrentUpdates(cached, { id: 1, firmware_update_available: true, latest_ros_version: '7.21', ros_version: '7.20' }, []);
    expect(now.checks.map((c) => c.id)).toEqual(['svc-telnet', 'firmware-outdated']);
    expect(now.checks[1].detail).toContain('7.20 but 7.21');
  });

  it('applies mutes for this device and the fleet, the device one winning', () => {
    const supp = [
      { check_id: 'firmware-outdated', device_id: null, reason: 'fleet' },
      { check_id: 'firmware-outdated', device_id: 1, reason: 'mine' },
      { check_id: 'svc-telnet', device_id: 2, reason: 'not me' },
    ];
    const r = withCurrentUpdates([telnet], { id: 1, firmware_update_available: true, latest_ros_version: '7.21' }, supp);
    const fw = r.checks.find((c) => c.id === 'firmware-outdated')!;
    expect(fw).toMatchObject({ suppressed: true, suppressed_scope: 'device', suppressed_reason: 'mine' });
    expect(r.checks.find((c) => c.id === 'svc-telnet')!.suppressed).toBeUndefined();
    expect(r.score).toBe(85);
  });

  it('clears a stale mute mark when the mute is gone', () => {
    const cached = markAndScore([telnet], 1, [{ check_id: 'svc-telnet', device_id: 1, reason: null }]).checks;
    expect(cached[0].suppressed).toBe(true);
    const r = withCurrentUpdates(cached, { id: 1 }, []);
    expect(r.checks[0].suppressed).toBeUndefined();
    expect(r.score).toBe(85);
  });

  it('reads 100 with nothing counted, and never below 5', () => {
    expect(markAndScore([], 1, []).score).toBe(100);
    expect(markAndScore(Array(10).fill(telnet), 1, []).score).toBe(5);
  });
});
