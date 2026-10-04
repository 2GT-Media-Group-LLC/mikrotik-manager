import { fixFor, noFixReason, NO_FIX_REASON } from '../configHealthFixes';

describe('Config Health fixes (#239)', () => {
  it('turns spanning tree on, or classic STP into RSTP', () => {
    expect(fixFor('stp-disabled', ['bridge1', 'ether1', 'ether2'])).toEqual({
      summary: 'Turn on RSTP on bridge bridge1', command: '/interface/bridge set bridge1 protocol-mode=rstp',
    });
    expect(fixFor('stp-legacy-mode', ['bridge'])?.command).toBe('/interface/bridge set bridge protocol-mode=rstp');
  });
  it('tags the bridge in the VLAN its VLAN interface needs', () => {
    const plan = fixFor('vlan-iface-not-tagged-on-bridge', ['vlan99', 'bridge1', '99']);
    expect(plan?.summary).toBe('Tag bridge bridge1 in VLAN 99, so vlan99 receives its traffic');
  });
  it('refuses odd names and VLAN ids', () => {
    expect(fixFor('stp-disabled', ['bridge1; /system reboot'])).toBeNull();
    expect(fixFor('stp-disabled', [])).toBeNull();
    expect(fixFor('vlan-iface-not-tagged-on-bridge', ['vlan99', 'bridge1', '5000'])).toBeNull();
    expect(fixFor('vlan-iface-not-tagged-on-bridge', ['vlan99', 'bridge1', 'x'])).toBeNull();
  });
  it('gives no button, and says why, for judgment calls and device-mode', () => {
    for (const rule of Object.keys(NO_FIX_REASON)) expect(fixFor(rule, ['a', 'b', '1'])).toBeNull();
    expect(noFixReason('device-mode-no-scheduler')).toMatch(/at the device itself/);
    expect(noFixReason('mtu-exceeds-l2mtu')).toMatch(/MTU/);
    expect(noFixReason('something-new')).toMatch(/more than one reasonable fix/);
  });
});
