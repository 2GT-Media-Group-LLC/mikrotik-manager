import type { BridgeVlanEntry } from '../types';

export type PortVlanMode = 'access' | 'trunk' | 'none';

/**
 * Which mode the port editor opens a bridge port in. Frame admission says it
 * outright: accepting only untagged frames is access, only tagged is trunk.
 * Tagged membership alone called a port a trunk after it was set to access,
 * because the VLANs it had been tagged on were still listed. With admit-all,
 * membership decides: tagged anywhere is a trunk, a PVID other than 1 access.
 */
export function portVlanMode(info: BridgeVlanEntry | null | undefined): PortVlanMode {
  const frames = info?.config_json?.['frame-types'];
  if (frames === 'admit-only-untagged-and-priority-tagged') return 'access';
  if (frames === 'admit-only-vlan-tagged') return 'trunk';
  if (info?.tagged) return 'trunk';
  return (info?.pvid ?? 1) > 1 ? 'access' : 'none';
}
