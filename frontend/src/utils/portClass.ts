/**
 * Working out what a switch port actually is.
 *
 * Every classification in the faceplate used to be a test on the *display*
 * name: copper if it began with `ether`, a QSFP cage if it began with `qsfp`,
 * and SFP for everything else. Which meant a port renamed to something useful
 * stopped being what it is. Reported by a user who renamed a port to
 * `starlink1` and watched it move into the SFP group (#146).
 *
 * The display name is the one field guaranteed *not* to describe the hardware,
 * because it is the one field users are invited to change.
 *
 * Two things were checked on real devices before writing this rather than
 * assumed:
 *
 * **`type` cannot help.** RouterOS reports `type=ether` for every physical
 * port, whether it is the copper `ether1`, an `sfp28-*` cage or a `qsfp28`
 * breakout lane. Confirmed across a CRS510, a CCR2216, a CRS309 and a wAP ax.
 *
 * **`default-name` can.** RouterOS keeps the factory name alongside the current
 * one. Renaming `sfp-sfpplus8` on the test switch gave:
 *
 *     name=starlink1   default-name=sfp-sfpplus8
 *
 * so the hardware identity survives. It is present on `/interface/print detail`
 * for physical ports, which the collector already calls.
 *
 * Classification therefore keys on `default_name` and falls back to `name`.
 * The fallback is not a nicety: rows collected before this shipped have no
 * default name until the next slow poll, and falling back reproduces exactly
 * the old behaviour rather than mis-sorting everything for one poll cycle.
 */

export type PortKind =
  /** Copper ethernet — `ether1`. */
  | 'copper'
  /** A discrete SFP/SFP+/SFP28 cage — `sfp1`, `sfp-sfpplus3`, `sfp28-5`. */
  | 'sfp'
  /** One lane of a QSFP cage broken out — `qsfp28-1-3`. */
  | 'qsfp-lane'
  /** A whole QSFP cage presented as one port — `qsfp28-2`. */
  | 'qsfp'
  /** Not a physical port: bridge, bond, VLAN, loopback. */
  | 'virtual';

export interface PortIdentity {
  kind: PortKind;
  /** Which QSFP cage a lane belongs to, e.g. `qsfp28-1`. Null otherwise. */
  cageKey: string | null;
  /** Lane number within the cage, 1-based. Null otherwise. */
  lane: number | null;
  /** Short label for the tile: `5`, `S3`, `1/3`. */
  label: string;
  /** The name classification was based on — factory name where known. */
  basis: string;
}

export interface PortLike {
  name: string;
  default_name?: string | null;
  type?: string;
  /**
   * From /interface/ethernet/monitor. Null means not an SFP cage at all, which
   * is physical fact rather than a naming convention and therefore outranks the
   * factory name when deciding copper from fibre.
   */
  sfp_present?: boolean | null;
}

/** Interface types RouterOS uses for things that are not physical ports. */
const VIRTUAL_TYPES = new Set(['bridge', 'bond', 'vlan', 'loopback', 'vrrp', 'vpls', 'wg', 'veth']);

/**
 * The factory name if we have one, otherwise whatever it is called now.
 *
 * Exported because callers that sort or group need to agree with this exactly;
 * a second copy of the fallback rule is how the two drift apart.
 */
export function portBasis(port: PortLike): string {
  const def = (port.default_name || '').trim();
  return def || (port.name || '').trim();
}

/**
 * Short label for a port tile.
 *
 * Moved here from the faceplate unchanged, so the labels users already
 * recognise are preserved exactly. The only difference is what it is given:
 * the factory name rather than the display name, so a renamed port keeps the
 * label matching the silkscreen on the box.
 */
export function portLabel(basis: string): string {
  if (basis.startsWith('sfp-sfpplus')) return `P${basis.replace('sfp-sfpplus', '')}`;
  if (basis.startsWith('sfp')) return `S${basis.replace('sfp', '')}`;
  if (basis.startsWith('combo')) return `C${basis.replace('combo', '')}`;
  if (basis.startsWith('ether')) return basis.replace('ether', '');
  if (basis.startsWith('bridge')) return basis.replace('bridge', '') || 'BR';
  const bondMatch = basis.match(/^bond(\d*)$/i);
  if (bondMatch) return `B${bondMatch[1]}`;
  const lagMatch = basis.match(/^lag(\d*)$/i);
  if (lagMatch) return `L${lagMatch[1]}`;
  if (/^qsfp/i.test(basis) && !basis.match(/-\d+-\d+$/)) {
    return `Q${basis.match(/-(\d+)$/)?.[1] ?? ''}`;
  }
  return basis.slice(0, 4);
}

export function classifyPort(port: PortLike): PortIdentity {
  const basis = portBasis(port);
  const type = (port.type || '').toLowerCase();

  // Type is authoritative for the virtual cases — a bridge is a bridge whatever
  // it is called — and useless for telling physical ports apart.
  if (VIRTUAL_TYPES.has(type)) {
    return { kind: 'virtual', cageKey: null, lane: null, label: portLabel(port.name), basis };
  }

  // Where the device has told us whether the port is a cage, believe it over
  // any naming convention: RouterOS reports sfp-module-present only on ports
  // that physically have a cage. QSFP naming still decides lane grouping, since
  // monitor says nothing about which cage a lane belongs to.
  if (port.sfp_present !== undefined && port.sfp_present !== null && !/^qsfp/i.test(basis)) {
    return { kind: 'sfp', cageKey: null, lane: null, label: portLabel(basis), basis };
  }

  // Breakout lane: qsfp28-1-3, qsfp-4-2. The cage index and the lane index are
  // the last two numeric groups.
  const laneMatch = /^(qsfp[^-]*(?:-[^-\d][^-]*)*-(\d+))-(\d+)$/i.exec(basis);
  if (laneMatch) {
    return {
      kind: 'qsfp-lane',
      cageKey: laneMatch[1],
      lane: Number(laneMatch[3]),
      label: `${laneMatch[2]}/${laneMatch[3]}`,
      basis,
    };
  }

  if (/^qsfp/i.test(basis)) {
    return { kind: 'qsfp', cageKey: basis, lane: null, label: portLabel(basis), basis };
  }

  // Every SFP variant: sfp1, sfp-sfpplus3, sfp28-5, sfpplus2.
  if (/^sfp/i.test(basis)) {
    return { kind: 'sfp', cageKey: null, lane: null, label: portLabel(basis), basis };
  }

  if (/^ether/i.test(basis)) {
    return { kind: 'copper', cageKey: null, lane: null, label: portLabel(basis), basis };
  }

  // An unrecognised physical port. Treated as copper rather than swept into the
  // SFP group, which is what the old "everything that is not ether" rule did.
  // Showing it in the wrong group is worse than showing it plainly.
  return { kind: 'copper', cageKey: null, lane: null, label: portLabel(basis), basis };
}

/** Display order: copper, then SFP, then QSFP, then virtual — numeric within each. */
export function portSortKey(port: PortLike): [number, number, string] {
  const id = classifyPort(port);
  const rank: Record<PortKind, number> = {
    copper: 0, sfp: 1, 'qsfp-lane': 2, qsfp: 2, virtual: 3,
  };
  const digits = /(\d+)(?:-(\d+))?$/.exec(id.basis);
  const major = digits ? Number(digits[1]) : 0;
  return [rank[id.kind], major, id.basis];
}
