/**
 * L3 hardware offloading on Marvell 98DX switch chips (#254): what the
 * device-page card shows. Pure, so it can be tested without a device.
 */
import { isL3HwChip } from '../services/changeGuard/configHealth';

type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export interface L3HwView {
  supported: boolean;
  switch: { id: string; name: string; type: string } | null;
  enabled: boolean;
  /** Ports with offloading turned off individually; they still take part in FastTrack offload. */
  portsOff: string[];
  ipv6: boolean;
  fasttrackHw: boolean | null;
  /** From l3hw-settings monitor while running. */
  routesHw: number | null;
  routesCpu: number | null;
  /** Hosts the chip forwards to directly: the clients actually being routed. */
  hostsHw: number | null;
  /** VLAN interfaces with addresses: what this device routes between. */
  routedVlans: string[];
  /** Rules that stop applying to routed traffic once it's offloaded. */
  forwardRules: number;
  natRules: number;
  /**
   * Routed VLANs whose bridge can't be offloaded (VLAN filtering off): their
   * routes stay on the CPU whatever the switch setting (#254).
   */
  notOffloadable: { vlan: string; bridge: string }[];
}

export function l3hwView(
  switches: Row[], ports: Row[], settings: Row | undefined, monitor: Row | undefined,
  vlanInterfaces: Row[], addresses: Row[], filter: Row[], nat: Row[], bridges: Row[] = [],
): L3HwView {
  const chip = switches.find((s) => isL3HwChip(s['type'])) ?? null;
  const vlanNames = new Set(vlanInterfaces.filter((v) => !isTrue(v['disabled'])).map((v) => v['name']));
  const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));
  return {
    supported: !!chip,
    switch: chip ? { id: chip['.id'], name: chip['name'] || 'switch1', type: chip['type'] } : null,
    enabled: !!chip && isTrue(chip['l3-hw-offloading']),
    portsOff: chip ? ports.filter((p) => p['switch'] === chip['name'] && p['l3-hw-offloading'] === 'false').map((p) => p['name']) : [],
    ipv6: isTrue(settings?.['ipv6-hw']),
    fasttrackHw: settings?.['hw-supports-fasttrack'] === undefined ? null : isTrue(settings['fasttrack-hw']) && isTrue(settings['hw-supports-fasttrack']),
    routesHw: num(monitor?.['ipv4-routes-hw']),
    routesCpu: num(monitor?.['ipv4-routes-cpu']),
    hostsHw: num(monitor?.['ipv4-hosts']),
    routedVlans: [...new Set(addresses.filter((a) => !isTrue(a['disabled']) && vlanNames.has(a['interface'])).map((a) => a['interface']))].sort(),
    forwardRules: filter.filter((r) => r['chain'] === 'forward' && !isTrue(r['disabled'])).length,
    natRules: nat.filter((r) => !isTrue(r['disabled'])).length,
    notOffloadable: [...new Set(addresses.filter((a) => !isTrue(a['disabled']) && vlanNames.has(a['interface'])).map((a) => a['interface']))]
      .map((vlan) => ({ vlan, bridge: vlanInterfaces.find((v) => v['name'] === vlan)?.['interface'] ?? '' }))
      .filter(({ bridge }) => {
        const b = bridges.find((x) => x['name'] === bridge);
        return !b || !isTrue(b['vlan-filtering']);
      })
      .sort((a, b) => a.vlan.localeCompare(b.vlan)),
  };
}
