/**
 * One-click fixes for Config Health findings (#239).
 *
 * Only findings with one clearly right fix get a button: turning spanning tree
 * on, moving classic STP to RSTP, and tagging the bridge in the VLAN its VLAN
 * interface needs. The rest are judgment calls (which of two changes did you
 * mean?) or can't be changed remotely at all, so they keep their advice and
 * say why there's no button. Pure, so the decision can be tested without a
 * device.
 */

export interface FixPlan {
  /** What the fix does, for the confirmation. */
  summary: string;
  /** The RouterOS command it amounts to, shown before anything runs. */
  command: string;
}

const RSTP = (bridge: string): FixPlan => ({
  summary: `Turn on RSTP on bridge ${bridge}`,
  command: `/interface/bridge set ${bridge} protocol-mode=rstp`,
});

/** A plain RouterOS object name, so nothing odd ends up in a command. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The fix for a finding, or null when it has none. */
export function fixFor(rule: string, objects: string[]): FixPlan | null {
  switch (rule) {
    case 'stp-disabled':
    case 'stp-legacy-mode': {
      const bridge = objects[0];
      return bridge && SAFE_NAME.test(bridge) ? RSTP(bridge) : null;
    }
    case 'vlan-iface-not-tagged-on-bridge': {
      const [vlanIface, bridge, vidRaw] = objects;
      const vid = Number(vidRaw);
      if (!vlanIface || !bridge || !SAFE_NAME.test(bridge) || !Number.isInteger(vid) || vid < 1 || vid > 4094) return null;
      return {
        summary: `Tag bridge ${bridge} in VLAN ${vid}, so ${vlanIface} receives its traffic`,
        command: `/interface/bridge/vlan: add ${bridge} to the tagged ports of VLAN ${vid} on ${bridge} (creating the entry if there is none)`,
      };
    }
    default:
      return null;
  }
}

/** Why a finding has no button: shown in place of one. */
export const NO_FIX_REASON: Record<string, string> = {
  'ip-on-bridge-port': 'It depends on what you meant: move the address to the bridge, or take the port out of the bridge.',
  'vlan-iface-on-bridge-port': 'It depends on what you meant: put the VLAN interface on the bridge, or take the port out of the bridge.',
  'bridged-vlan-interface': 'It depends on how the VLAN should reach the bridge, and the wrong choice cuts it off.',
  'bond-slave-is-bridge-port': 'It depends on whether the port belongs in the bond or in the bridge.',
  'mtu-exceeds-l2mtu': 'Either the MTU comes down or the L2 MTU goes up; which is right depends on the network.',
  'multi-vid-untagged': 'Which VLAN the port should carry untagged is a choice only you can make.',
  'pvid-with-tagged-only-frame-type': 'Either the PVID or the frame types are wrong; which one depends on what the port is for.',
  'multiple-hw-bridges': 'Merging bridges, or moving ports between them, changes how traffic is switched.',
  'mgmt-vlan-dynamic-only': 'Making the management VLAN membership static touches the path the manager depends on; set it deliberately.',
  'port-in-no-vlan': 'Which VLAN the port belongs in is a choice only you can make.',
  'duplicate-address': 'Which device keeps the address is a choice only you can make.',
  'l3-hw-offload-off': 'Offloaded routing bypasses the firewall, so turning it on is a choice to make on the device\u2019s L3 offload card, with the firewall in mind.',
  'device-mode-flagged': 'Device-mode can only be changed at the device itself (a button press or power cycle).',
  'device-mode-no-scheduler': 'Device-mode can only be changed at the device itself (a button press or power cycle).',
  'device-mode-blocks-features': 'Device-mode can only be changed at the device itself (a button press or power cycle).',
};

export function noFixReason(rule: string): string {
  return NO_FIX_REASON[rule] ?? 'There is more than one reasonable fix, so it is left to you.';
}
